const assert = require('node:assert/strict');
const test = require('node:test');

const { createDefaultPlans } = require('../../miniprogram/domain/planning/default-plan-factory');
const { createAppDatabase } = require('../../miniprogram/domain/sync/app-database');
const { ENTITY_TYPES } = require('../../miniprogram/domain/sync/entity-mapper');
const { createSessionRepository } = require('../../miniprogram/domain/execution/session-repository');
const { createPlanRepository } = require('../../miniprogram/domain/planning/plan-repository');
const {
  createTrainingRecordRepository
} = require('../../miniprogram/domain/records/training-record-repository');
const {
  createSettingsRepository
} = require('../../miniprogram/domain/identity-settings/settings-repository');
const {
  createSettingsApplicationService
} = require('../../miniprogram/application/settings-application-service');
const { createLocalDatabase } = require('../../miniprogram/services/local-database');
const { computeChecksum } = require('../../miniprogram/utils/checksum');
const { StorageDouble, clone } = require('../helpers/storage-double');
const {
  appendSyncOperation,
  applyAcceptedOperations,
  assertSyncOperation,
  createRepositoryDeviceIdFactory,
  entityKey,
  selectPushableOperations
} = require('../../miniprogram/domain/sync/sync-operation');

const NOW = 1785719340000;
const SLOT_A = 'train_flow:v1:db:a';
const SLOT_B = 'train_flow:v1:db:b';
const ACTIVE = 'train_flow:v1:db:active';

function planFixture() {
  return createDefaultPlans({ now: () => NOW })[0];
}

function newDraft() {
  return createAppDatabase({ now: () => NOW });
}

function persistentRuntime() {
  const storage = new StorageDouble();
  const database = createLocalDatabase({ storage, now: () => NOW });
  database.commit((draft) => {
    draft.install = { deviceId: 'device_repository_sync', createdAt: NOW - 1000 };
  });
  storage.clearOperations();
  return { database, storage };
}

function assertSingleSnapshotCommit(storage, after, verifyCandidate) {
  const slotWrites = storage.operations.filter(
    ({ type, key }) => type === 'write' && [SLOT_A, SLOT_B].includes(key)
  );
  const pointerWrites = storage.operations.filter(
    ({ type, key }) => type === 'write' && key === ACTIVE
  );
  assert.equal(slotWrites.length, 1, 'domain mutation and SyncOperation must share one candidate slot write');
  assert.equal(pointerWrites.length, 1, 'the same atomic commit must switch the pointer exactly once');
  assert.equal(slotWrites[0].value.localRevision, after.localRevision);
  assert.equal(pointerWrites[0].value, storage.peek(ACTIVE));
  verifyCandidate(slotWrites[0].value);
}

