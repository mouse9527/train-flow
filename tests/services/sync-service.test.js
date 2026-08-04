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
const { DEFAULT_USER_SETTINGS } = require('../../miniprogram/utils/constants');
const { StorageDouble, clone } = require('../helpers/storage-double');
const {
  assertBootstrapResult,
  assertPurgePreparationResult,
  assertPullResult,
  assertPushResult,
  assertRemoteSyncProvider,
  createDeterministicRemoteSyncProvider
} = require('../../miniprogram/services/remote-sync-provider');
const { createSyncService } = require('../../miniprogram/services/sync-service');
const {
  createSyncApplicationService
} = require('../../miniprogram/application/sync-application-service');
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
    serverRevision: 12,
    payloadHash: computeChecksum(first.payload)
  }, {
    opId: 'op_unknown',
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: first.entityId,
    serverRevision: 13,
    payloadHash: 'b'.repeat(64)
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
      serverRevision: 1,
      payloadHash: computeChecksum(null)
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
      serverRevision: 11,
      payloadHash: computeChecksum(operation.payload)
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

test('Attack: local clear gives rebuilt plan, settings and record commands fresh opIds', async (t) => {
  function clearLocal(database) {
    const preview = database.prepareLocalPurge();
    return database.applyLocalPurge(preview.confirmationId);
  }

  await t.test('plan', () => {
    const { database } = persistentRuntime();
    const repository = createPlanRepository({ database, now: () => NOW });
    repository.save(planFixture(), 0);
    const beforeClear = database.load().sync.outbox.at(-1);

    clearLocal(database);
    repository.save(planFixture(), 0);
    const afterClear = database.load().sync.outbox.at(-1);

    assert.notEqual(afterClear.opId, beforeClear.opId);
  });

  await t.test('settings', () => {
    const { database } = persistentRuntime();
    const service = createSettingsApplicationService({
      repository: createSettingsRepository({ database, now: () => NOW })
    });
    service.updateSettings({ soundEnabled: false }, 1);
    const beforeClear = database.load().sync.outbox.at(-1);

    clearLocal(database);
    service.updateSettings({ soundEnabled: false }, 1);
    const afterClear = database.load().sync.outbox.at(-1);

    assert.notEqual(afterClear.opId, beforeClear.opId);
  });

  await t.test('terminal record', () => {
    const { database } = persistentRuntime();
    const sessions = createSessionRepository({ database });
    function completeRecord() {
      const plan = manualPlan('plan_clear_record');
      const started = sessions.start({
        plan,
        sessionId: 'session_clear_record',
        originDeviceId: 'device_repository_sync',
        commandKey: 'start_clear_record',
        nowMs: NOW
      });
      sessions.apply({
        type: 'complete_step',
        expectedSessionRevision: started.sessionRevision,
        commandKey: 'complete_clear_record',
        nowMs: NOW + 60_000,
        payload: { stepId: started.planSnapshot.steps[0].id }
      }, { originDeviceId: 'device_repository_sync' });
      database.commit((draft) => {
        draft.activeSession = null;
      });
      return database.load().sync.outbox.at(-1);
    }

    const beforeClear = completeRecord();
    clearLocal(database);
    const afterClear = completeRecord();

    assert.notEqual(afterClear.opId, beforeClear.opId);
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

test('AC2: RemoteSyncProvider contract is closed and requires bootstrap, push, pull, preparePurge and purge', () => {
  assert.throws(
    () => assertRemoteSyncProvider({ bootstrap() {}, push() {}, pull() {}, purge() {} }),
    (error) => error && error.code === 'REMOTE_SYNC_PROVIDER_INVALID'
  );
  assert.throws(
    () => assertBootstrapResult({ cursor: null, serverTime: NOW, ownerId: 'must-not-leak' }),
    (error) => error && error.code === 'REMOTE_SYNC_RESPONSE_INVALID'
  );
  assert.throws(
    () => assertPushResult({ accepted: [], rejected: [], conflicts: [], implicitAccepted: true }),
    (error) => error && error.code === 'REMOTE_SYNC_RESPONSE_INVALID'
  );
  assert.throws(
    () => assertPullResult({ changes: [], nextCursor: null, hasMore: false, extra: true }),
    (error) => error && error.code === 'REMOTE_SYNC_RESPONSE_INVALID'
  );
});

test('AC2/AC3: deterministic fake provider supports idempotent push, cursor pull and purge without network', async () => {
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  assertRemoteSyncProvider(provider);
  const bootstrap = await provider.bootstrap({ deviceId: 'device_sync_test' });
  assertBootstrapResult(bootstrap);
  assert.deepEqual(bootstrap, { cursor: null, serverTime: NOW });

  const draft = newDraft();
  const operation = queuePlan(draft, { intentKey: 'provider-idempotent' });
  const firstPush = await provider.push({ operations: [operation] });
  assertPushResult(firstPush);
  assert.equal(firstPush.accepted.length, 1);
  assert.deepEqual(firstPush.rejected, []);
  assert.deepEqual(firstPush.conflicts, []);

  const retry = {
    ...clone(operation),
    attemptCount: 2,
    lastAttemptAt: NOW + 2_000
  };
  const retryPush = await provider.push({ operations: [retry] });
  assert.deepEqual(retryPush, firstPush, 'same opId retry must reuse the exact receipt');

  const firstPage = await provider.pull({ cursor: null, limit: 1 });
  assertPullResult(firstPage);
  assert.equal(firstPage.changes.length, 1);
  assert.equal(firstPage.changes[0].entityId, operation.entityId);
  assert.equal(firstPage.hasMore, false);
  assert.equal(typeof firstPage.nextCursor, 'string');

  const prepared = await provider.preparePurge({ deviceId: 'device_sync_test' });
  assertPurgePreparationResult(prepared);
  const purged = await provider.purge({
    deviceId: 'device_sync_test',
    confirmationToken: prepared.confirmationToken
  });
  assert.deepEqual(purged, { purgedAt: NOW });
  assert.deepEqual(
    await provider.pull({ cursor: null, limit: 10 }),
    { changes: [], nextCursor: null, hasMore: false }
  );
});

test('AC2/AC3: settings patch push materializes one canonical remote entity and same-revision pull replays its hash', async () => {
  const { database } = persistentRuntime();
  const settings = createSettingsApplicationService({
    repository: createSettingsRepository({ database, now: () => NOW })
  });
  settings.updateSettings({ soundEnabled: false, defaultRestSeconds: 95 }, 1);
  const localOperation = clone(database.load().sync.outbox[0]);
  assert.deepEqual(localOperation.payload, { defaultRestSeconds: 95, soundEnabled: false });
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  const service = createSyncService({ database, provider, now: () => NOW + 5_000 });

  await service.pushPending();
  const afterPush = database.load();
  const remotePage = await provider.pull({ cursor: null, limit: 10 });
  const remoteSettings = remotePage.changes[0];

  assert.deepEqual(remoteSettings.payload, {
    ...DEFAULT_USER_SETTINGS,
    soundEnabled: false,
    defaultRestSeconds: 95,
    revision: 2
  });
  assert.equal(
    afterPush.sync.replicas[entityKey(ENTITY_TYPES.USER_SETTINGS, 'settings')].payloadHash,
    computeChecksum(remoteSettings.payload)
  );

  const pull = await service.pullNextPage({ limit: 10 });
  assert.equal(pull.replayed, 1);
  assert.equal(database.load().sync.cursor, 'cursor_1');
  assert.deepEqual(database.load().settings, remoteSettings.payload);
});

test('AC2/AC4: fake provider coalesces repeated entity revisions inside one raw page while cursor consumes the full log', async () => {
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  const remoteDraft = newDraft();
  const first = queuePlan(remoteDraft, { intentKey: 'coalesce-first', title: 'Remote revision one' });
  const firstPush = await provider.push({ operations: [first] });
  applyAcceptedOperations(remoteDraft, firstPush.accepted);
  remoteDraft.localRevision += 1;
  const second = queuePlan(remoteDraft, {
    intentKey: 'coalesce-second',
    title: 'Remote revision two',
    createdAt: NOW + 1
  });
  await provider.push({ operations: [second] });

  const page = await provider.pull({ cursor: null, limit: 10 });
  assert.equal(page.changes.length, 1);
  assert.equal(page.changes[0].serverRevision, 2);
  assert.equal(page.changes[0].payload.title, 'Remote revision two');
  assert.equal(page.nextCursor, 'cursor_2');
  assert.equal(page.hasMore, false);

  const { database } = persistentRuntime();
  const service = createSyncService({ database, provider, now: () => NOW + 5_000 });
  const pulled = await service.pullNextPage({ limit: 10 });
  assert.equal(pulled.applied, 1);
  assert.equal(database.load().sync.cursor, 'cursor_2');
  assert.equal(database.load().plans[0].title, 'Remote revision two');
});

function savedPlan(database, { id, trainingDate, title }) {
  return createPlanRepository({ database, now: () => NOW }).save({
    ...clone(planFixture()),
    id,
    trainingDate,
    title,
    templateSource: null
  }, 0);
}

function remotePlanEnvelope(operation, { serverRevision = 7, title = 'Remote winner' } = {}) {
  return {
    ownerId: 'owner_fake_sync',
    entityType: operation.entityType,
    entityId: operation.entityId,
    serverRevision,
    schemaVersion: 1,
    payload: { ...clone(operation.payload), title },
    deleted: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW + 1,
    sourceDeviceId: 'device_remote_sync'
  };
}

test('AC3/AC6: push removes only exact accepted operations and preserves rejected, conflict and unlisted operations', async () => {
  const { database } = persistentRuntime();
  savedPlan(database, { id: 'plan_push_accepted', trainingDate: '2026-09-10', title: 'Accepted' });
  savedPlan(database, { id: 'plan_push_rejected', trainingDate: '2026-09-11', title: 'Rejected' });
  savedPlan(database, { id: 'plan_push_conflict', trainingDate: '2026-09-12', title: 'Conflict' });
  savedPlan(database, { id: 'plan_push_unlisted', trainingDate: '2026-09-15', title: 'Unlisted' });
  const before = database.load();
  const [acceptedOperation, rejectedOperation, conflictOperation, unlistedOperation] = before.sync.outbox;
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  provider.rejectOperation(rejectedOperation.opId, 'REMOTE_POLICY_REJECTED');
  provider.conflictOperation(conflictOperation.opId, remotePlanEnvelope(conflictOperation));
  const fakePush = provider.push.bind(provider);
  provider.push = async (request) => {
    const result = await fakePush(request);
    result.accepted = result.accepted.filter(({ opId }) => opId !== unlistedOperation.opId);
    return result;
  };
  const service = createSyncService({ database, provider, now: () => NOW + 5_000 });

  const result = await service.pushPending();
  const after = database.load();

  assert.deepEqual(result.acceptedOpIds, [acceptedOperation.opId]);
  assert.deepEqual(result.unknownAcceptedOpIds, []);
  assert.deepEqual(after.sync.outbox.map(({ opId }) => opId), [
    rejectedOperation.opId,
    conflictOperation.opId,
    unlistedOperation.opId
  ]);
  assert.equal(after.sync.conflicts.length, 1);
  assert.equal(after.sync.conflicts[0].local.opId, conflictOperation.opId);
  assert.equal(after.sync.conflicts[0].remote.serverRevision, 7);
  assert.equal(after.sync.conflicts[0].remote.ownerId, undefined);
  assert.equal(after.sync.conflicts[0].remote.sourceDeviceId, undefined);
  assert.deepEqual(after.sync.replicas[entityKey(acceptedOperation.entityType, acceptedOperation.entityId)], {
    entityType: acceptedOperation.entityType,
    entityId: acceptedOperation.entityId,
    serverRevision: 1,
    payloadHash: computeChecksum(acceptedOperation.payload),
    deleted: false
  });
});

test('AC3: duplicate accepted receipts fail closed without replica write or partial outbox removal', async () => {
  const { database } = persistentRuntime();
  savedPlan(database, { id: 'plan_push_duplicate_receipt', trainingDate: '2026-09-16', title: 'Duplicate' });
  const original = clone(database.load().sync.outbox[0]);
  const fake = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  const provider = {
    bootstrap: fake.bootstrap.bind(fake),
    pull: fake.pull.bind(fake),
    preparePurge: fake.preparePurge.bind(fake),
    purge: fake.purge.bind(fake),
    async push(request) {
      const result = await fake.push(request);
      return { ...result, accepted: [result.accepted[0], clone(result.accepted[0])] };
    }
  };
  const service = createSyncService({ database, provider, now: () => NOW + 5_000 });

  await assert.rejects(
    () => service.pushPending(),
    (error) => error && error.code === 'REMOTE_SYNC_RESPONSE_INVALID'
  );
  const after = database.load();
  assert.equal(after.sync.outbox.length, 1);
  assert.equal(after.sync.outbox[0].opId, original.opId);
  assert.deepEqual(after.sync.outbox[0].payload, original.payload);
  assert.equal(after.sync.outbox[0].baseServerRevision, original.baseServerRevision);
  assert.equal(after.sync.outbox[0].attemptCount, 1);
  assert.deepEqual(after.sync.replicas, {});
});

test('AC3: lost push response keeps semantic operation facts and retries the same opId until the exact receipt commits', async () => {
  const { database } = persistentRuntime();
  savedPlan(database, { id: 'plan_push_lost_response', trainingDate: '2026-09-13', title: 'Lost response' });
  const original = clone(database.load().sync.outbox[0]);
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  provider.loseNextPushResponse();
  let attemptNow = NOW + 5_000;
  const service = createSyncService({ database, provider, now: () => attemptNow });

  await assert.rejects(
    () => service.pushPending(),
    (error) => error && error.code === 'SYNC_RESPONSE_LOST'
  );
  const afterLost = database.load().sync.outbox[0];
  assert.equal(afterLost.opId, original.opId);
  assert.deepEqual(afterLost.payload, original.payload);
  assert.equal(afterLost.baseServerRevision, original.baseServerRevision);
  assert.equal(afterLost.attemptCount, 1);

  attemptNow += 1_000;
  const retried = await service.pushPending();
  assert.deepEqual(retried.acceptedOpIds, [original.opId]);
  assert.deepEqual(database.load().sync.outbox, []);
  assert.deepEqual(
    provider.calls.push.map(({ operations }) => operations[0].opId),
    [original.opId, original.opId]
  );
  assert.deepEqual(provider.calls.push[1].operations[0].payload, original.payload);
  assert.equal(provider.calls.push[1].operations[0].baseServerRevision, original.baseServerRevision);
});

test('AC3: accepted head rebases the next same-entity operation without changing its opId', async () => {
  const { database } = persistentRuntime();
  const repository = createPlanRepository({ database, now: () => NOW });
  const first = repository.save({
    ...clone(planFixture()),
    id: 'plan_push_rebase',
    trainingDate: '2026-09-14',
    title: 'First'
  }, 0);
  repository.save({ ...first, title: 'Second' }, first.revision);
  const before = database.load();
  const [head, next] = before.sync.outbox;
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  const service = createSyncService({ database, provider, now: () => NOW + 5_000 });

  await service.pushPending();
  const after = database.load();

  assert.equal(after.sync.outbox.length, 1);
  assert.equal(after.sync.outbox[0].opId, next.opId);
  assert.equal(after.sync.outbox[0].baseServerRevision, 1);
  assert.notEqual(after.sync.outbox[0].opId, head.opId);
});

test('Attack: push response cannot accept an outbox operation that was not in the attempted request', async () => {
  const { database, storage } = persistentRuntime();
  const repository = createPlanRepository({ database, now: () => NOW });
  const first = repository.save({
    ...clone(planFixture()),
    id: 'plan_unattempted_receipt',
    trainingDate: '2026-09-17',
    title: 'First queued edit'
  }, 0);
  repository.save({ ...first, title: 'Second queued edit' }, first.revision);
  const [head, unattemptedNext] = database.load().sync.outbox;
  let afterAttempt = null;
  const fake = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  const provider = {
    bootstrap: fake.bootstrap.bind(fake),
    pull: fake.pull.bind(fake),
    preparePurge: fake.preparePurge.bind(fake),
    purge: fake.purge.bind(fake),
    async push(request) {
      assert.deepEqual(request.operations.map(({ opId }) => opId), [head.opId]);
      afterAttempt = database.load();
      return {
        accepted: [{
          opId: head.opId,
          entityType: head.entityType,
          entityId: head.entityId,
          serverRevision: 1,
          payloadHash: computeChecksum(head.payload)
        }, {
          opId: unattemptedNext.opId,
          entityType: unattemptedNext.entityType,
          entityId: unattemptedNext.entityId,
          serverRevision: 2,
          payloadHash: computeChecksum(unattemptedNext.payload)
        }],
        rejected: [],
        conflicts: []
      };
    }
  };
  storage.clearOperations();
  const service = createSyncService({ database, provider, now: () => NOW + 5_000 });

  await assert.rejects(
    () => service.pushPending(),
    (error) => error && error.code === 'SYNC_PUSH_UNATTEMPTED_RECEIPT'
  );
  assert.deepEqual(database.load(), afterAttempt, 'unbound receipt must not apply response-stage writes');
  assert.equal(storage.operations.filter(({ type }) => type === 'write').length, 2);
});

function scriptedPullProvider(result) {
  return {
    async bootstrap() { return { cursor: null, serverTime: NOW }; },
    async push() { return { accepted: [], rejected: [], conflicts: [] }; },
    async pull() { return clone(result); },
    async preparePurge() { return { confirmationToken: 'purge_test', expiresAt: NOW + 300000 }; },
    async purge() { return { purgedAt: NOW }; }
  };
}

test('AC4: pull applies a fully validated page, replicas and opaque nextCursor in one A/B commit', async () => {
  const remote = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  const remoteDraft = newDraft();
  const firstPlan = { ...clone(planFixture()), id: 'plan_pull_first', trainingDate: '2026-09-20' };
  const secondPlan = { ...clone(planFixture()), id: 'plan_pull_second', trainingDate: '2026-09-21' };
  const firstOperation = appendSyncOperation(remoteDraft, {
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: firstPlan.id,
    action: 'upsert',
    payload: firstPlan
  }, { createdAt: NOW, intentKey: 'pull-first', deviceIdFactory: () => 'device_remote_pull' });
  const secondOperation = appendSyncOperation(remoteDraft, {
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: secondPlan.id,
    action: 'upsert',
    payload: secondPlan
  }, { createdAt: NOW + 1, intentKey: 'pull-second', deviceIdFactory: () => 'unused' });
  await remote.push({ operations: [firstOperation, secondOperation] });
  const { database, storage } = persistentRuntime();
  const before = database.load();
  const service = createSyncService({ database, provider: remote, now: () => NOW + 5_000 });

  const result = await service.pullNextPage({ limit: 10 });
  const after = database.load();

  assert.equal(result.applied, 2);
  assert.equal(after.localRevision, before.localRevision + 1);
  assert.equal(after.sync.cursor, 'cursor_2');
  assert.deepEqual(after.plans.map(({ id }) => id).sort(), ['plan_pull_first', 'plan_pull_second']);
  assert.equal(after.sync.replicas[entityKey(ENTITY_TYPES.WORKOUT_PLAN, firstPlan.id)].serverRevision, 1);
  assert.equal(after.sync.replicas[entityKey(ENTITY_TYPES.WORKOUT_PLAN, secondPlan.id)].serverRevision, 1);
  assertSingleSnapshotCommit(storage, after, (candidate) => {
    assert.equal(candidate.sync.cursor, 'cursor_2');
    assert.equal(candidate.plans.length, 2);
  });
});

test('AC4/AC6: invalid, duplicate, stale or active-session pull changes fail before any write or cursor advance', async (t) => {
  const baseOperation = queuePlan(newDraft(), { intentKey: 'pull-invalid-base' });
  const valid = remotePlanEnvelope(baseOperation, { serverRevision: 4 });
  const cases = [{
    name: 'invalid second change',
    changes: [valid, { ...clone(valid), entityId: 'plan_payload_identity_mismatch' }]
  }, {
    name: 'duplicate entity in one page',
    changes: [valid, { ...clone(valid), serverRevision: 5 }]
  }, {
    name: 'active Session entity',
    changes: [{ ...clone(valid), entityType: 'active_session', entityId: 'session_must_stay_local' }]
  }, {
    name: 'invalid tombstone timestamp',
    changes: [{
      ...clone(valid),
      payload: null,
      deleted: true,
      deletedAt: NOW,
      updatedAt: NOW + 1
    }]
  }, {
    name: 'missing trusted owner envelope fact',
    changes: [{ ...clone(valid), ownerId: '' }]
  }];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { database, storage } = persistentRuntime();
      const before = database.load();
      storage.clearOperations();
      const service = createSyncService({
        database,
        provider: scriptedPullProvider({ changes: scenario.changes, nextCursor: 'opaque_next', hasMore: false }),
        now: () => NOW + 5_000
      });

      await assert.rejects(() => service.pullNextPage({ limit: 10 }));
      assert.deepEqual(database.load(), before);
      assert.deepEqual(storage.operations.filter(({ type }) => type === 'write'), []);
    });
  }

  await t.test('stale server revision', async () => {
    const { database, storage } = persistentRuntime();
    database.commit((draft) => {
      draft.sync.replicas[entityKey(baseOperation.entityType, baseOperation.entityId)] = {
        entityType: baseOperation.entityType,
        entityId: baseOperation.entityId,
        serverRevision: 5,
        payloadHash: computeChecksum(baseOperation.payload),
        deleted: false
      };
    });
    const before = database.load();
    storage.clearOperations();
    const service = createSyncService({
      database,
      provider: scriptedPullProvider({ changes: [valid], nextCursor: 'opaque_stale', hasMore: false }),
      now: () => NOW + 5_000
    });

    await assert.rejects(
      () => service.pullNextPage({ limit: 10 }),
      (error) => error && error.code === 'SYNC_PULL_REVISION_STALE'
    );
    assert.deepEqual(database.load(), before);
    assert.deepEqual(storage.operations.filter(({ type }) => type === 'write'), []);
  });
});

test('AC4: pull storage failure and exact page replay preserve the committed cursor boundary', async () => {
  const operation = queuePlan(newDraft(), { intentKey: 'pull-atomic-failure' });
  const remote = remotePlanEnvelope(operation, { serverRevision: 1 });
  const page = { changes: [remote], nextCursor: 'opaque_page_1', hasMore: false };
  const { database, storage } = persistentRuntime();
  const service = createSyncService({
    database,
    provider: scriptedPullProvider(page),
    now: () => NOW + 5_000
  });
  const beforeFailure = database.load();
  storage.failNextWrite(SLOT_B, new Error('forced pull page storage failure'));

  await assert.rejects(() => service.pullNextPage({ limit: 10 }), /forced pull page storage failure/);
  assert.deepEqual(database.load(), beforeFailure);

  storage.clearOperations();
  await service.pullNextPage({ limit: 10 });
  const committed = database.load();
  assert.equal(committed.sync.cursor, 'opaque_page_1');
  storage.clearOperations();

  const replay = await service.pullNextPage({ limit: 10 });
  assert.equal(replay.replayed, 1);
  assert.deepEqual(database.load(), committed);
  assert.deepEqual(storage.operations.filter(({ type }) => type === 'write'), []);
});

test('AC4/AC6: pull rebases settings fields explicitly while preserving the local opId and remote replica fact', async () => {
  const { database } = persistentRuntime();
  const settings = createSettingsApplicationService({
    repository: createSettingsRepository({ database, now: () => NOW })
  });
  settings.updateSettings({ soundEnabled: false, vibrationEnabled: false }, 1);
  const before = database.load();
  const localOperation = clone(before.sync.outbox[0]);
  const remoteSettings = {
    ...DEFAULT_USER_SETTINGS,
    soundEnabled: true,
    vibrationEnabled: true,
    defaultRestSeconds: 90,
    revision: 5
  };
  const remote = {
    ownerId: 'owner_fake_sync',
    entityType: ENTITY_TYPES.USER_SETTINGS,
    entityId: 'settings',
    serverRevision: 3,
    schemaVersion: 1,
    payload: remoteSettings,
    deleted: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW + 1,
    sourceDeviceId: 'device_remote_settings'
  };
  const service = createSyncService({
    database,
    provider: scriptedPullProvider({ changes: [remote], nextCursor: 'opaque_settings', hasMore: false }),
    now: () => NOW + 5_000
  });

  await service.pullNextPage({ limit: 10 });
  const after = database.load();

  assert.equal(after.settings.soundEnabled, false);
  assert.equal(after.settings.vibrationEnabled, false);
  assert.equal(after.settings.defaultRestSeconds, 90);
  assert.equal(after.settings.revision, 6);
  assert.equal(after.sync.outbox[0].opId, localOperation.opId);
  assert.equal(after.sync.outbox[0].baseServerRevision, 3);
  assert.equal(after.sync.conflicts.at(-1).status, 'rebased');
  assert.equal(after.sync.replicas[entityKey(ENTITY_TYPES.USER_SETTINGS, 'settings')].serverRevision, 3);
});

test('AC2/AC4: application bootstrap and purge are reachable without letting bootstrap advance the pull cursor', async () => {
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  const remoteDraft = newDraft();
  const operation = queuePlan(remoteDraft, { intentKey: 'bootstrap-cursor-source' });
  await provider.push({ operations: [operation] });
  const { database } = persistentRuntime();
  const before = database.load();
  const application = createSyncApplicationService({
    syncService: createSyncService({ database, provider, now: () => NOW + 5_000 })
  });

  const bootstrap = await application.bootstrap();
  assert.equal(bootstrap.cursor, 'cursor_1');
  assert.equal(database.load().sync.cursor, before.sync.cursor, 'bootstrap cursor is advisory only');
  assert.deepEqual(provider.calls.bootstrap, [{ deviceId: before.install.deviceId }]);

  const prepared = await application.prepareRemotePurge();
  const purge = await application.purgeRemote({ confirmationToken: prepared.confirmationToken });
  assert.deepEqual(purge, { purgedAt: NOW });
  assert.deepEqual(database.load(), before, 'remote purge must not silently mutate local data');
  assert.deepEqual(provider.calls.preparePurge, [{ deviceId: before.install.deviceId }]);
  assert.deepEqual(provider.calls.purge, [{
    deviceId: before.install.deviceId,
    confirmationToken: '[redacted]'
  }]);
});

test('AC2/AC4: application synchronizeOnce pushes then drains opaque pull pages through SyncService only', async () => {
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  const remoteDraft = newDraft();
  const first = { ...clone(planFixture()), id: 'plan_application_pull_1', trainingDate: '2026-09-22' };
  const second = { ...clone(planFixture()), id: 'plan_application_pull_2', trainingDate: '2026-09-23' };
  const firstOperation = appendSyncOperation(remoteDraft, {
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: first.id,
    action: 'upsert',
    payload: first
  }, { createdAt: NOW, intentKey: 'application-pull-1', deviceIdFactory: () => 'device_remote_application' });
  const secondOperation = appendSyncOperation(remoteDraft, {
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: second.id,
    action: 'upsert',
    payload: second
  }, { createdAt: NOW + 1, intentKey: 'application-pull-2', deviceIdFactory: () => 'unused' });
  await provider.push({ operations: [firstOperation, secondOperation] });
  const { database } = persistentRuntime();
  const application = createSyncApplicationService({
    syncService: createSyncService({ database, provider, now: () => NOW + 5_000 })
  });

  const result = await application.synchronizeOnce({ pullLimit: 1, maxPullPages: 3 });

  assert.equal(result.pullPages.length, 2);
  assert.equal(result.pullPages[0].hasMore, true);
  assert.equal(result.pullPages[1].hasMore, false);
  assert.equal(database.load().sync.cursor, 'cursor_2');
  assert.deepEqual(database.load().plans.map(({ id }) => id).sort(), [first.id, second.id]);
});

test('AC6: push settings conflict uses field rebase instead of a generic unresolved conflict', async () => {
  const { database } = persistentRuntime();
  const settings = createSettingsApplicationService({
    repository: createSettingsRepository({ database, now: () => NOW })
  });
  settings.updateSettings({ soundEnabled: false }, 1);
  const localOperation = clone(database.load().sync.outbox[0]);
  const remoteSettings = {
    ...DEFAULT_USER_SETTINGS,
    soundEnabled: true,
    defaultRestSeconds: 90,
    revision: 5
  };
  const remote = {
    ownerId: 'owner_fake_sync',
    entityType: ENTITY_TYPES.USER_SETTINGS,
    entityId: 'settings',
    serverRevision: 3,
    schemaVersion: 1,
    payload: remoteSettings,
    deleted: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW + 1,
    sourceDeviceId: 'device_remote_settings_conflict'
  };
  const provider = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
  provider.conflictOperation(localOperation.opId, remote);
  const service = createSyncService({ database, provider, now: () => NOW + 5_000 });

  await service.pushPending();
  const after = database.load();

  assert.equal(after.settings.soundEnabled, false);
  assert.equal(after.settings.defaultRestSeconds, 90);
  assert.equal(after.settings.revision, 6);
  assert.equal(after.sync.outbox[0].opId, localOperation.opId);
  assert.equal(after.sync.outbox[0].baseServerRevision, 3);
  assert.equal(after.sync.conflicts.at(-1).status, 'rebased');
  assert.equal(after.sync.conflicts.at(-1).remote.serverRevision, 3);
  assert.equal(after.sync.replicas[entityKey(ENTITY_TYPES.USER_SETTINGS, 'settings')].serverRevision, 3);
});

test('AC2/AC4: provider throws and invalid bootstrap, pull or purge responses leave local storage untouched', async (t) => {
  const cases = [{
    name: 'bootstrap throws',
    invoke(service) { return service.bootstrap(); },
    override: { async bootstrap() { throw new Error('bootstrap unavailable'); } },
    pattern: /bootstrap unavailable/
  }, {
    name: 'bootstrap returns an invalid closed response',
    invoke(service) { return service.bootstrap(); },
    override: { async bootstrap() { return { cursor: null, serverTime: NOW, extra: true }; } },
    code: 'REMOTE_SYNC_RESPONSE_INVALID'
  }, {
    name: 'pull throws',
    invoke(service) { return service.pullNextPage({ limit: 10 }); },
    override: { async pull() { throw new Error('pull unavailable'); } },
    pattern: /pull unavailable/
  }, {
    name: 'pull returns an invalid closed response',
    invoke(service) { return service.pullNextPage({ limit: 10 }); },
    override: { async pull() { return { changes: [], nextCursor: null, hasMore: false, extra: true }; } },
    code: 'REMOTE_SYNC_RESPONSE_INVALID'
  }, {
    name: 'purge throws',
    invoke(service) { return service.purgeRemote({ confirmationToken: 'confirm_remote_purge' }); },
    override: { async purge() { throw new Error('purge unavailable'); } },
    pattern: /purge unavailable/
  }, {
    name: 'purge returns an invalid closed response',
    invoke(service) { return service.purgeRemote({ confirmationToken: 'confirm_remote_purge' }); },
    override: { async purge() { return { purgedAt: NOW, extra: true }; } },
    code: 'REMOTE_SYNC_RESPONSE_INVALID'
  }];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const { database, storage } = persistentRuntime();
      const before = database.load();
      storage.clearOperations();
      const fake = createDeterministicRemoteSyncProvider({ ownerId: 'owner_fake_sync', now: () => NOW });
      const provider = { ...fake, ...scenario.override };
      const service = createSyncService({ database, provider, now: () => NOW + 5_000 });

      await assert.rejects(
        () => scenario.invoke(service),
        scenario.code ? (error) => error && error.code === scenario.code : scenario.pattern
      );
      assert.deepEqual(database.load(), before);
      assert.deepEqual(storage.operations.filter(({ type }) => type === 'write'), []);
    });
  }
});

