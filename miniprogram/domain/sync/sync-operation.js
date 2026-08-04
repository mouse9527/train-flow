const { computeChecksum } = require('../../utils/checksum');
const { ENTITY_TYPES, mapLocalMutation } = require('./entity-mapper');

const OPERATION_FIELDS = Object.freeze([
  'opId',
  'deviceId',
  'entityType',
  'entityId',
  'action',
  'baseServerRevision',
  'payload',
  'createdAt',
  'attemptCount',
  'lastAttemptAt'
]);
const REPLICA_FIELDS = Object.freeze([
  'entityType',
  'entityId',
  'serverRevision',
  'payloadHash',
  'deleted'
]);
const RECEIPT_FIELDS = Object.freeze([
  'opId',
  'entityType',
  'entityId',
  'serverRevision'
]);
const LEGACY_ENTITY_ALIASES = Object.freeze({
  'training-record': ENTITY_TYPES.TRAINING_RECORD,
  'workout-plan': ENTITY_TYPES.WORKOUT_PLAN,
  settings: ENTITY_TYPES.USER_SETTINGS
});

function operationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function hasExactFields(value, fields) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => hasOwn(value, field))
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNonNegativeSafeInteger(value, label, code = 'SYNC_OPERATION_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw operationError(`${label} must be a non-negative safe integer`, code);
  }
}

function assertSyncOperation(operation) {
  const looksLegacy = Boolean(
    operation &&
    typeof operation === 'object' &&
    (hasOwn(operation, 'kind') || hasOwn(operation, 'entityRevision') || hasOwn(operation, 'occurredAt'))
  );
  if (!hasExactFields(operation, OPERATION_FIELDS)) {
    throw operationError(
      looksLegacy
        ? 'legacy descriptor-only outbox entry is unsupported'
        : 'SyncOperation must use the closed V1 schema',
      looksLegacy ? 'SYNC_OPERATION_UNSUPPORTED' : 'SYNC_OPERATION_INVALID'
    );
  }
  if (typeof operation.opId !== 'string' || !/^op_[a-f0-9]{64}$/.test(operation.opId)) {
    throw operationError('SyncOperation opId is invalid', 'SYNC_OPERATION_INVALID');
  }
  if (typeof operation.deviceId !== 'string' || operation.deviceId.length === 0) {
    throw operationError('SyncOperation deviceId is invalid', 'SYNC_OPERATION_INVALID');
  }
  assertNonNegativeSafeInteger(operation.baseServerRevision, 'SyncOperation baseServerRevision');
  assertNonNegativeSafeInteger(operation.createdAt, 'SyncOperation createdAt');
  assertNonNegativeSafeInteger(operation.attemptCount, 'SyncOperation attemptCount');
  if (
    operation.lastAttemptAt !== null &&
    (!Number.isSafeInteger(operation.lastAttemptAt) || operation.lastAttemptAt < operation.createdAt)
  ) {
    throw operationError('SyncOperation lastAttemptAt is invalid', 'SYNC_OPERATION_INVALID');
  }
  const normalized = mapLocalMutation({
    entityType: operation.entityType,
    entityId: operation.entityId,
    action: operation.action,
    payload: operation.payload
  });
  if (JSON.stringify(normalized.payload) !== JSON.stringify(operation.payload)) {
    throw operationError('SyncOperation payload is not canonical', 'SYNC_OPERATION_INVALID');
  }
  return operation;
}

function entityKey(entityType, entityId) {
  if (typeof entityType !== 'string' || entityType.length === 0) {
    throw operationError('entityType must be a non-empty string', 'SYNC_ENTITY_KEY_INVALID');
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw operationError('entityId must be a non-empty string', 'SYNC_ENTITY_KEY_INVALID');
  }
  return JSON.stringify([entityType, entityId]);
}

function assertSyncReplica(replica) {
  if (!hasExactFields(replica, REPLICA_FIELDS)) {
    throw operationError('SyncReplica entry must use the closed V1 schema', 'SYNC_REPLICA_INVALID');
  }
  const expectedKey = entityKey(replica.entityType, replica.entityId);
  if (!Object.values(ENTITY_TYPES).includes(replica.entityType)) {
    throw operationError(`unsupported replica entity ${expectedKey}`, 'SYNC_REPLICA_INVALID');
  }
  if (!Number.isSafeInteger(replica.serverRevision) || replica.serverRevision < 1) {
    throw operationError('SyncReplica serverRevision must be positive', 'SYNC_REPLICA_INVALID');
  }
  if (typeof replica.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(replica.payloadHash)) {
    throw operationError('SyncReplica payloadHash is invalid', 'SYNC_REPLICA_INVALID');
  }
  if (typeof replica.deleted !== 'boolean') {
    throw operationError('SyncReplica deleted must be boolean', 'SYNC_REPLICA_INVALID');
  }
  return replica;
}