function manualPlan(id = 'plan_sync_terminal') {
  const source = createDefaultPlans({ now: () => NOW })[2];
  return {
    ...clone(source),
    id,
    trainingDate: '2026-09-03',
    templateSource: null,
    steps: [{ ...clone(source.steps.find(({ kind }) => kind === 'manual')), order: 1 }]
  };
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

test('AC1: fresh installations use distinct stable device identities instead of command-derived shared IDs', () => {
  const firstFactory = createRepositoryDeviceIdFactory({
    randomBytes: () => new Uint8Array(32).fill(0x12)
  });
  const secondFactory = createRepositoryDeviceIdFactory({
    randomBytes: () => new Uint8Array(32).fill(0x87)
  });
  const firstDatabase = createLocalDatabase({ storage: new StorageDouble(), now: () => NOW });
  const secondDatabase = createLocalDatabase({ storage: new StorageDouble(), now: () => NOW });
  createPlanRepository({
    database: firstDatabase,
    now: () => NOW,
    deviceIdFactory: firstFactory
  }).save(planFixture(), 0);
  createPlanRepository({
    database: secondDatabase,
    now: () => NOW,
    deviceIdFactory: secondFactory
  }).save(planFixture(), 0);
  const first = firstDatabase.load();
  const second = secondDatabase.load();

  assert.match(first.install.deviceId, /^device_[a-f0-9]{64}$/);
  assert.equal(firstFactory(), first.install.deviceId, 'repository lifecycle must reuse its pending install identity');
  assert.notEqual(second.install.deviceId, first.install.deviceId);
  assert.notEqual(second.sync.outbox[0].opId, first.sync.outbox[0].opId);
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

test('AC1: plan save persists the aggregate and complete SyncOperation in the same A/B commit', () => {
  const { database, storage } = persistentRuntime();
  const repository = createPlanRepository({ database, now: () => NOW });
  const before = database.load();
  const requested = planFixture();

  const saved = repository.save(requested, 0);
  const after = database.load();

  assert.equal(after.localRevision, before.localRevision + 1);
  assertSingleSnapshotCommit(storage, after, (candidate) => {
    assert.deepEqual(candidate.plans.find(({ id }) => id === saved.id), saved);
    const operation = candidate.sync.outbox.at(-1);
    assertSyncOperation(operation);
    assert.equal(operation.entityType, ENTITY_TYPES.WORKOUT_PLAN);
    assert.equal(operation.entityId, saved.id);
    assert.equal(operation.action, 'upsert');
    assert.deepEqual(operation.payload, saved);
  });
});

test('AC1: plan delete persists its domain tombstone and null-payload sync tombstone in one A/B commit', () => {
  const { database, storage } = persistentRuntime();
  database.commit((draft) => { draft.plans.push(clone(planFixture())); });
  storage.clearOperations();
  const repository = createPlanRepository({ database, now: () => NOW + 1000 });
  const before = database.load();

  const deleted = repository.delete(planFixture().id, planFixture().revision);
  const after = database.load();

  assert.equal(after.localRevision, before.localRevision + 1);
  assertSingleSnapshotCommit(storage, after, (candidate) => {
    assert.deepEqual(candidate.plans.find(({ id }) => id === deleted.id), deleted);
    const operation = candidate.sync.outbox.at(-1);
    assertSyncOperation(operation);
    assert.equal(operation.entityType, ENTITY_TYPES.WORKOUT_PLAN);
    assert.equal(operation.action, 'delete');
    assert.equal(operation.payload, null);
  });
});

test('AC1: settings update queues only changed fields with the settings revision in the same A/B commit', () => {
  const { database, storage } = persistentRuntime();
  const service = createSettingsApplicationService({
    repository: createSettingsRepository({ database, now: () => NOW })
  });
  const before = database.load();

  const saved = service.updateSettings({ soundEnabled: false, defaultRestSeconds: 95 }, before.settings.revision);
  const after = database.load();

  assert.equal(after.localRevision, before.localRevision + 1);
  assertSingleSnapshotCommit(storage, after, (candidate) => {
    assert.deepEqual(candidate.settings, saved);
    const operation = candidate.sync.outbox.at(-1);
    assertSyncOperation(operation);
    assert.equal(operation.entityType, ENTITY_TYPES.USER_SETTINGS);
    assert.equal(operation.entityId, 'settings');
    assert.deepEqual(operation.payload, { defaultRestSeconds: 95, soundEnabled: false });
  });
});

test('AC1/AC6: active Session stays local, while terminal record creation queues one full record operation atomically', () => {
  const { database, storage } = persistentRuntime();
  const repository = createSessionRepository({ database });
  const plan = manualPlan();
  const started = repository.start({
    plan,
    sessionId: 'session_sync_terminal',
    originDeviceId: 'device_repository_sync',
    commandKey: 'start_sync_terminal',
    nowMs: NOW
  });
  const afterStart = database.load();
  assert.deepEqual(afterStart.sync.outbox, [], 'active Session must never enter normal V1 sync');
  storage.clearOperations();

  const terminal = repository.apply({
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: 'complete_sync_terminal',
    nowMs: NOW + 60_000,
    payload: { stepId: started.planSnapshot.steps[0].id }
  }, { originDeviceId: 'device_repository_sync' });
  const after = database.load();

  assert.equal(after.localRevision, afterStart.localRevision + 1);
  assertSingleSnapshotCommit(storage, after, (candidate) => {
    const record = candidate.records.find(({ sourceSessionId }) => sourceSessionId === terminal.session.id);
    assert.ok(record);
    const operation = candidate.sync.outbox.at(-1);
    assertSyncOperation(operation);
    assert.equal(operation.entityType, ENTITY_TYPES.TRAINING_RECORD);
    assert.equal(operation.entityId, record.id);
    assert.equal(operation.action, 'upsert');
    assert.deepEqual(operation.payload, record);
    assert.equal(candidate.sync.outbox.some(({ entityType }) => entityType === 'active_session'), false);
  });
});

test('AC1: record correction and delete replace legacy descriptors with complete operations in their own atomic commits', () => {
  const { database, storage } = persistentRuntime();
  const sessions = createSessionRepository({ database });
  const plan = manualPlan('plan_sync_record_changes');
  const started = sessions.start({
    plan,
    sessionId: 'session_sync_record_changes',
    originDeviceId: 'device_repository_sync',
    commandKey: 'start_sync_record_changes',
    nowMs: NOW
  });
  sessions.apply({
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: 'complete_sync_record_changes',
    nowMs: NOW + 60_000,
    payload: { stepId: started.planSnapshot.steps[0].id }
  }, { originDeviceId: 'device_repository_sync' });
  const records = createTrainingRecordRepository({ database });
  const initial = records.findById('record_session_sync_record_changes');
  storage.clearOperations();

  const corrected = records.correct({
    recordId: initial.id,
    expectedRevision: initial.revision,
    commandKey: 'correct_sync_record_changes',
    nowMs: NOW + 120_000,
    actualCorrections: [{
      stepId: initial.planSnapshot.steps[0].id,
      actualReps: 12
    }],
    feedback: {
      rpe: 7,
      weightBeforeKg: null,
      pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
      note: ''
    }
  });
  const afterCorrect = database.load();
  assertSingleSnapshotCommit(storage, afterCorrect, (candidate) => {
    const operation = candidate.sync.outbox.at(-1);
    assertSyncOperation(operation);
    assert.equal(operation.entityType, ENTITY_TYPES.TRAINING_RECORD);
    assert.equal(operation.action, 'upsert');
    assert.deepEqual(operation.payload, corrected);
  });

  storage.clearOperations();
  const beforeDelete = database.load();
  const deleted = records.delete({
    recordId: corrected.id,
    expectedRevision: corrected.revision,
    commandKey: 'delete_sync_record_changes',
    nowMs: NOW + 180_000
  });
  const afterDelete = database.load();
  assert.equal(afterDelete.localRevision, beforeDelete.localRevision + 1);
  assertSingleSnapshotCommit(storage, afterDelete, (candidate) => {
    assert.deepEqual(candidate.records.find(({ id }) => id === deleted.id), deleted);
    const operation = candidate.sync.outbox.at(-1);
    assertSyncOperation(operation);
    assert.equal(operation.entityType, ENTITY_TYPES.TRAINING_RECORD);
    assert.equal(operation.action, 'delete');
    assert.equal(operation.payload, null);
  });
});

test('Attack: repository retry after a failed atomic write keeps one stable command opId and leaves no half-state', () => {
  const storage = new StorageDouble();
  const database = createLocalDatabase({ storage, now: () => NOW });
  let repositoryNow = NOW;
  const repository = createPlanRepository({
    database,
    now: () => repositoryNow,
    deviceIdFactory: createRepositoryDeviceIdFactory({
      randomBytes: () => new Uint8Array(32).fill(0x42)
    })
  });
  const before = database.load();
  const requested = planFixture();
  storage.failNextWrite(SLOT_A, new Error('forced repository candidate failure'));

  assert.throws(
    () => repository.save(requested, 0),
    /forced repository candidate failure/
  );
  const failedCandidate = storage.operations.find(
    ({ type, key }) => type === 'write' && key === SLOT_A
  ).value;
  const failedOperation = failedCandidate.sync.outbox.at(-1);
  assertSyncOperation(failedOperation);
  assert.deepEqual(database.load(), before, 'failed candidate must expose neither domain nor operation');

  repositoryNow = NOW + 60_000;
  storage.clearOperations();
  const saved = repository.save(requested, 0);
  const after = database.load();
  const persistedOperation = after.sync.outbox.at(-1);

  assert.equal(persistedOperation.opId, failedOperation.opId, 'opId depends on command identity, not retry time');
  assert.notEqual(persistedOperation.createdAt, failedOperation.createdAt);
  assert.deepEqual(persistedOperation.payload, saved);
  assert.equal(after.sync.outbox.length, 1);
  assertSingleSnapshotCommit(storage, after, (candidate) => {
    assert.deepEqual(candidate.plans, after.plans);
    assert.deepEqual(candidate.sync.outbox, after.sync.outbox);
  });
});

test('Attack: replaying the terminal command is a zero-write no-op and never queues a second record operation', () => {
  const { database, storage } = persistentRuntime();
  const repository = createSessionRepository({ database });
  const plan = manualPlan('plan_sync_terminal_replay');
  const started = repository.start({
    plan,
    sessionId: 'session_sync_terminal_replay',
    originDeviceId: 'device_repository_sync',
    commandKey: 'start_sync_terminal_replay',
    nowMs: NOW
  });
  const command = {
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: 'complete_sync_terminal_replay',
    nowMs: NOW + 60_000,
    payload: { stepId: started.planSnapshot.steps[0].id }
  };
  repository.apply(command, { originDeviceId: 'device_repository_sync' });
  const beforeReplay = database.load();
  storage.clearOperations();

  const replay = repository.apply(command, { originDeviceId: 'device_repository_sync' });
  const afterReplay = database.load();

  assert.equal(replay.replayed, true);
  assert.deepEqual(afterReplay.sync.outbox, beforeReplay.sync.outbox);
  assert.equal(afterReplay.sync.outbox.length, 1);
  assert.deepEqual(
    storage.operations.filter(({ type }) => type === 'write'),
    [],
    'idempotent replay must not write a second domain state or operation'
  );
});