test('AC2: application commands use closed schemas before invoking SyncService', async () => {
  const calls = [];
  let getterExecuted = false;
  const application = createSyncApplicationService({
    syncService: {
      async bootstrap() { calls.push('bootstrap'); return { cursor: null, serverTime: NOW }; },
      getSanitizedState() { return { enabled: true, code: 'waiting' }; },
      previewEnable() { return { baselineLocalRevision: 1, scope: {} }; },
      async pushPending() { calls.push('pushPending'); return {}; },
      async pullNextPage() { calls.push('pullNextPage'); return { hasMore: false, nextCursor: null }; },
      async prepareRemotePurge() { calls.push('prepareRemotePurge'); return { confirmationToken: 'purge_test', expiresAt: NOW + 300000 }; },
      async purgeRemote() { calls.push('purgeRemote'); return { purgedAt: NOW }; },
      recordFailure() { return { enabled: true, code: 'failure' }; },
      setEnabled() {}
    }
  });

  assert.throws(() => application.bootstrap({ unexpected: true }), { code: 'SYNC_APPLICATION_INVALID' });
  assert.throws(() => application.pushPending(null), { code: 'SYNC_APPLICATION_INVALID' });
  assert.throws(
    () => application.pullNextPage({ limit: 10, unexpected: true }),
    { code: 'SYNC_APPLICATION_INVALID' }
  );
  assert.throws(
    () => application.prepareRemotePurge({ unexpected: true }),
    { code: 'SYNC_APPLICATION_INVALID' }
  );
  assert.throws(
    () => application.purgeRemote({ confirmationToken: 'confirm', unexpected: true }),
    { code: 'SYNC_APPLICATION_INVALID' }
  );
  assert.throws(
    () => application.synchronizeOnce({ pullLimit: 10, unexpected: true }),
    { code: 'SYNC_APPLICATION_INVALID' }
  );
  const accessorCommand = {};
  Object.defineProperty(accessorCommand, 'confirmationToken', {
    enumerable: true,
    get() {
      getterExecuted = true;
      return 'confirm';
    }
  });
  assert.throws(() => application.purgeRemote(accessorCommand), { code: 'SYNC_APPLICATION_INVALID' });
  assert.equal(getterExecuted, false, 'closed command validation must not execute accessor input');
  assert.deepEqual(calls, []);
});

