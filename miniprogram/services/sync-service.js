const {
  ENTITY_TYPES,
  createConflictState,
  mapRemoteChange,
  rebaseSettingsChange
} = require('../domain/sync/entity-mapper');
const {
  appendRepositorySyncMutation,
  applyAcceptedOperations,
  assertSyncOperation,
  assertSyncReplica,
  createRepositoryDeviceIdFactory,
  entityKey,
  selectPushableOperations
} = require('../domain/sync/sync-operation');
const {
  assertBootstrapResult,
  assertPurgePreparationResult,
  assertPurgeResult,
  assertPushResult,
  assertPullResult,
  assertRemoteSyncProvider
} = require('./remote-sync-provider');
const { DEFAULT_USER_SETTINGS } = require('../utils/constants');
const { computeChecksum } = require('../utils/checksum');

function syncServiceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

const STATUS_LABELS = Object.freeze({
  disabled: '未启用',
  synced: '已同步',
  waiting: '等待同步',
  syncing: '同步中',
  conflict: '冲突',
  failure: '失败可重试'
});

function safeErrorCode(error) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'CLOUD_SYNC_UNAVAILABLE';
}

function conflictActions(conflict) {
  if (conflict.entityType === ENTITY_TYPES.USER_SETTINGS) {
    return ['keep_remote', 'rebase'];
  }
  return ['keep_remote', 'keep_local_as_copy', 'rebase'];
}

function conflictSummary(conflict, side) {
  const source = side === 'local' ? conflict.local : conflict.remote;
  const payload = source && source.payload;
  const prefix = side === 'local' ? '本机' : '云端';
  if (!payload) return `${prefix}：已删除`;
  if (conflict.entityType === ENTITY_TYPES.WORKOUT_PLAN) {
    return `${prefix}：${payload.title || '未命名计划'} · ${payload.trainingDate || '日期未知'}`;
  }
  if (conflict.entityType === ENTITY_TYPES.TRAINING_RECORD) {
    return `${prefix}：${payload.trainingDate || '日期未知'} · ${payload.status || '状态未知'}`;
  }
  const fields = Object.keys(payload)
    .filter((field) => !['schemaVersion', 'revision'].includes(field))
    .sort();
  return `${prefix}：${fields.length > 0 ? fields.join('、') : '设置'}`;
}

function assertDatabase(database) {
  if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
    throw syncServiceError('SyncService requires a LocalDatabase', 'SYNC_SERVICE_INVALID');
  }
}

function findOperation(outbox, opId) {
  const operation = outbox.find((candidate) => candidate && candidate.opId === opId) || null;
  if (operation) assertSyncOperation(operation);
  return operation;
}

function pendingOperationFor(outbox, change) {
  for (const candidate of outbox) {
    try {
      assertSyncOperation(candidate);
      if (candidate.entityType === change.entityType && candidate.entityId === change.entityId) {
        return candidate;
      }
    } catch (_error) {
      // Legacy descriptors remain quarantined and are not interpreted as complete local work.
    }
  }
  return null;
}

function replicaFor(change) {
  return {
    entityType: change.entityType,
    entityId: change.entityId,
    serverRevision: change.serverRevision,
    payloadHash: change.payloadHash,
    deleted: change.action === 'delete'
  };
}

function addConflict(draft, conflict) {
  if (!draft.sync.conflicts.some(({ conflictId }) => conflictId === conflict.conflictId)) {
    draft.sync.conflicts.push(conflict);
  }
}

function assertPushResponseBoundToAttempt(response, attemptedOperations) {
  const attemptedOpIds = new Set(attemptedOperations.map(({ opId }) => opId));
  for (const classification of [
    ...response.accepted,
    ...response.rejected,
    ...response.conflicts
  ]) {
    if (!attemptedOpIds.has(classification.opId)) {
      throw syncServiceError(
        'push response classified an operation outside the attempted request',
        'SYNC_PUSH_UNATTEMPTED_RECEIPT'
      );
    }
  }
}

