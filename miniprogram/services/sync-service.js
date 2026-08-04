const {
  ENTITY_TYPES,
  createConflictState,
  mapRemoteChange,
  rebaseSettingsChange
} = require('../domain/sync/entity-mapper');
const {
  applyAcceptedOperations,
  assertSyncOperation,
  assertSyncReplica,
  entityKey,
  selectPushableOperations
} = require('../domain/sync/sync-operation');
const {
  assertBootstrapResult,
  assertPurgeResult,
  assertPushResult,
  assertPullResult,
  assertRemoteSyncProvider
} = require('./remote-sync-provider');
const { DEFAULT_USER_SETTINGS } = require('../utils/constants');

function syncServiceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
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
        'SYNC_PUSH_RESPONSE_UNBOUND'
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
  constructor({ database, provider, now = Date.now }) {
    assertDatabase(database);
    assertRemoteSyncProvider(provider);
    if (typeof now !== 'function') {
      throw syncServiceError('SyncService now must be a function', 'SYNC_SERVICE_INVALID');
    }
    this.database = database;
    this.provider = provider;
    this.now = now;
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
    const response = await this.provider.purge({ confirmationToken });
    assertPurgeResult(response);
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
