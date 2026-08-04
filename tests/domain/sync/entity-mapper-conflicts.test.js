const assert = require('node:assert/strict');
const test = require('node:test');

const { createDefaultPlans } = require('../../../miniprogram/domain/planning/default-plan-factory');
const { DEFAULT_USER_SETTINGS } = require('../../../miniprogram/utils/constants');
const {
  ENTITY_TYPES,
  createConflictState,
  mapLocalMutation,
  mapRemoteChange,
  rebaseSettingsChange
} = require('../../../miniprogram/domain/sync/entity-mapper');

const NOW = 1785719340000;

function planFixture(overrides = {}) {
  return {
    ...createDefaultPlans({ now: () => NOW })[0],
    ...overrides
  };
}

function containsForbiddenRemoteField(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([field, nested]) => (
    ['ownerId', 'serverRevision', 'openId', 'openid', 'accessToken', 'refreshToken', 'secret', 'password']
      .includes(field) || containsForbiddenRemoteField(nested)
  ));
}

test('AC5: local mapper strips remote identity/revision/secret fields before validating a plan payload', () => {
  const plan = planFixture({
    ownerId: 'forged-owner',
    serverRevision: 999,
    accessToken: 'must-not-leave-device'
  });
  plan.steps[0] = {
    ...plan.steps[0],
    serverRevision: 123,
    secret: 'nested-secret'
  };

  const mutation = mapLocalMutation({
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    action: 'upsert',
    payload: plan
  });

  assert.deepEqual(Object.keys(mutation), ['entityType', 'entityId', 'action', 'payload']);
  assert.equal(mutation.entityType, 'workout_plan');
  assert.equal(mutation.entityId, plan.id);
  assert.equal(mutation.action, 'upsert');
  assert.equal(containsForbiddenRemoteField(mutation.payload), false);
  assert.equal(mutation.payload.id, plan.id);
  assert.notEqual(mutation.payload, plan);
});

test('AC5: mapper enforces supported types, entity identity, action and payload size without mutating input', () => {
  const plan = planFixture();
  const before = JSON.stringify(plan);

  assert.throws(
    () => mapLocalMutation({ entityType: 'active_session', entityId: 'session_1', action: 'upsert', payload: {} }),
    (error) => error && error.code === 'SYNC_ENTITY_UNSUPPORTED'
  );
  assert.throws(
    () => mapLocalMutation({ entityType: ENTITY_TYPES.WORKOUT_PLAN, entityId: 'other-plan', action: 'upsert', payload: plan }),
    (error) => error && error.code === 'SYNC_ENTITY_ID_MISMATCH'
  );
  assert.throws(
    () => mapLocalMutation({ entityType: ENTITY_TYPES.WORKOUT_PLAN, entityId: plan.id, action: 'patch', payload: plan }),
    (error) => error && error.code === 'SYNC_ACTION_UNSUPPORTED'
  );
  assert.throws(
    () => mapLocalMutation({
      entityType: ENTITY_TYPES.WORKOUT_PLAN,
      entityId: plan.id,
      action: 'upsert',
      payload: { ...plan, summary: 'x'.repeat(70 * 1024) }
    }),
    (error) => error && error.code === 'SYNC_PAYLOAD_TOO_LARGE'
  );
  assert.throws(
    () => mapLocalMutation({
      entityType: ENTITY_TYPES.WORKOUT_PLAN,
      entityId: plan.id,
      action: 'upsert',
      payload: { ...plan, summary: '你'.repeat(22 * 1024) }
    }),
    (error) => error && error.code === 'SYNC_PAYLOAD_TOO_LARGE',
    'payload limit must count UTF-8 bytes instead of JavaScript characters'
  );
  assert.equal(JSON.stringify(plan), before);
});

test('AC5: payload JSON arrays must be dense inert data rather than sparse serialization aliases', () => {
  const plan = planFixture();
  const sparseSteps = [plan.steps[0]];
  sparseSteps.length = 2;

  assert.throws(
    () => mapLocalMutation({
      entityType: ENTITY_TYPES.WORKOUT_PLAN,
      entityId: plan.id,
      action: 'upsert',
      payload: { ...plan, steps: sparseSteps }
    }),
    (error) => error && error.code === 'SYNC_PAYLOAD_INVALID'
  );
});

test('AC5: tombstones use a single null-payload contract for every supported entity type', () => {
  for (const [entityType, entityId] of [
    [ENTITY_TYPES.WORKOUT_PLAN, 'plan_deleted'],
    [ENTITY_TYPES.TRAINING_RECORD, 'record_deleted'],
    [ENTITY_TYPES.USER_SETTINGS, 'settings']
  ]) {
    assert.deepEqual(mapLocalMutation({
      entityType,
      entityId,
      action: 'delete',
      payload: null
    }), {
      entityType,
      entityId,
      action: 'delete',
      payload: null
    });
    assert.throws(
      () => mapLocalMutation({ entityType, entityId, action: 'delete', payload: {} }),
      (error) => error && error.code === 'SYNC_TOMBSTONE_PAYLOAD_INVALID'
    );
  }
});

