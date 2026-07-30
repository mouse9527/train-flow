const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWorkoutApplicationService
} = require('../../miniprogram/application/workout-application-service');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createPlanRepository
} = require('../../miniprogram/domain/planning/plan-repository');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { computeChecksum } = require('../../miniprogram/utils/checksum');

const NOW = 1785717300000;
const SLOT_PREFIX = 'train_flow:v1:db:';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStorage() {
  const values = new Map();
  const writes = [];
  let failNextSlotWrite = false;
  return {
    values,
    writes,
    failNextSlotWrite() {
      failNextSlotWrite = true;
    },
    getStorageSync(key) {
      return clone(values.get(key));
    },
    setStorageSync(key, value) {
      writes.push({ key, value: clone(value) });
      if (failNextSlotWrite && (key === `${SLOT_PREFIX}a` || key === `${SLOT_PREFIX}b`)) {
        failNextSlotWrite = false;
        throw new Error('injected slot write failure');
      }
      values.set(key, clone(value));
    },
    removeStorageSync(key) {
      values.delete(key);
    }
  };
}

function snapshotWriteCount(storage) {
  return storage.writes.filter(({ key }) => key === `${SLOT_PREFIX}a` || key === `${SLOT_PREFIX}b`).length;
}

function createRuntime({ storage = createStorage(), deviceId = 'device_origin' } = {}) {
  const database = createLocalDatabase({ storage, now: () => NOW });
  const plans = createDefaultPlans({ now: () => NOW });
  if (database.load().plans.length === 0) {
    database.commit((draft) => {
      draft.plans.push(...clone(plans));
    });
  }
  const planRepository = createPlanRepository({ database, now: () => NOW });
  const sessionRepository = createSessionRepository({ database });
  const service = createWorkoutApplicationService({
    planRepository,
    sessionRepository,
    deviceId,
    idFactory: () => 'session_persisted',
    now: () => NOW
  });
  return { database, plans, planRepository, service, sessionRepository, storage };
}

function start(runtime, overrides = {}) {
  return runtime.service.startSession({
    planId: runtime.plans[0].id,
    commandKey: 'start_persisted',
    nowMs: NOW,
    ...overrides
  });
}

test('start snapshots the plan in one A/B commit and rejects a second active Session', () => {
  const runtime = createRuntime();
  const beforeWrites = snapshotWriteCount(runtime.storage);
  const session = start(runtime);

  assert.equal(snapshotWriteCount(runtime.storage) - beforeWrites, 1);
  assert.equal(runtime.database.load().activeSession.id, session.id);
  assert.deepEqual(runtime.database.load().activeSession, session);

  const writesBeforeCollision = snapshotWriteCount(runtime.storage);
  assert.throws(
    () => start(runtime, { commandKey: 'start_collision' }),
    (error) => error && error.code === 'SESSION_ACTIVE_EXISTS'
  );
  assert.equal(snapshotWriteCount(runtime.storage), writesBeforeCollision);

  runtime.database.commit((draft) => {
    draft.plans[0].title = 'edited after Session start';
    draft.plans[0].revision += 1;
    draft.plans[0].updatedAt += 1;
  });
  assert.notEqual(
    runtime.database.load().activeSession.planSnapshot.title,
    runtime.database.load().plans[0].title
  );
});

test('commands checkpoint exactly once while replay, stale revision and key collision perform zero writes', () => {
  const runtime = createRuntime();
  const initial = start(runtime);
  const stepId = initial.planSnapshot.steps[0].id;
  const command = {
    type: 'start_step',
    expectedSessionRevision: 1,
    commandKey: 'start_step_persisted',
    nowMs: NOW,
    payload: { stepId }
  };
  const before = snapshotWriteCount(runtime.storage);
  const result = runtime.service.execute(command);

  assert.equal(snapshotWriteCount(runtime.storage) - before, 1);
  assert.equal(result.replayed, false);
  assert.equal(result.session.timer.stepId, stepId);

  const afterSuccess = snapshotWriteCount(runtime.storage);
  const replay = runtime.service.execute(command);
  assert.equal(replay.replayed, true);
  assert.equal(snapshotWriteCount(runtime.storage), afterSuccess);

  assert.throws(
    () => runtime.service.execute({
      ...command,
      payload: { stepId: 'different_step' }
    }),
    (error) => error && error.code === 'SESSION_COMMAND_KEY_REUSED'
  );
  assert.throws(
    () => runtime.service.execute({
      type: 'checkpoint',
      expectedSessionRevision: 1,
      commandKey: 'stale',
      nowMs: NOW + 1_000,
      payload: { reason: 'hide' }
    }),
    (error) => error && error.code === 'SESSION_REVISION_CONFLICT'
  );
  assert.equal(snapshotWriteCount(runtime.storage), afterSuccess);
});

