const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyWorkoutCommand,
  createWorkoutSession
} = require('../../miniprogram/domain/execution/workout-session');
const {
  createWorkoutSummaryRuntime
} = require('../../miniprogram/application/workout-summary-runtime');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785717300000;

function manualPlan(id, trainingDate) {
  const plan = createDefaultPlans({ now: () => START_AT })[2];
  plan.id = id;
  plan.trainingDate = trainingDate;
  plan.templateSource = null;
  plan.steps = [{ ...plan.steps.find(({ kind }) => kind === 'manual'), order: 1 }];
  return plan;
}

function terminalSession({ id, status, plan, endedAt }) {
  const started = createWorkoutSession({
    plan,
    sessionId: id,
    originDeviceId: 'device_spar_summary_binding',
    commandKey: `start_${id}`,
    nowMs: START_AT
  });
  return applyWorkoutCommand(started, {
    type: status === 'completed' ? 'complete_step' : 'abort',
    expectedSessionRevision: started.sessionRevision,
    commandKey: `${status}_${id}`,
    nowMs: endedAt,
    payload: status === 'completed'
      ? { stepId: started.planSnapshot.steps[0].id }
      : { reason: 'user-ended-workout' }
  }).session;
}

test('Attack: stale summary submit after active Session replacement — reject instead of attaching private feedback to another Session', () => {
  const completed = terminalSession({
    id: 'session_spar_summary_a',
    status: 'completed',
    plan: manualPlan('plan_spar_summary_a', '2026-08-20'),
    endedAt: START_AT + 60_000
  });
  const aborted = terminalSession({
    id: 'session_spar_summary_b',
    status: 'aborted',
    plan: manualPlan('plan_spar_summary_b', '2026-08-21'),
    endedAt: START_AT + 90_000
  });
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => START_AT + 100_000
  });
  database.commit((draft) => {
    draft.install = {
      deviceId: 'device_spar_summary_binding',
      createdAt: START_AT
    };
    draft.activeSession = clone(completed);
  });

  const runtime = createWorkoutSummaryRuntime({
    database,
    now: () => START_AT + 110_000
  });
  const loaded = runtime.load();
  assert.equal(loaded.summary.sessionId, completed.id);

  database.commit((draft) => {
    draft.activeSession = clone(aborted);
  });

  let saveError = null;
  try {
    runtime.saveFeedback({
      rpe: 9,
      pain: { knee: true },
      note: 'PRIVATE_FEEDBACK_FOR_SESSION_A'
    });
  } catch (error) {
    saveError = error;
  }

  assert.equal(
    database.load().records.length,
    0,
    'feedback collected for Session A must never be persisted against replacement Session B'
  );
  assert.ok(saveError, 'stale summary runtime must reject after the active Session identity changes');
});