test('AC5: remote mapper treats server fields as envelope facts and never leaks them into domain payload', () => {
  const plan = planFixture({ ownerId: 'forged-owner', serverRevision: 900 });
  const change = mapRemoteChange({
    ownerId: 'trusted-owner-hash',
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    serverRevision: 7,
    schemaVersion: 1,
    payload: plan,
    deleted: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW + 1000,
    sourceDeviceId: 'remote-device'
  });

  assert.deepEqual(Object.keys(change), [
    'entityType',
    'entityId',
    'serverRevision',
    'action',
    'payload',
    'deletedAt',
    'payloadHash'
  ]);
  assert.equal(change.serverRevision, 7);
  assert.equal(change.action, 'upsert');
  assert.equal(containsForbiddenRemoteField(change.payload), false);
  assert.equal(Object.prototype.hasOwnProperty.call(change, 'ownerId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(change, 'sourceDeviceId'), false);
});

test('AC6: plan and record conflicts preserve local work plus sanitized remote facts as explicit unresolved state', () => {
  const plan = planFixture();
  const remote = mapRemoteChange({
    ownerId: 'owner-hash',
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    serverRevision: 4,
    schemaVersion: 1,
    payload: { ...plan, title: 'Remote title', ownerId: 'forged' },
    deleted: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW + 1,
    sourceDeviceId: 'remote-device'
  });
  const localOperation = {
    opId: 'op_local_plan',
    deviceId: 'device_local',
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    action: 'upsert',
    baseServerRevision: 3,
    payload: { ...plan, title: 'Local title' },
    createdAt: NOW,
    attemptCount: 0,
    lastAttemptAt: null
  };

  const conflict = createConflictState({
    localOperation,
    remoteChange: remote,
    localEntity: localOperation.payload,
    detectedAt: NOW + 2
  });

  assert.equal(conflict.status, 'unresolved');
  assert.equal(conflict.policy, 'preserve_remote_and_local');
  assert.equal(conflict.local.opId, localOperation.opId);
  assert.equal(conflict.local.payload.title, 'Local title');
  assert.equal(conflict.remote.serverRevision, 4);
  assert.equal(conflict.remote.payload.title, 'Remote title');
  assert.equal(containsForbiddenRemoteField(conflict.remote.payload), false);
});

test('AC6: settings rebase keeps local touched fields, applies untouched remote facts and records overlapping differences', () => {
  const remoteSettings = {
    ...DEFAULT_USER_SETTINGS,
    soundEnabled: false,
    defaultRestSeconds: 90,
    revision: 5
  };
  const localSettings = {
    ...DEFAULT_USER_SETTINGS,
    soundEnabled: true,
    vibrationEnabled: false,
    revision: 3
  };
  const localOperation = {
    opId: 'op_settings_local',
    deviceId: 'device_local',
    entityType: ENTITY_TYPES.USER_SETTINGS,
    entityId: 'settings',
    action: 'upsert',
    baseServerRevision: 2,
    payload: { soundEnabled: true, vibrationEnabled: false },
    createdAt: NOW,
    attemptCount: 0,
    lastAttemptAt: null
  };

  const result = rebaseSettingsChange({
    localSettings,
    localOperation,
    remoteChange: {
      entityType: ENTITY_TYPES.USER_SETTINGS,
      entityId: 'settings',
      serverRevision: 3,
      action: 'upsert',
      payload: remoteSettings,
      deletedAt: null,
      payloadHash: 'remote-settings-hash'
    },
    detectedAt: NOW + 10
  });

  assert.equal(result.settings.soundEnabled, true);
  assert.equal(result.settings.vibrationEnabled, false);
  assert.equal(result.settings.defaultRestSeconds, 90);
  assert.equal(result.operation.opId, localOperation.opId, 'rebase must keep the idempotency key stable');
  assert.equal(result.operation.baseServerRevision, 3);
  assert.equal(result.conflict.status, 'rebased');
  assert.deepEqual(
    result.conflict.overlappingFields,
    ['soundEnabled', 'vibrationEnabled'],
    'without a remote field-change mask the safe policy treats every differing locally-touched field as overlapping'
  );
});

test('AC6: settings rebase rejects domain revision overflow before producing an invalid local snapshot', () => {
  assert.throws(
    () => rebaseSettingsChange({
      localSettings: { ...DEFAULT_USER_SETTINGS, revision: Number.MAX_SAFE_INTEGER },
      localOperation: {
        opId: 'op_settings_overflow',
        deviceId: 'device_local',
        entityType: ENTITY_TYPES.USER_SETTINGS,
        entityId: 'settings',
        action: 'upsert',
        baseServerRevision: 2,
        payload: { soundEnabled: false },
        createdAt: NOW,
        attemptCount: 0,
        lastAttemptAt: null
      },
      remoteChange: {
        entityType: ENTITY_TYPES.USER_SETTINGS,
        entityId: 'settings',
        serverRevision: 3,
        action: 'upsert',
        payload: { ...DEFAULT_USER_SETTINGS, revision: Number.MAX_SAFE_INTEGER },
        deletedAt: null,
        payloadHash: 'remote-settings-hash'
      },
      detectedAt: NOW + 10
    }),
    (error) => error && error.code === 'SYNC_SETTINGS_REVISION_OVERFLOW'
  );
});

test('AC6: remote record tombstone is an explicit deletion action, never an incomplete local record', () => {
  const change = mapRemoteChange({
    ownerId: 'owner-hash',
    entityType: ENTITY_TYPES.TRAINING_RECORD,
    entityId: 'record_terminal_1',
    serverRevision: 9,
    schemaVersion: 1,
    payload: null,
    deleted: true,
    deletedAt: NOW,
    createdAt: NOW - 1000,
    updatedAt: NOW,
    sourceDeviceId: 'remote-device'
  });

  assert.deepEqual(change, {
    entityType: ENTITY_TYPES.TRAINING_RECORD,
    entityId: 'record_terminal_1',
    serverRevision: 9,
    action: 'delete',
    payload: null,
    deletedAt: NOW,
    payloadHash: change.payloadHash
  });
  assert.equal(typeof change.payloadHash, 'string');
  assert.notEqual(change.payloadHash.length, 0);
});
