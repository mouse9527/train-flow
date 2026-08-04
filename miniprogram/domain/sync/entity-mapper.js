const { assertWorkoutPlan } = require('../planning/plan-validation');
const {
  buildEffectiveTrainingRecord,
  isDeletedTrainingRecord
} = require('../records/training-record');
const { computeChecksum } = require('../../utils/checksum');
const {
  DEFAULT_USER_SETTINGS,
  LOCAL_TIME_PATTERN,
  MAX_REST_SECONDS,
  MIN_REST_SECONDS,
  TIMEZONE_PATTERN
} = require('../../utils/constants');

const ENTITY_TYPES = Object.freeze({
  WORKOUT_PLAN: 'workout_plan',
  TRAINING_RECORD: 'training_record',
  USER_SETTINGS: 'user_settings'
});
const SUPPORTED_ENTITY_TYPES = new Set(Object.values(ENTITY_TYPES));
const SUPPORTED_ACTIONS = new Set(['upsert', 'delete']);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const REMOTE_ENVELOPE_FIELDS = Object.freeze([
  'ownerId',
  'entityType',
  'entityId',
  'serverRevision',
  'schemaVersion',
  'payload',
  'deleted',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'sourceDeviceId'
]);
const SETTINGS_FIELDS = new Set(Object.keys(DEFAULT_USER_SETTINGS));
const SETTINGS_SYNC_FIELDS = new Set(
  Object.keys(DEFAULT_USER_SETTINGS).filter((field) => !['schemaVersion', 'revision'].includes(field))
);
const FORBIDDEN_PAYLOAD_FIELDS = new Set([
  'ownerId',
  'serverRevision',
  'sourceDeviceId',
  'openId',
  'openid',
  'accessToken',
  'refreshToken',
  'secret',
  'password'
]);

function syncError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function assertPlainJson(value, label, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw syncError(`${label} must contain canonical finite JSON numbers`, 'SYNC_PAYLOAD_INVALID');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw syncError(`${label} contains a non-JSON ${typeof value} value`, 'SYNC_PAYLOAD_INVALID');
  }
  if (ancestors.has(value)) {
    throw syncError(`${label} contains a circular reference`, 'SYNC_PAYLOAD_INVALID');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw syncError(`${label} contains symbol fields`, 'SYNC_PAYLOAD_INVALID');
  }
  if (
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) ||
    (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype)
  ) {
    throw syncError(`${label} must contain only plain JSON data`, 'SYNC_PAYLOAD_INVALID');
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, index)) {
        throw syncError(`${label}[${index}] is a sparse JSON array entry`, 'SYNC_PAYLOAD_INVALID');
      }
    }
    const extraField = Object.getOwnPropertyNames(value).find(
      (field) => field !== 'length' && !/^(0|[1-9]\d*)$/.test(field)
    );
    if (extraField) {
      throw syncError(`${label} contains unknown array field ${extraField}`, 'SYNC_PAYLOAD_INVALID');
    }
  }

  ancestors.add(value);
  for (const field of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && field === 'length') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor.enumerable || !hasOwn(descriptor, 'value') || descriptor.value === undefined) {
      throw syncError(`${label}.${field} must be an enumerable JSON data field`, 'SYNC_PAYLOAD_INVALID');
    }
    assertPlainJson(descriptor.value, `${label}.${field}`, ancestors);
  }
  ancestors.delete(value);
}

function shouldStripField(field) {
  return FORBIDDEN_PAYLOAD_FIELDS.has(field) ||
    /(?:secret|password|token|credential)$/i.test(field);
}

function cloneSanitized(value) {
  assertPlainJson(value, 'sync payload');
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneSanitized);
  }
  const result = {};
  for (const field of Object.keys(value)) {
    if (!shouldStripField(field)) {
      result[field] = cloneSanitized(value[field]);
    }
  }
  return result;
}

