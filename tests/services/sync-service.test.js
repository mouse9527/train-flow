const assert = require('node:assert/strict');
const test = require('node:test');

const { createDefaultPlans } = require('../../miniprogram/domain/planning/default-plan-factory');
const { createAppDatabase } = require('../../miniprogram/domain/sync/app-database');
const { ENTITY_TYPES } = require('../../miniprogram/domain/sync/entity-mapper');
const { computeChecksum } = require('../../miniprogram/utils/checksum');
const {
  appendSyncOperation,
  applyAcceptedOperations,
  assertSyncOperation,
  entityKey,
  selectPushableOperations
} = require('../../miniprogram/domain/sync/sync-operation');

const NOW = 1785719340000;

function planFixture() {
  return createDefaultPlans({ now: () => NOW })[0];
}

function newDraft() {
  return createAppDatabase({ now: () => NOW });
}

function queuePlan(draft, {
  intentKey = 'save-plan-1',
  title = planFixture().title,
  createdAt = NOW
} = {}) {
  const plan = { ...planFixture(), title };
  return appendSyncOperation(draft, {
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    action: 'upsert',
    payload: plan
  }, {
    createdAt,
    intentKey,
    deviceIdFactory: () => 'device_sync_test'
  });
}

test('AC1: append creates one closed schema-valid operation and install identity inside the same draft', () => {
  const draft = newDraft();
  assert.deepEqual(draft.sync.replicas, {}, 'SyncReplica metadata is part of the V1 snapshot shape');
  const operation = queuePlan(draft);

  assert.deepEqual(Object.keys(operation), [
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
  assertSyncOperation(operation);
  assert.deepEqual(draft.install, { deviceId: 'device_sync_test', createdAt: NOW });
  assert.equal(draft.sync.outbox.length, 1);
  assert.deepEqual(draft.sync.outbox[0], operation);
  assert.notEqual(draft.sync.outbox[0], operation);
  assert.equal(operation.baseServerRevision, 0);
  assert.match(operation.opId, /^op_[a-f0-9]{64}$/);
});

test('AC1: same persisted intent keeps a stable opId and cannot append a duplicate operation', () => {
  const draft = newDraft();
  const first = queuePlan(draft);
  const replay = queuePlan(draft);

  assert.deepEqual(replay, first);
  assert.notEqual(replay, first);
  assert.equal(draft.sync.outbox.length, 1);
  assert.equal(draft.sync.outbox[0].opId, first.opId);
});

test('AC1: operation baseServerRevision comes from strict replica metadata rather than domain revision or device time', () => {
  const draft = newDraft();
  draft.sync.replicas = {
    [entityKey(ENTITY_TYPES.WORKOUT_PLAN, planFixture().id)]: {
      entityType: ENTITY_TYPES.WORKOUT_PLAN,
      entityId: planFixture().id,
      serverRevision: 11,
      payloadHash: 'a'.repeat(64),
      deleted: false
    }
  };

  const operation = queuePlan(draft);

  assert.equal(operation.baseServerRevision, 11);
  assert.equal(operation.payload.revision, 1, 'domain revision remains a domain fact only');
});

test('AC3: only the head operation per entity is pushable while independent entities can progress together', () => {
  const draft = newDraft();
  const firstPlan = queuePlan(draft, { intentKey: 'plan-1', title: 'First local edit' });
  const secondPlan = queuePlan(draft, { intentKey: 'plan-2', title: 'Second local edit', createdAt: NOW + 1 });
  const settings = appendSyncOperation(draft, {
    entityType: ENTITY_TYPES.USER_SETTINGS,
    entityId: 'settings',
    action: 'upsert',
    payload: { soundEnabled: false }
  }, {
    createdAt: NOW + 2,
    intentKey: 'settings-1',
    deviceIdFactory: () => 'unused-after-install'
  });

  const selection = selectPushableOperations(draft.sync.outbox);

  assert.deepEqual(selection.operations.map(({ opId }) => opId), [firstPlan.opId, settings.opId]);
  assert.equal(selection.operations.some(({ opId }) => opId === secondPlan.opId), false);
  assert.deepEqual(selection.unsupported, []);
});

test('AC3: legacy descriptor stays durable, blocks only its own entity queue and never enters provider payload', () => {
  const draft = newDraft();
  draft.sync.outbox.push({
    opId: 'legacy_descriptor',
    kind: 'training-record.corrected',
    entityType: 'training-record',
    entityId: 'record_legacy',
    entityRevision: 2,
    occurredAt: NOW - 1
  });
  const validRecord = appendSyncOperation(draft, {
    entityType: ENTITY_TYPES.TRAINING_RECORD,
    entityId: 'record_legacy',
    action: 'delete',
    payload: null
  }, {
    createdAt: NOW,
    intentKey: 'record-delete',
    deviceIdFactory: () => 'device_sync_test'
  });
  const validSettings = appendSyncOperation(draft, {
    entityType: ENTITY_TYPES.USER_SETTINGS,
    entityId: 'settings',
    action: 'upsert',
    payload: { vibrationEnabled: false }
  }, {
    createdAt: NOW + 1,
    intentKey: 'settings-update',
    deviceIdFactory: () => 'unused-after-install'
  });

  const before = JSON.stringify(draft.sync.outbox);
  const selection = selectPushableOperations(draft.sync.outbox);

  assert.deepEqual(selection.operations.map(({ opId }) => opId), [validSettings.opId]);
  assert.equal(selection.operations.some(({ opId }) => opId === validRecord.opId), false);
  assert.deepEqual(selection.unsupported, [{
    index: 0,
    opId: 'legacy_descriptor',
    entityType: 'training-record',
    entityId: 'record_legacy',
    code: 'SYNC_OPERATION_UNSUPPORTED'
  }]);
  assert.equal(JSON.stringify(draft.sync.outbox), before);
});

test('AC3: accepted receipt removes only its exact operation, records replica revision and rebases next op without changing opId', () => {
  const draft = newDraft();
  const first = queuePlan(draft, { intentKey: 'plan-1', title: 'First local edit' });
  const second = queuePlan(draft, { intentKey: 'plan-2', title: 'Second local edit', createdAt: NOW + 1 });
  const unknownBefore = JSON.stringify(draft.sync.outbox);

  const result = applyAcceptedOperations(draft, [{
    opId: first.opId,
    entityType: first.entityType,
    entityId: first.entityId,
    serverRevision: 12
  }, {
    opId: 'op_unknown',
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: first.entityId,
    serverRevision: 13
  }]);

  assert.deepEqual(result, {
    acceptedOpIds: [first.opId],
    unknownOpIds: ['op_unknown']
  });
  assert.equal(draft.sync.outbox.length, 1);
  assert.equal(draft.sync.outbox[0].opId, second.opId);
  assert.equal(draft.sync.outbox[0].baseServerRevision, 12);
  assert.equal(draft.sync.outbox[0].payload.title, 'Second local edit');
  assert.deepEqual(draft.sync.replicas[entityKey(first.entityType, first.entityId)], {
    entityType: first.entityType,
    entityId: first.entityId,
    serverRevision: 12,
    payloadHash: computeChecksum(first.payload),
    deleted: false
  });
  assert.notEqual(JSON.stringify(draft.sync.outbox), unknownBefore);
});

test('AC3: a legacy predecessor prevents a forged accepted receipt from skipping the quarantined entity head', () => {
  const draft = newDraft();
  draft.sync.outbox.push({
    opId: 'legacy_descriptor',
    kind: 'training-record.corrected',
    entityType: 'training-record',
    entityId: 'record_legacy',
    entityRevision: 2,
    occurredAt: NOW - 1
  });
  const valid = appendSyncOperation(draft, {
    entityType: ENTITY_TYPES.TRAINING_RECORD,
    entityId: 'record_legacy',
    action: 'delete',
    payload: null
  }, {
    createdAt: NOW,
    intentKey: 'record-delete',
    deviceIdFactory: () => 'device_sync_test'
  });
  const before = JSON.stringify(draft);

  assert.throws(
    () => applyAcceptedOperations(draft, [{
      opId: valid.opId,
      entityType: valid.entityType,
      entityId: valid.entityId,
      serverRevision: 1
    }]),
    (error) => error && error.code === 'SYNC_RECEIPT_ORDER_INVALID'
  );
  assert.equal(JSON.stringify(draft), before);
});

test('AC3: accepted server revision must advance beyond the operation base revision', () => {
  const draft = newDraft();
  draft.sync.replicas = {
    [entityKey(ENTITY_TYPES.WORKOUT_PLAN, planFixture().id)]: {
      entityType: ENTITY_TYPES.WORKOUT_PLAN,
      entityId: planFixture().id,
      serverRevision: 11,
      payloadHash: 'a'.repeat(64),
      deleted: false
    }
  };
  const operation = queuePlan(draft);
  const before = JSON.stringify(draft);

  assert.throws(
    () => applyAcceptedOperations(draft, [{
      opId: operation.opId,
      entityType: operation.entityType,
      entityId: operation.entityId,
      serverRevision: 11
    }]),
    (error) => error && error.code === 'SYNC_RECEIPT_REVISION_INVALID'
  );
  assert.equal(JSON.stringify(draft), before);
});