function applyRemoteDomainChange(draft, change) {
  if (change.entityType === ENTITY_TYPES.WORKOUT_PLAN) {
    const index = draft.plans.findIndex(({ id }) => id === change.entityId);
    if (change.action === 'upsert') {
      if (index === -1) draft.plans.push(cloneJson(change.payload));
      else draft.plans[index] = cloneJson(change.payload);
      return;
    }
    if (index !== -1 && draft.plans[index].status !== 'deleted') {
      const current = draft.plans[index];
      draft.plans[index] = {
        ...cloneJson(current),
        status: 'deleted',
        updatedAt: change.deletedAt,
        deletedAt: change.deletedAt,
        revision: current.revision + 1
      };
    }
    return;
  }

  if (change.entityType === ENTITY_TYPES.TRAINING_RECORD) {
    const index = draft.records.findIndex(({ id }) => id === change.entityId);
    if (change.action === 'upsert') {
      if (index === -1) draft.records.push(cloneJson(change.payload));
      else draft.records[index] = cloneJson(change.payload);
    } else if (index !== -1) {
      draft.records.splice(index, 1);
    }
    draft.statisticsProjection = {
      dirty: true,
      reason: 'training-record-changed',
      recordId: change.entityId,
      recordRevision: change.payload && change.payload.revision ? change.payload.revision : 0,
      invalidatedAt: change.deletedAt === null ? change.payload.updatedAt : change.deletedAt
    };
    return;
  }

  if (change.action === 'upsert') {
    draft.settings = cloneJson(change.payload);
  } else {
    draft.settings = {
      ...DEFAULT_USER_SETTINGS,
      revision: draft.settings.revision + 1
    };
  }
}

class SyncService {
  constructor({
    database,
    provider,
    now = Date.now,
    deviceIdFactory = createRepositoryDeviceIdFactory()
  }) {
    assertDatabase(database);
    assertRemoteSyncProvider(provider);
    if (typeof now !== 'function') {
      throw syncServiceError('SyncService now must be a function', 'SYNC_SERVICE_INVALID');
    }
    if (typeof deviceIdFactory !== 'function') {
      throw syncServiceError('SyncService deviceIdFactory must be a function', 'SYNC_SERVICE_INVALID');
    }
    this.database = database;
    this.provider = provider;
    this.now = now;
    this.deviceIdFactory = deviceIdFactory;
  }

  getSanitizedState({ phase = 'idle' } = {}) {
    if (!['idle', 'syncing'].includes(phase)) {
      throw syncServiceError('sync state phase is invalid', 'SYNC_STATE_INVALID');
    }
    const snapshot = this.database.load();
    const enabled = Boolean(snapshot.sync.enabled && snapshot.settings.cloudSyncEnabled);
    const conflicts = snapshot.sync.conflicts.filter(({ status }) => status !== 'resolved');
    const pendingCount = snapshot.sync.outbox.length;
    const storedError = snapshot.sync.lastError;
    const errorCode = storedError && typeof storedError === 'object'
      ? storedError.code
      : typeof storedError === 'string'
        ? storedError
        : null;
    let code = 'waiting';
    if (!enabled) code = 'disabled';
    else if (phase === 'syncing') code = 'syncing';
    else if (conflicts.length > 0) code = 'conflict';
    else if (errorCode) code = 'failure';
    else if (pendingCount > 0 || snapshot.sync.lastSyncedAt === null) code = 'waiting';
    else code = 'synced';
    return {
      code,
      label: code === 'waiting' ? `等待 ${pendingCount} 项` : STATUS_LABELS[code],
      enabled,
      pendingCount,
      lastSyncedAt: snapshot.sync.lastSyncedAt,
      errorCode: errorCode || null,
      conflicts: conflicts.map((conflict) => ({
        conflictId: conflict.conflictId,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        status: conflict.status,
        localSummary: conflictSummary(conflict, 'local'),
        remoteSummary: conflictSummary(conflict, 'remote'),
        actions: conflictActions(conflict)
      }))
    };
  }