function cloneJson(value) {
  assertPlainJson(value, 'sync value');
  return JSON.parse(JSON.stringify(value));
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function assertPayloadSize(payload) {
  if (utf8ByteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    throw syncError(
      `sync payload exceeds ${MAX_PAYLOAD_BYTES} UTF-8 bytes`,
      'SYNC_PAYLOAD_TOO_LARGE'
    );
  }
}

function assertEntityIdentity(entityType, entityId, payload) {
  if (entityType === ENTITY_TYPES.USER_SETTINGS) {
    if (entityId !== 'settings') {
      throw syncError('user_settings entityId must be settings', 'SYNC_ENTITY_ID_MISMATCH');
    }
    return;
  }
  if (!payload || payload.id !== entityId) {
    throw syncError('sync entityId does not match payload identity', 'SYNC_ENTITY_ID_MISMATCH');
  }
}

function assertSettingsValue(field, value) {
  if (['vibrationEnabled', 'soundEnabled', 'voiceEnabled', 'keepScreenOn', 'cloudSyncEnabled'].includes(field)) {
    if (typeof value !== 'boolean') {
      throw syncError(`settings.${field} must be a boolean`, 'SYNC_PAYLOAD_INVALID');
    }
    return;
  }
  if (['defaultStartLocalTime', 'recommendedEndLocalTime'].includes(field)) {
    if (typeof value !== 'string' || !LOCAL_TIME_PATTERN.test(value)) {
      throw syncError(`settings.${field} must be HH:mm`, 'SYNC_PAYLOAD_INVALID');
    }
    return;
  }
  if (field === 'defaultRestSeconds') {
    if (!Number.isSafeInteger(value) || value < MIN_REST_SECONDS || value > MAX_REST_SECONDS) {
      throw syncError('settings.defaultRestSeconds is out of range', 'SYNC_PAYLOAD_INVALID');
    }
    return;
  }
  if (field === 'timezone') {
    if (typeof value !== 'string' || !TIMEZONE_PATTERN.test(value)) {
      throw syncError('settings.timezone is invalid', 'SYNC_PAYLOAD_INVALID');
    }
    return;
  }
  if (field === 'schemaVersion' || field === 'revision') {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw syncError(`settings.${field} must be a positive safe integer`, 'SYNC_PAYLOAD_INVALID');
    }
  }
}

function assertSettingsPayload(payload, { partial }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw syncError('user_settings payload must be an object', 'SYNC_PAYLOAD_INVALID');
  }
  const allowedFields = partial ? SETTINGS_SYNC_FIELDS : SETTINGS_FIELDS;
  for (const field of Object.keys(payload)) {
    if (!allowedFields.has(field)) {
      throw syncError(`user_settings payload contains unknown field ${field}`, 'SYNC_PAYLOAD_INVALID');
    }
    assertSettingsValue(field, payload[field]);
  }
  if (partial && Object.keys(payload).length === 0) {
    throw syncError('user_settings mutation must contain at least one changed field', 'SYNC_PAYLOAD_INVALID');
  }
  if (!partial) {
    for (const field of SETTINGS_FIELDS) {
      if (!hasOwn(payload, field)) {
        throw syncError(`user_settings payload requires ${field}`, 'SYNC_PAYLOAD_INVALID');
      }
    }
  }
}

function assertEntityPayload(entityType, payload, { remote = false } = {}) {
  if (entityType === ENTITY_TYPES.WORKOUT_PLAN) {
    assertWorkoutPlan(payload);
  } else if (entityType === ENTITY_TYPES.TRAINING_RECORD) {
    if (isDeletedTrainingRecord(payload)) {
      throw syncError('training_record upsert cannot carry a tombstone', 'SYNC_PAYLOAD_INVALID');
    }
    buildEffectiveTrainingRecord(payload);
  } else if (entityType === ENTITY_TYPES.USER_SETTINGS) {
    assertSettingsPayload(payload, { partial: !remote });
  }
}

function assertEntityType(entityType) {
  if (!SUPPORTED_ENTITY_TYPES.has(entityType)) {
    throw syncError(`unsupported sync entityType ${entityType}`, 'SYNC_ENTITY_UNSUPPORTED');
  }
}