test('AC2: application facade rejects overlapping remote commands and releases its instance lock', async () => {
  let releasePush;
  const pushGate = new Promise((resolve) => { releasePush = resolve; });
  const calls = [];
  const application = createSyncApplicationService({
    syncService: {
      async bootstrap() { calls.push('bootstrap'); return { cursor: null, serverTime: NOW }; },
      getSanitizedState() { return { enabled: true, code: 'waiting' }; },
      previewEnable() { return { baselineLocalRevision: 1, scope: {} }; },
      async pushPending() { calls.push('pushPending'); return pushGate; },
      async pullNextPage() { calls.push('pullNextPage'); return { hasMore: false, nextCursor: null }; },
      async prepareRemotePurge() { calls.push('prepareRemotePurge'); return { confirmationToken: 'purge_test', expiresAt: NOW + 300000 }; },
      async purgeRemote() { calls.push('purgeRemote'); return { purgedAt: NOW }; },
      recordFailure() { return { enabled: true, code: 'failure' }; },
      setEnabled() {}
    }
  });

  const first = application.pushPending();
  await assert.rejects(() => application.bootstrap(), { code: 'SYNC_APPLICATION_BUSY' });
  assert.deepEqual(calls, ['pushPending']);

  releasePush({ acceptedOpIds: [] });
  await first;
  await application.bootstrap();
  assert.deepEqual(calls, ['pushPending', 'bootstrap']);
});