  resolveConflict({ conflictId, action }) {
    if (
      typeof conflictId !== 'string' || conflictId.length === 0 ||
      !['keep_remote', 'keep_local_as_copy', 'rebase'].includes(action)
    ) {
      throw syncServiceError('conflict resolution command is invalid', 'SYNC_CONFLICT_RESOLUTION_INVALID');
    }
    const resolvedAt = this.now();
    if (!Number.isSafeInteger(resolvedAt) || resolvedAt < 0) {
      throw syncServiceError('SyncService now must return a non-negative safe integer', 'SYNC_CLOCK_INVALID');
    }
    let receipt;
    this.database.commit((draft) => {
      const conflict = draft.sync.conflicts.find((candidate) => candidate.conflictId === conflictId);
      if (!conflict || conflict.status === 'resolved') {
        throw syncServiceError('sync conflict is missing or resolved', 'SYNC_CONFLICT_NOT_FOUND');
      }
      const allowedActions = conflictActions(conflict);
      if (!allowedActions.includes(action)) {
        throw syncServiceError('resolution is not available for this entity', 'SYNC_CONFLICT_ACTION_UNAVAILABLE');
      }
      const remote = conflict.remote;
      const key = entityKey(conflict.entityType, conflict.entityId);
      let copyEntityId = null;

      if (action === 'rebase') {
        const operation = findOperation(draft.sync.outbox, conflict.local.opId);
        if (!operation) {
          throw syncServiceError('conflict operation is missing', 'SYNC_CONFLICT_OPERATION_MISSING');
        }
        operation.baseServerRevision = remote.serverRevision;
        assertSyncOperation(operation);
      } else {
        draft.sync.outbox = draft.sync.outbox.filter((operation) => (
          !operation || operation.entityType !== conflict.entityType || operation.entityId !== conflict.entityId
        ));
        applyRemoteDomainChange(draft, remote);
      }

      if (action === 'keep_local_as_copy') {
        if (conflict.entityType !== ENTITY_TYPES.WORKOUT_PLAN || !conflict.local.payload) {
          throw syncServiceError('local copy is unavailable for this conflict', 'SYNC_CONFLICT_ACTION_UNAVAILABLE');
        }
        copyEntityId = `plan_copy_${computeChecksum({ conflictId, resolvedAt }).slice(0, 24)}`;
        const copy = {
          ...cloneJson(conflict.local.payload),
          id: copyEntityId,
          title: `${conflict.local.payload.title}（本机副本）`,
          templateSource: null,
          updatedAt: resolvedAt,
          revision: conflict.local.payload.revision + 1
        };
        draft.plans.push(copy);
        appendRepositorySyncMutation(draft, {
          entityType: ENTITY_TYPES.WORKOUT_PLAN,
          entityId: copyEntityId,
          action: 'upsert',
          payload: copy
        }, {
          commandIdentity: `conflict.copy:${conflictId}`,
          createdAt: resolvedAt,
          deviceId: draft.install.deviceId
        });
      }

      draft.sync.replicas[key] = replicaFor(remote);
      assertSyncReplica(draft.sync.replicas[key]);
      conflict.status = 'resolved';
      conflict.resolution = { action, resolvedAt, copyEntityId };
      draft.sync.lastError = null;
      receipt = { conflictId, action, resolvedAt, copyEntityId };
    });
    return cloneJson(receipt);
  }

  previewEnable() {
    const snapshot = this.database.load();
    return {
      baselineLocalRevision: snapshot.localRevision,
      scope: {
        plans: snapshot.plans.filter(({ status }) => status !== 'deleted').length,
        records: snapshot.records.length,
        settings: 1,
        pendingOperations: snapshot.sync.outbox.length
      }
    };
  }