function ensureSyncState(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw operationError('AppDatabase draft is required', 'SYNC_STATE_INVALID');
  }
  if (!draft.sync || typeof draft.sync !== 'object' || Array.isArray(draft.sync)) {
    throw operationError('AppDatabase sync state is invalid', 'SYNC_STATE_INVALID');
  }
  if (!Array.isArray(draft.sync.outbox) || !Array.isArray(draft.sync.conflicts)) {
    throw operationError('AppDatabase sync queues are invalid', 'SYNC_STATE_INVALID');
  }
  if (!hasOwn(draft.sync, 'replicas')) {
    draft.sync.replicas = {};
  }
  if (
    !draft.sync.replicas ||
    typeof draft.sync.replicas !== 'object' ||
    Array.isArray(draft.sync.replicas) ||
    Object.getPrototypeOf(draft.sync.replicas) !== Object.prototype
  ) {
    throw operationError('AppDatabase sync replicas are invalid', 'SYNC_STATE_INVALID');
  }
  for (const [key, replica] of Object.entries(draft.sync.replicas)) {
    assertSyncReplica(replica);
    if (key !== entityKey(replica.entityType, replica.entityId)) {
      throw operationError('SyncReplica map key does not match identity', 'SYNC_REPLICA_INVALID');
    }
  }
}

function ensureInstall(draft, { createdAt, deviceIdFactory, mutation }) {
  if (draft.install !== null) {
    if (
      !draft.install ||
      typeof draft.install.deviceId !== 'string' ||
      draft.install.deviceId.length === 0
    ) {
      throw operationError('AppDatabase install identity is invalid', 'SYNC_DEVICE_ID_INVALID');
    }
    return draft.install.deviceId;
  }
  if (typeof deviceIdFactory !== 'function') {
    throw operationError('deviceIdFactory is required before install identity exists', 'SYNC_DEVICE_ID_REQUIRED');
  }
  const deviceId = deviceIdFactory({
    createdAt,
    localRevision: draft.localRevision,
    entityType: mutation.entityType,
    entityId: mutation.entityId
  });
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw operationError('deviceIdFactory returned an invalid identity', 'SYNC_DEVICE_ID_INVALID');
  }
  draft.install = { deviceId, createdAt };
  return deviceId;
}

function appendSyncOperation(draft, sourceMutation, {
  createdAt,
  intentKey,
  deviceIdFactory
} = {}) {
  ensureSyncState(draft);
  assertNonNegativeSafeInteger(createdAt, 'SyncOperation createdAt');
  if (typeof intentKey !== 'string' || intentKey.length === 0) {
    throw operationError('SyncOperation intentKey must be a non-empty string', 'SYNC_INTENT_KEY_INVALID');
  }
  const mutation = mapLocalMutation(sourceMutation);
  const deviceId = ensureInstall(draft, { createdAt, deviceIdFactory, mutation });
  const replica = draft.sync.replicas[entityKey(mutation.entityType, mutation.entityId)] || null;
  const baseServerRevision = replica ? replica.serverRevision : 0;
  const opId = `op_${computeChecksum({
    deviceId,
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    action: mutation.action,
    baseServerRevision,
    payload: mutation.payload,
    createdAt,
    intentKey
  })}`;
  const operation = {
    opId,
    deviceId,
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    action: mutation.action,
    baseServerRevision,
    payload: mutation.payload,
    createdAt,
    attemptCount: 0,
    lastAttemptAt: null
  };
  assertSyncOperation(operation);

  const existing = draft.sync.outbox.find((candidate) => candidate && candidate.opId === opId);
  if (existing) {
    assertSyncOperation(existing);
    if (JSON.stringify(existing) !== JSON.stringify(operation)) {
      throw operationError('SyncOperation opId conflicts with another intent', 'SYNC_OPERATION_ID_CONFLICT');
    }
    return cloneJson(existing);
  }
  draft.sync.outbox.push(cloneJson(operation));
  return cloneJson(operation);
}

function legacyEntityKey(operation) {
  if (!operation || typeof operation !== 'object') {
    return null;
  }
  const entityType = LEGACY_ENTITY_ALIASES[operation.entityType] || operation.entityType;
  if (!Object.values(ENTITY_TYPES).includes(entityType)) {
    return null;
  }
  if (typeof operation.entityId !== 'string' || operation.entityId.length === 0) {
    return null;
  }
  return entityKey(entityType, operation.entityId);
}

