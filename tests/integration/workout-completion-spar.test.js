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

test('Attack: terminal Session identity/revision ABA — reject same-id same-revision replacement with different terminal fact', () => {
  const sharedSessionId = 'session_spar_summary_aba';
  const completed = terminalSession({
    id: sharedSessionId,
    status: 'completed',
    plan: manualPlan('plan_spar_summary_aba_a', '2026-08-22'),
    endedAt: START_AT + 60_000
  });
  const abortedReplacement = terminalSession({
    id: sharedSessionId,
    status: 'aborted',
    plan: manualPlan('plan_spar_summary_aba_b', '2026-08-23'),
    endedAt: START_AT + 90_000
  });
  assert.equal(completed.sessionRevision, abortedReplacement.sessionRevision);
  assert.notEqual(completed.status, abortedReplacement.status);
  assert.notEqual(completed.endedAt, abortedReplacement.endedAt);

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
  assert.equal(loaded.summary.status, 'completed');

  database.commit((draft) => {
    draft.activeSession = clone(abortedReplacement);
  });

  let saveError = null;
  try {
    runtime.saveFeedback({
      rpe: 7,
      pain: { lowerBack: true },
      note: 'PRIVATE_FEEDBACK_FOR_COMPLETED_ABA_SESSION'
    });
  } catch (error) {
    saveError = error;
  }

  assert.equal(
    database.load().records.length,
    0,
    'id/revision equality must not authorize feedback persistence for a different terminal fact'
  );
  assert.ok(saveError, 'terminal identity ABA must be rejected as a stale summary');
});

test('Attack: persisted record ABA on a fresh summary runtime — reject instead of exposing feedback from another terminal fact', () => {
  const sharedSessionId = 'session_spar_record_aba';
  const completed = terminalSession({
    id: sharedSessionId,
    status: 'completed',
    plan: manualPlan('plan_spar_record_aba_a', '2026-08-24'),
    endedAt: START_AT + 60_000
  });
  const abortedReplacement = terminalSession({
    id: sharedSessionId,
    status: 'aborted',
    plan: manualPlan('plan_spar_record_aba_b', '2026-08-25'),
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

  const completedRuntime = createWorkoutSummaryRuntime({
    database,
    now: () => START_AT + 110_000
  });
  completedRuntime.load();
  completedRuntime.saveFeedback({
    rpe: 9,
    pain: { dizziness: true },
    note: 'ROUND3_PRIVATE_FEEDBACK_FOR_COMPLETED_SESSION'
  });
  assert.equal(database.load().records.length, 1);

  database.commit((draft) => {
    draft.activeSession = clone(abortedReplacement);
  });

  const replacementRuntime = createWorkoutSummaryRuntime({ database });
  let loadedState = null;
  let loadError = null;
  try {
    loadedState = replacementRuntime.load();
  } catch (error) {
    loadError = error;
  }

  assert.equal(
    loadedState,
    null,
    'a record from another terminal occurrence must not be returned as saved feedback'
  );
  assert.ok(loadError, 'conflicting sourceSessionId/occurrence identity must fail closed');
  assert.equal(database.load().records.length, 1, 'conflict detection must not mutate records');
});
