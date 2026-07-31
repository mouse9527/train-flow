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

test('Attack: tampered derived TrainingRecord semantics outside source fingerprint — reject forged event identity and counts', () => {
  const aborted = terminalSession({
    id: 'session_spar_record_semantics',
    status: 'aborted',
    plan: manualPlan('plan_spar_record_semantics', '2026-08-26'),
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
    draft.activeSession = clone(aborted);
  });

  const originalRuntime = createWorkoutSummaryRuntime({
    database,
    now: () => START_AT + 110_000
  });
  originalRuntime.load();
  originalRuntime.saveFeedback({ rpe: 6 });
  const originalRecord = database.load().records[0];
  assert.match(originalRecord.sourceSessionFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(originalRecord.eventType, 'WorkoutSessionAborted');

  database.commit((draft) => {
    const record = draft.records[0];
    record.occurrenceId = '["workout-session-terminal","forged","completed",0]';
    record.eventType = 'WorkoutSessionCompleted';
    record.completedStepCount = 999;
    record.skippedStepCount = 999;
    record.totalStepCount = 0;
  });

  const reloadedRuntime = createWorkoutSummaryRuntime({ database });
  let loadedState = null;
  let loadError = null;
  try {
    loadedState = reloadedRuntime.load();
  } catch (error) {
    loadError = error;
  }

  assert.equal(
    loadedState,
    null,
    'record event identity and summary counts must be proven, not trusted outside the fingerprint'
  );
  assert.ok(loadError, 'tampered derived record semantics must fail closed');
});

test('Attack: negative TrainingRecord metadata timestamps — reject impossible ordered values instead of treating them as valid', () => {
  const completed = terminalSession({
    id: 'session_spar_negative_record_metadata',
    status: 'completed',
    plan: manualPlan('plan_spar_negative_record_metadata', '2026-08-27'),
    endedAt: START_AT + 60_000
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

  const originalRuntime = createWorkoutSummaryRuntime({
    database,
    now: () => START_AT + 110_000
  });
  originalRuntime.load();
  originalRuntime.saveFeedback({ rpe: 5 });

  database.commit((draft) => {
    draft.records[0].createdAt = -2;
    draft.records[0].updatedAt = -1;
  });

  let loadedState = null;
  let loadError = null;
  try {
    loadedState = createWorkoutSummaryRuntime({ database }).load();
  } catch (error) {
    loadError = error;
  }

  assert.equal(
    loadedState,
    null,
    'ordered negative metadata is still impossible and must not authorize record loading'
  );
  assert.ok(loadError, 'negative createdAt/updatedAt metadata must fail closed');
});

test('Post-Spar hardening: same-status terminal ABA with changed facts rejects stale feedback save', () => {
  const sharedSessionId = 'session_post_spar_same_status_aba';
  const firstCompleted = terminalSession({
    id: sharedSessionId,
    status: 'completed',
    plan: manualPlan('plan_post_spar_same_status_a', '2026-08-28'),
    endedAt: START_AT + 60_000
  });
  const replacementCompleted = terminalSession({
    id: sharedSessionId,
    status: 'completed',
    plan: manualPlan('plan_post_spar_same_status_b', '2026-08-29'),
    endedAt: START_AT + 120_000
  });
  assert.equal(firstCompleted.sessionRevision, replacementCompleted.sessionRevision);
  assert.equal(firstCompleted.status, replacementCompleted.status);
  assert.notEqual(firstCompleted.endedAt, replacementCompleted.endedAt);
  assert.notDeepEqual(firstCompleted.planSnapshot, replacementCompleted.planSnapshot);

  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => START_AT + 130_000
  });
  database.commit((draft) => {
    draft.install = {
      deviceId: 'device_post_spar_same_status_aba',
      createdAt: START_AT
    };
    draft.activeSession = clone(firstCompleted);
  });

  const runtime = createWorkoutSummaryRuntime({ database });
  runtime.load();
  database.commit((draft) => {
    draft.activeSession = clone(replacementCompleted);
  });

  assert.throws(
    () => runtime.saveFeedback({ rpe: 6, note: 'PRIVATE_STALE_SAME_STATUS_FEEDBACK' }),
    /总结已过期/
  );
  assert.equal(database.load().records.length, 0);
});

test('Post-Spar hardening: isolated persisted stepResults tamper fails closed with counts unchanged', () => {
  const completed = terminalSession({
    id: 'session_post_spar_step_results_tamper',
    status: 'completed',
    plan: manualPlan('plan_post_spar_step_results_tamper', '2026-08-30'),
    endedAt: START_AT + 60_000
  });
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => START_AT + 90_000
  });
  database.commit((draft) => {
    draft.install = {
      deviceId: 'device_post_spar_step_results_tamper',
      createdAt: START_AT
    };
    draft.activeSession = clone(completed);
  });
  const runtime = createWorkoutSummaryRuntime({ database });
  runtime.load();
  runtime.saveFeedback({ rpe: 5 });

  const original = database.load().records[0];
  const counts = {
    completedStepCount: original.completedStepCount,
    skippedStepCount: original.skippedStepCount,
    totalStepCount: original.totalStepCount
  };
  database.commit((draft) => {
    draft.records[0].stepResults[0].status = 'skipped';
  });
  const tampered = database.load().records[0];
  assert.deepEqual({
    completedStepCount: tampered.completedStepCount,
    skippedStepCount: tampered.skippedStepCount,
    totalStepCount: tampered.totalStepCount
  }, counts);

  assert.throws(
    () => createWorkoutSummaryRuntime({ database }).load(),
    /记录.*当前总结不匹配/
  );
});
