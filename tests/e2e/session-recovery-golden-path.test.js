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

const NOW = 1785717300000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStorage() {
  const values = new Map();
  return {
    getStorageSync(key) {
      return clone(values.get(key));
    },
    setStorageSync(key, value) {
      values.set(key, clone(value));
    },
    removeStorageSync(key) {
      values.delete(key);
    }
  };
}

function createRuntime(storage) {
  const database = createLocalDatabase({ storage, now: () => NOW });
  const planRepository = createPlanRepository({ database, now: () => NOW });
  const sessionRepository = createSessionRepository({ database });
  const service = createWorkoutApplicationService({
    planRepository,
    sessionRepository,
    deviceId: 'device_e2e',
    idFactory: () => 'session_e2e',
    now: () => NOW
  });
  return { database, service };
}

test('golden path: start, checkpoint on unload, restart and recover the same workout position', () => {
  const storage = createStorage();
  const firstRuntime = createRuntime(storage);
  const plans = createDefaultPlans({ now: () => NOW });
  firstRuntime.database.commit((draft) => {
    draft.plans.push(...clone(plans));
  });

  const started = firstRuntime.service.startSession({
    planId: plans[0].id,
    commandKey: 'e2e_start',
    nowMs: NOW
  });
  const stepId = started.planSnapshot.steps[0].id;
  firstRuntime.service.execute({
    type: 'start_step',
    expectedSessionRevision: 1,
    commandKey: 'e2e_start_step',
    nowMs: NOW,
    payload: { stepId }
  });
  const unloaded = firstRuntime.service.checkpointOnUnload({
    expectedSessionRevision: 2,
    commandKey: 'e2e_unload',
    nowMs: NOW + 15_000
  }).session;

  const restartedRuntime = createRuntime(storage);
  const recovered = restartedRuntime.service.restoreOnStartup({
    expectedSessionRevision: 3,
    commandKey: 'e2e_restart',
    nowMs: NOW + 30_000
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.session.id, unloaded.id);
  assert.equal(recovered.session.currentStepIndex, unloaded.currentStepIndex);
  assert.equal(recovered.session.currentSet, unloaded.currentSet);
  assert.equal(recovered.session.timer.stepId, stepId);
  assert.equal(recovered.session.timer.remainingSecondsAtCheckpoint, 270);
  assert.equal(recovered.session.elapsedActiveSeconds, 30);
  assert.equal(recovered.session.sessionRevision, 4);
});