function selectPushableOperations(outbox) {
  if (!Array.isArray(outbox)) {
    throw operationError('Sync outbox must be an array', 'SYNC_STATE_INVALID');
  }
  const operations = [];
  const unsupported = [];
  const occupiedEntityKeys = new Set();
  for (let index = 0; index < outbox.length; index += 1) {
    const candidate = outbox[index];
    try {
      assertSyncOperation(candidate);
      const key = entityKey(candidate.entityType, candidate.entityId);
      if (!occupiedEntityKeys.has(key)) {
        occupiedEntityKeys.add(key);
        operations.push(cloneJson(candidate));
      }
    } catch (error) {
      const key = legacyEntityKey(candidate);
      if (key) {
        occupiedEntityKeys.add(key);
      }
      unsupported.push({
        index,
        opId: candidate && typeof candidate.opId === 'string' ? candidate.opId : null,
        entityType: candidate && typeof candidate.entityType === 'string' ? candidate.entityType : null,
        entityId: candidate && typeof candidate.entityId === 'string' ? candidate.entityId : null,
        code: error.code || 'SYNC_OPERATION_INVALID'
      });
    }
  }
  return { operations, unsupported };
}

function assertAcceptedReceipt(receipt) {
  if (!hasExactFields(receipt, RECEIPT_FIELDS)) {
    throw operationError('accepted receipt must use the closed V1 schema', 'SYNC_RECEIPT_INVALID');
  }
  if (typeof receipt.opId !== 'string' || receipt.opId.length === 0) {
    throw operationError('accepted receipt opId is invalid', 'SYNC_RECEIPT_INVALID');
  }
  entityKey(receipt.entityType, receipt.entityId);
  if (!Number.isSafeInteger(receipt.serverRevision) || receipt.serverRevision < 1) {
    throw operationError('accepted receipt serverRevision is invalid', 'SYNC_RECEIPT_INVALID');
  }
}

function applyAcceptedOperations(draft, receipts) {
  ensureSyncState(draft);
  if (!Array.isArray(receipts)) {
    throw operationError('accepted receipts must be an array', 'SYNC_RECEIPT_INVALID');
  }
  const acceptedOpIds = [];
  const unknownOpIds = [];
  for (const receipt of receipts) {
    assertAcceptedReceipt(receipt);
    const index = draft.sync.outbox.findIndex(
      (candidate) => candidate && candidate.opId === receipt.opId
    );
    if (index === -1) {
      unknownOpIds.push(receipt.opId);
      continue;
    }
    const operation = draft.sync.outbox[index];
    assertSyncOperation(operation);
    if (
      operation.entityType !== receipt.entityType ||
      operation.entityId !== receipt.entityId
    ) {
      throw operationError('accepted receipt identity does not match operation', 'SYNC_RECEIPT_IDENTITY_MISMATCH');
    }
    const operationKey = entityKey(operation.entityType, operation.entityId);
    const headIndex = draft.sync.outbox.findIndex((candidate) => {
      try {
        assertSyncOperation(candidate);
        return entityKey(candidate.entityType, candidate.entityId) === operationKey;
      } catch (_error) {
        return legacyEntityKey(candidate) === operationKey;
      }
    });
    if (headIndex !== index) {
      throw operationError('accepted receipt is not for the entity queue head', 'SYNC_RECEIPT_ORDER_INVALID');
    }
    const currentReplica = draft.sync.replicas[operationKey] || null;
    const minimumRevision = Math.max(
      operation.baseServerRevision,
      currentReplica ? currentReplica.serverRevision : 0
    );
    if (receipt.serverRevision <= minimumRevision) {
      throw operationError(
        `accepted receipt revision ${receipt.serverRevision} must advance beyond ${minimumRevision}`,
        'SYNC_RECEIPT_REVISION_INVALID'
      );
    }

    draft.sync.outbox.splice(index, 1);
    draft.sync.replicas[operationKey] = {
      entityType: operation.entityType,
      entityId: operation.entityId,
      serverRevision: receipt.serverRevision,
      payloadHash: computeChecksum(operation.payload),
      deleted: operation.action === 'delete'
    };
    assertSyncReplica(draft.sync.replicas[operationKey]);

    const next = draft.sync.outbox.find((candidate) => {
      try {
        assertSyncOperation(candidate);
        return candidate.entityType === operation.entityType && candidate.entityId === operation.entityId;
      } catch (_error) {
        return false;
      }
    });
    if (next) {
      next.baseServerRevision = receipt.serverRevision;
      assertSyncOperation(next);
    }
    acceptedOpIds.push(operation.opId);
  }
  return { acceptedOpIds, unknownOpIds };
}

module.exports = {
  OPERATION_FIELDS,
  REPLICA_FIELDS,
  appendSyncOperation,
  applyAcceptedOperations,
  assertSyncOperation,
  assertSyncReplica,
  entityKey,
  selectPushableOperations
};