function normalizeMutation({ entityType, entityId, action, payload }, options = {}) {
  assertEntityType(entityType);
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw syncError('sync entityId must be a non-empty string', 'SYNC_ENTITY_ID_MISMATCH');
  }
  if (!SUPPORTED_ACTIONS.has(action)) {
    throw syncError(`unsupported sync action ${action}`, 'SYNC_ACTION_UNSUPPORTED');
  }
  if (action === 'delete') {
    if (payload !== null) {
      throw syncError('sync tombstone payload must be null', 'SYNC_TOMBSTONE_PAYLOAD_INVALID');
    }
    if (entityType === ENTITY_TYPES.USER_SETTINGS && entityId !== 'settings') {
      throw syncError('user_settings entityId must be settings', 'SYNC_ENTITY_ID_MISMATCH');
    }
    return { entityType, entityId, action, payload: null };
  }

  const sanitized = cloneSanitized(payload);
  assertEntityIdentity(entityType, entityId, sanitized);
  assertEntityPayload(entityType, sanitized, options);
  assertPayloadSize(sanitized);
  return { entityType, entityId, action, payload: sanitized };
}

function mapLocalMutation(input) {
  return normalizeMutation(input, { remote: false });
}

function assertRemoteEnvelope(envelope) {
  assertPlainJson(envelope, 'remote envelope');
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw syncError('remote envelope must be an object', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
  const actualFields = Object.keys(envelope);
  if (
    actualFields.length !== REMOTE_ENVELOPE_FIELDS.length ||
    REMOTE_ENVELOPE_FIELDS.some((field) => !hasOwn(envelope, field))
  ) {
    throw syncError('remote envelope must use the closed V1 schema', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
  assertEntityType(envelope.entityType);
  if (typeof envelope.entityId !== 'string' || envelope.entityId.length === 0) {
    throw syncError('remote entityId must be a non-empty string', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
  if (!Number.isSafeInteger(envelope.serverRevision) || envelope.serverRevision < 1) {
    throw syncError('remote serverRevision must be a positive safe integer', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
  if (envelope.schemaVersion !== 1) {
    throw syncError('remote schemaVersion is unsupported', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
  if (typeof envelope.deleted !== 'boolean') {
    throw syncError('remote deleted must be a boolean', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (!Number.isSafeInteger(envelope[field]) || envelope[field] < 0) {
      throw syncError(`remote ${field} must be a non-negative safe integer`, 'SYNC_REMOTE_ENVELOPE_INVALID');
    }
  }
  if (envelope.updatedAt < envelope.createdAt) {
    throw syncError('remote timestamps are out of order', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
  if (
    typeof envelope.ownerId !== 'string' || envelope.ownerId.length === 0 ||
    typeof envelope.sourceDeviceId !== 'string' || envelope.sourceDeviceId.length === 0
  ) {
    throw syncError('remote identity facts are invalid', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
}

function mapRemoteChange(envelope) {
  assertRemoteEnvelope(envelope);
  const action = envelope.deleted ? 'delete' : 'upsert';
  if (envelope.deleted) {
    if (
      envelope.payload !== null ||
      !Number.isSafeInteger(envelope.deletedAt) ||
      envelope.deletedAt !== envelope.updatedAt
    ) {
      throw syncError('remote tombstone is invalid', 'SYNC_TOMBSTONE_PAYLOAD_INVALID');
    }
  } else if (envelope.deletedAt !== null) {
    throw syncError('remote live entity cannot contain deletedAt', 'SYNC_REMOTE_ENVELOPE_INVALID');
  }
  const mutation = normalizeMutation({
    entityType: envelope.entityType,
    entityId: envelope.entityId,
    action,
    payload: envelope.payload
  }, { remote: true });
  return {
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    serverRevision: envelope.serverRevision,
    action: mutation.action,
    payload: mutation.payload,
    deletedAt: envelope.deletedAt,
    payloadHash: computeChecksum(mutation.payload)
  };
}

function createConflictState({
  localOperation,
  remoteChange,
  localEntity,
  currentEntity = localEntity,
  detectedAt
}) {
  assertPlainJson(localOperation, 'local operation');
  assertPlainJson(remoteChange, 'remote change');
  assertPlainJson(localEntity, 'local entity');
  assertPlainJson(currentEntity, 'current local entity');
  if (!Number.isSafeInteger(detectedAt) || detectedAt < 0) {
    throw syncError('conflict detectedAt must be a non-negative safe integer', 'SYNC_CONFLICT_INVALID');
  }
  if (
    localOperation.entityType !== remoteChange.entityType ||
    localOperation.entityId !== remoteChange.entityId
  ) {
    throw syncError('conflict entities do not match', 'SYNC_CONFLICT_INVALID');
  }
  const local = {
    opId: localOperation.opId,
    baseServerRevision: localOperation.baseServerRevision,
    action: localOperation.action,
    payload: cloneJson(localEntity),
    entityRevision: currentEntity && Number.isSafeInteger(currentEntity.revision)
      ? currentEntity.revision
      : null,
    entityHash: computeChecksum(currentEntity)
  };
  const remote = cloneJson(remoteChange);
  return {
    conflictId: `conflict_${computeChecksum({ local, remote }).slice(0, 32)}`,
    entityType: remote.entityType,
    entityId: remote.entityId,
    status: 'unresolved',
    policy: 'preserve_remote_and_local',
    local,
    remote,
    detectedAt
  };
}

function rebaseSettingsChange({ localSettings, localOperation, remoteChange, detectedAt }) {
  assertSettingsPayload(cloneSanitized(localSettings), { partial: false });
  assertSettingsPayload(cloneSanitized(localOperation.payload), { partial: true });
  assertSettingsPayload(cloneSanitized(remoteChange.payload), { partial: false });
  if (
    localOperation.entityType !== ENTITY_TYPES.USER_SETTINGS ||
    remoteChange.entityType !== ENTITY_TYPES.USER_SETTINGS ||
    localOperation.entityId !== 'settings' ||
    remoteChange.entityId !== 'settings'
  ) {
    throw syncError('settings rebase requires matching settings entities', 'SYNC_CONFLICT_INVALID');
  }
  const touchedFields = Object.keys(localOperation.payload).sort();
  const overlappingFields = touchedFields.filter(
    (field) => remoteChange.payload[field] !== localOperation.payload[field]
  );
  const currentRevision = Math.max(localSettings.revision, remoteChange.payload.revision);
  if (currentRevision >= Number.MAX_SAFE_INTEGER) {
    throw syncError(
      'settings revision cannot advance safely during rebase',
      'SYNC_SETTINGS_REVISION_OVERFLOW'
    );
  }
  const settings = {
    ...cloneJson(remoteChange.payload),
    ...cloneJson(localOperation.payload),
    revision: currentRevision + 1
  };
  const operation = {
    ...cloneJson(localOperation),
    baseServerRevision: remoteChange.serverRevision
  };
  const conflict = {
    conflictId: `conflict_${computeChecksum({
      opId: operation.opId,
      remoteRevision: remoteChange.serverRevision,
      overlappingFields
    }).slice(0, 32)}`,
    entityType: ENTITY_TYPES.USER_SETTINGS,
    entityId: 'settings',
    status: 'rebased',
    policy: 'field_rebase',
    overlappingFields,
    local: {
      opId: operation.opId,
      baseServerRevision: operation.baseServerRevision,
      action: operation.action,
      payload: cloneJson(operation.payload),
      entityRevision: settings.revision,
      entityHash: computeChecksum(settings)
    },
    remote: cloneJson(remoteChange),
    detectedAt
  };
  return { settings, operation, conflict };
}

module.exports = {
  ENTITY_TYPES,
  MAX_PAYLOAD_BYTES,
  createConflictState,
  mapLocalMutation,
  mapRemoteChange,
  rebaseSettingsChange
};