test('hide/unload and application rebuild restore the same checkpoint for the origin device', () => {
  const runtime = createRuntime();
  const initial = start(runtime);
  const stepId = initial.planSnapshot.steps[0].id;
  runtime.service.execute({
    type: 'start_step',
    expectedSessionRevision: 1,
    commandKey: 'start_lifecycle_timer',
    nowMs: NOW,
    payload: { stepId }
  });
  const hidden = runtime.service.checkpointOnHide({
    expectedSessionRevision: 2,
    commandKey: 'hide_checkpoint',
    nowMs: NOW + 2_000
  });
  const unloaded = runtime.service.checkpointOnUnload({
    expectedSessionRevision: 3,
    commandKey: 'unload_checkpoint',
    nowMs: NOW + 3_000
  });

  assert.equal(hidden.session.elapsedActiveSeconds, 2);
  assert.equal(unloaded.session.elapsedActiveSeconds, 3);
  assert.equal(unloaded.session.timer.remainingSecondsAtCheckpoint, 297);

  const rebuilt = createRuntime({ storage: runtime.storage });
  const restored = rebuilt.service.restoreOnStartup({
    expectedSessionRevision: 4,
    commandKey: 'startup_restore',
    nowMs: NOW + 4_000
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.session.id, initial.id);
  assert.equal(restored.session.elapsedActiveSeconds, 4);
  assert.equal(restored.session.timer.remainingSecondsAtCheckpoint, 296);
});

test('non-origin device cannot continue and restore returns a recoverable error without writes', () => {
  const runtime = createRuntime();
  start(runtime);
  const otherDevice = createRuntime({ storage: runtime.storage, deviceId: 'device_other' });
  const before = snapshotWriteCount(runtime.storage);
  const restored = otherDevice.service.restoreOnShow({
    expectedSessionRevision: 1,
    commandKey: 'other_device_show',
    nowMs: NOW + 1_000
  });

  assert.equal(restored.ok, false);
  assert.equal(restored.error.code, 'SESSION_DEVICE_MISMATCH');
  assert.equal(restored.error.recoverable, true);
  assert.equal(snapshotWriteCount(runtime.storage), before);
  assert.equal(runtime.database.load().activeSession.originDeviceId, 'device_origin');
});

test('corrupt Session snapshots return recoverable state and preserve every stored byte', () => {
  const runtime = createRuntime();
  const session = start(runtime);
  runtime.service.execute({
    type: 'start_step',
    expectedSessionRevision: 1,
    commandKey: 'corrupt_timer_source',
    nowMs: NOW,
    payload: { stepId: session.planSnapshot.steps[0].id }
  });
  runtime.service.checkpointOnHide({
    expectedSessionRevision: 2,
    commandKey: 'corrupt_timer_checkpoint',
    nowMs: NOW + 1_000
  });

  for (const key of [`${SLOT_PREFIX}a`, `${SLOT_PREFIX}b`]) {
    const snapshot = clone(runtime.storage.values.get(key));
    if (!snapshot || !snapshot.activeSession) continue;
    snapshot.activeSession.timer.stepId = 'wrong_step_identity';
    delete snapshot.checksum;
    snapshot.checksum = computeChecksum(snapshot);
    runtime.storage.values.set(key, snapshot);
  }
  const before = clone([...runtime.storage.values.entries()]);
  const recovered = runtime.service.restoreOnStartup({
    expectedSessionRevision: 3,
    commandKey: 'corrupt_restore',
    nowMs: NOW + 2_000
  });

  assert.equal(recovered.ok, false);
  assert.equal(recovered.error.code, 'SESSION_RECOVERY_REQUIRED');
  assert.equal(recovered.error.recoverable, true);
  assert.deepEqual([...runtime.storage.values.entries()], before);
});

test('storage failure exposes the error and leaves the previously committed Session readable', () => {
  const runtime = createRuntime();
  const session = start(runtime);
  const before = clone(runtime.database.load().activeSession);
  runtime.storage.failNextSlotWrite();

  assert.throws(
    () => runtime.service.execute({
      type: 'start_step',
      expectedSessionRevision: 1,
      commandKey: 'write_failure',
      nowMs: NOW,
      payload: { stepId: session.planSnapshot.steps[0].id }
    }),
    /injected slot write failure/
  );
  assert.deepEqual(runtime.database.load().activeSession, before);
});