  setEnabled({ enabled, expectedLocalRevision }) {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedLocalRevision) || expectedLocalRevision < 0) {
      throw syncServiceError('cloud sync preference command is invalid', 'SYNC_PREFERENCE_INVALID');
    }
    const changedAt = this.now();
    if (!Number.isSafeInteger(changedAt) || changedAt < 0) {
      throw syncServiceError('SyncService now must return a non-negative safe integer', 'SYNC_CLOCK_INVALID');
    }
    return this.database.commit((draft) => {
      const current = draft.settings.cloudSyncEnabled;
      if (current !== enabled) {
        const expectedSettingsRevision = draft.settings.revision;
        draft.settings = {
          ...draft.settings,
          cloudSyncEnabled: enabled,
          revision: expectedSettingsRevision + 1
        };
        appendRepositorySyncMutation(draft, {
          entityType: ENTITY_TYPES.USER_SETTINGS,
          entityId: 'settings',
          action: 'upsert',
          payload: { cloudSyncEnabled: enabled }
        }, {
          commandIdentity: `sync.preference:${expectedSettingsRevision}`,
          createdAt: changedAt,
          deviceId: draft.install ? draft.install.deviceId : null,
          deviceIdFactory: this.deviceIdFactory
        });
      }
      draft.sync.enabled = enabled;
      draft.sync.provider = enabled ? 'cloudbase' : 'none';
      if (!enabled) draft.sync.lastError = null;
    }, expectedLocalRevision);
  }

  recordFailure(error) {
    const failedAt = this.now();
    if (!Number.isSafeInteger(failedAt) || failedAt < 0) {
      throw syncServiceError('SyncService now must return a non-negative safe integer', 'SYNC_CLOCK_INVALID');
    }
    const code = safeErrorCode(error);
    this.database.commit((draft) => {
      draft.sync.lastError = { code, failedAt };
    });
    return this.getSanitizedState();
  }

  async bootstrap() {
    const snapshot = this.database.load();
    if (
      !snapshot.install ||
      typeof snapshot.install.deviceId !== 'string' ||
      snapshot.install.deviceId.length === 0
    ) {
      throw syncServiceError('sync bootstrap requires an install deviceId', 'SYNC_DEVICE_ID_REQUIRED');
    }
    const response = await this.provider.bootstrap({ deviceId: snapshot.install.deviceId });
    assertBootstrapResult(response);
    return cloneJson(response);
  }

  async purgeRemote({ confirmationToken } = {}) {
    const snapshot = this.database.load();
    if (
      !snapshot.install ||
      typeof snapshot.install.deviceId !== 'string' ||
      snapshot.install.deviceId.length === 0
    ) {
      throw syncServiceError('remote purge requires an install deviceId', 'SYNC_DEVICE_ID_REQUIRED');
    }
    const response = await this.provider.purge({
      deviceId: snapshot.install.deviceId,
      confirmationToken
    });
    assertPurgeResult(response);
    return cloneJson(response);
  }

  async prepareRemotePurge() {
    const snapshot = this.database.load();
    if (
      !snapshot.install ||
      typeof snapshot.install.deviceId !== 'string' ||
      snapshot.install.deviceId.length === 0
    ) {
      throw syncServiceError('remote purge requires an install deviceId', 'SYNC_DEVICE_ID_REQUIRED');
    }
    const response = await this.provider.preparePurge({ deviceId: snapshot.install.deviceId });
    assertPurgePreparationResult(response);
    return cloneJson(response);
  }

  async pushPending() {
    const snapshot = this.database.load();
    const selection = selectPushableOperations(snapshot.sync.outbox);
    if (selection.operations.length === 0) {
      return {
        attemptedOpIds: [],
        acceptedOpIds: [],
        unknownAcceptedOpIds: [],
        rejected: [],
        conflicts: [],
        unsupported: selection.unsupported
      };
    }

    const attemptedAt = this.now();
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt < 0) {
      throw syncServiceError('SyncService now must return a non-negative safe integer', 'SYNC_CLOCK_INVALID');
    }
    const selectedOpIds = new Set(selection.operations.map(({ opId }) => opId));
    const attemptedSnapshot = this.database.commit((draft) => {
      for (const operation of draft.sync.outbox) {
        if (!selectedOpIds.has(operation && operation.opId)) continue;
        assertSyncOperation(operation);
        if (attemptedAt < operation.createdAt) {
          throw syncServiceError('push attempt cannot predate operation creation', 'SYNC_CLOCK_INVALID');
        }
        operation.attemptCount += 1;
        operation.lastAttemptAt = attemptedAt;
        assertSyncOperation(operation);
      }
    }, snapshot.localRevision);
    const attemptedOperations = selection.operations.map(({ opId }) => {
      const operation = findOperation(attemptedSnapshot.sync.outbox, opId);
      if (!operation) {
        throw syncServiceError('selected push operation disappeared before provider call', 'SYNC_PUSH_RACE');
      }
      return cloneJson(operation);
    });

    const response = await this.provider.push({ operations: attemptedOperations });
    assertPushResult(response);
    assertPushResponseBoundToAttempt(response, attemptedOperations);

    const responseSnapshot = this.database.load();
    let accepted;
    this.database.commit((draft) => {
      accepted = applyAcceptedOperations(draft, response.accepted);
      for (const classification of response.conflicts) {
        const operation = findOperation(draft.sync.outbox, classification.opId);
        if (!operation) continue;
        const remoteChange = mapRemoteChange(classification.remote);
        if (
          operation.entityType === ENTITY_TYPES.USER_SETTINGS &&
          operation.action === 'upsert' &&
          remoteChange.action === 'upsert'
        ) {
          const rebased = rebaseSettingsChange({
            localSettings: draft.settings,
            localOperation: operation,
            remoteChange,
            detectedAt: attemptedAt
          });
          draft.settings = rebased.settings;
          const operationIndex = draft.sync.outbox.indexOf(operation);
          draft.sync.outbox[operationIndex] = rebased.operation;
          assertSyncOperation(draft.sync.outbox[operationIndex]);
          addConflict(draft, rebased.conflict);
          const key = entityKey(remoteChange.entityType, remoteChange.entityId);
          draft.sync.replicas[key] = replicaFor(remoteChange);
          assertSyncReplica(draft.sync.replicas[key]);
        } else {
          addConflict(draft, createConflictState({
            localOperation: operation,
            remoteChange,
            localEntity: operation.payload,
            detectedAt: attemptedAt
          }));
        }
      }
      draft.sync.lastSyncedAt = attemptedAt;
      draft.sync.lastError = null;
    }, responseSnapshot.localRevision);

    return {
      attemptedOpIds: attemptedOperations.map(({ opId }) => opId),
      acceptedOpIds: accepted.acceptedOpIds,
      unknownAcceptedOpIds: accepted.unknownOpIds,
      rejected: cloneJson(response.rejected),
      conflicts: cloneJson(response.conflicts),
      unsupported: selection.unsupported
    };
  }

  async pullNextPage({ limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw syncServiceError('pull limit must be an integer from 1 to 100', 'SYNC_PULL_LIMIT_INVALID');
    }
    const snapshot = this.database.load();
    const response = await this.provider.pull({ cursor: snapshot.sync.cursor, limit });
    assertPullResult(response);
    const changes = response.changes.map(mapRemoteChange);
    const keys = new Set();
    let replayed = 0;
    for (const change of changes) {
      const key = entityKey(change.entityType, change.entityId);
      if (keys.has(key)) {
        throw syncServiceError('pull page contains duplicate entity changes', 'SYNC_PULL_DUPLICATE_ENTITY');
      }
      keys.add(key);
      const replica = snapshot.sync.replicas[key] || null;
      if (!replica) continue;
      if (change.serverRevision < replica.serverRevision) {
        throw syncServiceError('pull change serverRevision is stale', 'SYNC_PULL_REVISION_STALE');
      }
      if (change.serverRevision === replica.serverRevision) {
        if (
          replica.payloadHash !== change.payloadHash ||
          replica.deleted !== (change.action === 'delete')
        ) {
          throw syncServiceError(
            'pull change reuses a serverRevision for different facts',
            'SYNC_PULL_REVISION_COLLISION'
          );
        }
        replayed += 1;
      }
    }

    if (replayed === changes.length && response.nextCursor === snapshot.sync.cursor) {
      return {
        applied: 0,
        replayed,
        nextCursor: snapshot.sync.cursor,
        hasMore: response.hasMore
      };
    }

    const pulledAt = this.now();
    if (!Number.isSafeInteger(pulledAt) || pulledAt < 0) {
      throw syncServiceError('SyncService now must return a non-negative safe integer', 'SYNC_CLOCK_INVALID');
    }
    let applied = 0;
    this.database.commit((draft) => {
      for (const change of changes) {
        const key = entityKey(change.entityType, change.entityId);
        const currentReplica = draft.sync.replicas[key] || null;
        if (
          currentReplica &&
          currentReplica.serverRevision === change.serverRevision &&
          currentReplica.payloadHash === change.payloadHash &&
          currentReplica.deleted === (change.action === 'delete')
        ) {
          continue;
        }

        const localOperation = pendingOperationFor(draft.sync.outbox, change);
        if (
          localOperation &&
          change.entityType === ENTITY_TYPES.USER_SETTINGS &&
          localOperation.action === 'upsert' &&
          change.action === 'upsert'
        ) {
          const rebased = rebaseSettingsChange({
            localSettings: draft.settings,
            localOperation,
            remoteChange: change,
            detectedAt: pulledAt
          });
          draft.settings = rebased.settings;
          const operationIndex = draft.sync.outbox.indexOf(localOperation);
          draft.sync.outbox[operationIndex] = rebased.operation;
          addConflict(draft, rebased.conflict);
        } else if (localOperation) {
          addConflict(draft, createConflictState({
            localOperation,
            remoteChange: change,
            localEntity: localOperation.payload,
            detectedAt: pulledAt
          }));
        } else {
          applyRemoteDomainChange(draft, change);
        }
        draft.sync.replicas[key] = replicaFor(change);
        assertSyncReplica(draft.sync.replicas[key]);
        applied += 1;
      }
      draft.sync.cursor = response.nextCursor;
      draft.sync.lastSyncedAt = pulledAt;
      draft.sync.lastError = null;
    }, snapshot.localRevision);

    return {
      applied,
      replayed,
      nextCursor: response.nextCursor,
      hasMore: response.hasMore
    };
  }
}

function createSyncService(options) {
  return new SyncService(options);
}

module.exports = { SyncService, createSyncService };
