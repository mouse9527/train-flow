const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyWorkoutCommand,
  assertWorkoutSession,
  createWorkoutSession
} = require('../../miniprogram/domain/execution/workout-session');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createDeveloperTimedWorkoutRuntime,
  createTimedWorkoutRuntime
} = require('../../miniprogram/application/timed-workout-runtime');
const {
  buildTimedWorkoutView
} = require('../../miniprogram/application/timed-workout-view');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785717300000;

function strengthPlan() {
  const plan = createDefaultPlans({ now: () => START_AT })[0];
  plan.id = 'plan_strength_rest_attack';
  plan.title = '力量休息攻击夹具';
  plan.steps = [{
    ...plan.steps.find(({ kind }) => kind === 'strength'),
    order: 1,
    sets: 2,
    reps: 12,
    restSeconds: 75
  }];
  return plan;
}

function command(type, expectedSessionRevision, commandKey, nowMs, payload = {}) {
  return { type, expectedSessionRevision, commandKey, nowMs, payload };
}

function startedStrengthSession() {
  return createWorkoutSession({
    plan: strengthPlan(),
    sessionId: 'session_strength_rest_attack',
    originDeviceId: 'device_strength_rest_attack',
    commandKey: 'start_strength_rest_attack',
    nowMs: START_AT
  });
}

function intervalPlan() {
  const plan = createDefaultPlans({ now: () => START_AT })
    .find(({ steps }) => steps.some(({ kind }) => kind === 'interval'));
  const interval = plan.steps.find(({ kind }) => kind === 'interval');
  plan.id = 'plan_interval_rest_attack';
  plan.title = '间歇休息攻击夹具';
  plan.steps = [{
    ...interval,
    order: 1,
    sets: 2,
    durationSeconds: 60,
    restSeconds: 30
  }];
  return plan;
}

function manualPlan() {
  const plan = createDefaultPlans({ now: () => START_AT })
    .find(({ steps }) => steps.some(({ kind }) => kind === 'manual'));
  const manual = plan.steps.find(({ kind }) => kind === 'manual');
  plan.id = 'plan_manual_control_attack';
  plan.title = '手动动作攻击夹具';
  plan.steps = [{ ...manual, order: 1, sets: 2, reps: 10 }];
  return plan;
}

function correctionPlan() {
  const plan = strengthPlan();
  const strength = {
    ...plan.steps[0],
    order: 1,
    sets: 1,
    restSeconds: 0
  };
  const manual = manualPlan().steps[0];
  plan.id = 'plan_strength_correction_attack';
  plan.title = '力量纠正攻击夹具';
  plan.steps = [strength, { ...manual, order: 2 }];
  return plan;
}

function manualThenStrengthPlan() {
  const plan = strengthPlan();
  const manual = manualPlan().steps[0];
  const strength = {
    ...plan.steps[0],
    order: 2,
    sets: 2,
    restSeconds: 30
  };
  plan.id = 'plan_manual_then_strength_attack';
  plan.title = '手动后力量攻击夹具';
  plan.steps = [{ ...manual, order: 1 }, strength];
  return plan;
}

function strengthThenManualPlan() {
  const plan = strengthPlan();
  const manual = manualPlan().steps[0];
  plan.id = 'plan_strength_then_manual_attack';
  plan.title = '力量后手动攻击夹具';
  plan.steps = [
    { ...plan.steps[0], order: 1, sets: 2, restSeconds: 30 },
    { ...manual, order: 2 }
  ];
  return plan;
}

test('Attack: distinct-key double tap and concurrent rest expiry cannot bypass explicit start-set', () => {
  const initial = startedStrengthSession();
  const stepId = initial.planSnapshot.steps[0].id;
  const first = applyWorkoutCommand(
    initial,
    command('complete_set', 1, 'complete_set_1', START_AT + 1_000, {
      stepId,
      setNumber: 1,
      reps: 12,
      weightKg: null
    })
  ).session;

  assert.deepEqual(first.stepResults[0].setResults, [{
    setNumber: 1,
    reps: 12,
    weightKg: null,
    completedAt: START_AT + 1_000
  }], 'unknown weight must remain null instead of becoming a fabricated zero');
  assert.equal(first.currentSet, 2);
  assert.equal(first.timer.mode, 'rest');
  assert.equal(first.timer.status, 'running');
  assert.equal(first.timer.setNumber, 2);

  const afterFirst = clone(first);
  assert.throws(
    () => applyWorkoutCommand(
      first,
      command('complete_set', 2, 'complete_set_1_double_tap', START_AT + 1_001, {
        stepId,
        setNumber: 1,
        reps: 12,
        weightKg: null
      })
    ),
    (error) => error && error.code === 'SESSION_SET_ALREADY_COMPLETED'
  );
  assert.deepEqual(first, afterFirst, 'a rejected double tap must not mutate the committed result');

  const expiresAt = first.timer.expectedEndAt;
  const expiredFromCallbackA = applyWorkoutCommand(
    first,
    command('checkpoint', 2, 'rest_expiry_callback_a', expiresAt, { reason: 'manual' })
  ).session;
  const expiredFromCallbackB = applyWorkoutCommand(
    first,
    command('checkpoint', 2, 'rest_expiry_callback_b', expiresAt, { reason: 'manual' })
  ).session;

  assert.equal(expiredFromCallbackA.timer.status, 'expired');
  assert.equal(expiredFromCallbackB.timer.status, 'expired');
  assert.equal(
    expiredFromCallbackA.timer.expirationOccurrenceId,
    expiredFromCallbackB.timer.expirationOccurrenceId,
    'concurrent rest-expiry materialization must converge on one occurrence identity'
  );
  assert.equal(expiredFromCallbackA.currentSet, 2);
  assert.equal(expiredFromCallbackA.stepResults[0].setResults.length, 1);

  const beforePrematureComplete = clone(expiredFromCallbackA);
  assert.throws(
    () => applyWorkoutCommand(
      expiredFromCallbackA,
      command('complete_set', 3, 'complete_set_2_without_start', expiresAt + 1_000, {
        stepId,
        setNumber: 2,
        reps: 11,
        weightKg: 10
      })
    ),
    (error) => error && error.code === 'SESSION_SET_NOT_STARTED',
    'rest expiry must not make the next set completable before explicit start-set'
  );
  assert.deepEqual(
    expiredFromCallbackA,
    beforePrematureComplete,
    'a premature completion attempt must preserve the expired rest and completed set audit'
  );

  const startedSecondSet = applyWorkoutCommand(
    expiredFromCallbackA,
    command('start_set', 3, 'start_set_2', expiresAt + 2_000, {
      stepId,
      setNumber: 2
    })
  ).session;
  assert.equal(startedSecondSet.currentSet, 2);
  assert.equal(startedSecondSet.timer, null);
  assert.equal(startedSecondSet.stepResults[0].setResults.length, 1);

  const completed = applyWorkoutCommand(
    startedSecondSet,
    command('complete_set', 4, 'complete_set_2', expiresAt + 3_000, {
      stepId,
      setNumber: 2,
      reps: 11,
      weightKg: 10
    })
  ).session;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(
    completed.stepResults[0].setResults.map(({ setNumber }) => setNumber),
    [1, 2]
  );
});

test('Attack: generic timed-next cannot consume expired strength rest or erase remaining sets', () => {
  const initial = startedStrengthSession();
  const stepId = initial.planSnapshot.steps[0].id;
  const resting = applyWorkoutCommand(
    initial,
    command('complete_set', 1, 'generic_next_complete_set_1', START_AT + 1_000, {
      stepId,
      setNumber: 1,
      reps: 12,
      weightKg: null
    })
  ).session;
  const expired = applyWorkoutCommand(
    resting,
    command('checkpoint', 2, 'generic_next_rest_expired', resting.timer.expectedEndAt, {
      reason: 'manual'
    })
  ).session;
  const beforeGenericNext = clone(expired);

  assert.throws(
    () => applyWorkoutCommand(
      expired,
      command(
        'confirm_next_and_start_next',
        3,
        'generic_next_must_not_complete_strength',
        resting.timer.expectedEndAt + 1_000,
        { stepId }
      )
    ),
    (error) => error && error.code === 'SESSION_REST_START_REQUIRED',
    'only start_set may consume an expired strength rest'
  );
  assert.deepEqual(
    expired,
    beforeGenericNext,
    'the rejected generic next intent must preserve the completed set and current step'
  );
});

test('Attack: expired strength rest notifies once and generic next cannot complete the exercise', () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const initial = startedStrengthSession();
  const stepId = initial.planSnapshot.steps[0].id;
  const resting = applyWorkoutCommand(
    initial,
    command('complete_set', 1, 'runtime_complete_set_1', START_AT + 1_000, {
      stepId,
      setNumber: 1,
      reps: 12,
      weightKg: null
    })
  ).session;
  const database = createLocalDatabase({ storage, now: () => clock });
  database.commit((draft) => {
    draft.install = {
      deviceId: 'device_strength_rest_attack',
      createdAt: START_AT
    };
    draft.activeSession = clone(resting);
  });

  clock = resting.timer.expectedEndAt;
  const notifications = [];
  let sequence = 0;
  const runtime = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'must_restore_strength_rest_attack',
    commandKeyFactory: (type) => `strength_rest_${type}_${++sequence}`,
    notifyExpired: (occurrenceId) => notifications.push(occurrenceId)
  });

  const expired = runtime.load({});
  const repeated = runtime.onShow();
  assert.equal(notifications.length, 1, 'repeated rest-expiry callbacks must notify once');
  assert.equal(new Set(notifications).size, 1);
  assert.equal(expired.currentStepIndex, 0);
  assert.equal(repeated.currentStepIndex, 0);
  assert.equal(expired.state, 'rest-expired-awaiting-start-set');
  assert.equal(expired.showStartSetConfirmation, true);
  assert.equal(expired.controls.startSet.disabled, false);
  assert.equal(expired.controls.next.disabled, true);

  const beforeGenericNext = database.load().activeSession;
  assert.throws(
    () => runtime.confirmNext(),
    (error) => error && error.code === 'SESSION_REST_START_REQUIRED',
    'the generic timed-step confirmation must not consume an expired strength rest'
  );
  assert.deepEqual(
    database.load().activeSession,
    beforeGenericNext,
    'rejected generic next must not erase set results or advance the strength step'
  );
});

test('Attack: strength view separates nullable actual inputs from immutable targets and exposes set-count controls', () => {
  const session = startedStrengthSession();
  const view = buildTimedWorkoutView(session, { nowMs: START_AT });

  assert.deepEqual(view.strength, {
    currentSet: 1,
    targetSets: 2,
    targetReps: 12,
    previousWeightKg: null,
    suggestedWeightKg: null,
    actualReps: 12,
    actualWeightKg: null
  }, 'unknown previous/suggested/current weight must stay null while target reps remain read-only');

  const enabledLabels = Object.values(view.controls)
    .filter(({ disabled }) => !disabled)
    .map(({ label }) => label);
  assert.ok(
    enabledLabels.some((label) => /完成第\s*1\s*组/.test(label)),
    'the active strength set needs an explicit completion control'
  );
  assert.ok(
    enabledLabels.some((label) => /加.*组|增加.*组/.test(label)),
    'the user must be able to add a planned set for the current execution'
  );
  assert.ok(
    enabledLabels.some((label) => /减.*组|减少.*组/.test(label)),
    'the user must be able to reduce a not-yet-completed planned set'
  );
});

test('Attack: edited actual reps and nullable weight persist without overwriting plan targets', () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const database = createLocalDatabase({ storage, now: () => clock });
  database.commit((draft) => {
    draft.install = {
      deviceId: 'device_strength_rest_attack',
      createdAt: START_AT
    };
    draft.activeSession = startedStrengthSession();
  });
  let sequence = 0;
  const runtime = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'must_restore_strength_actual_attack',
    commandKeyFactory: (type) => `strength_actual_${type}_${++sequence}`
  });

  runtime.load({});
  clock += 1_000;
  runtime.completeSet({ reps: 9, weightKg: null });

  const persisted = database.load().activeSession;
  assert.equal(persisted.planSnapshot.steps[0].reps, 12, 'planned reps remain the target');
  assert.deepEqual(persisted.stepResults[0].setResults[0], {
    setNumber: 1,
    reps: 9,
    weightKg: null,
    completedAt: clock
  }, 'actual values must be stored independently and unknown weight must remain null');
});

test('Attack: actual weight with more than one decimal is rejected without Session mutation', () => {
  const initial = startedStrengthSession();
  const before = clone(initial);
  const stepId = initial.planSnapshot.steps[0].id;

  assert.throws(
    () => applyWorkoutCommand(
      initial,
      command('complete_set', 1, 'weight_precision_attack', START_AT + 1_000, {
        stepId,
        setNumber: 1,
        reps: 12,
        weightKg: 10.25
      })
    ),
    (error) => error instanceof TypeError && /weightKg|重量|decimal|小数/i.test(error.message),
    'persisted kg values allow at most one decimal place'
  );
  assert.deepEqual(initial, before, 'invalid actual input must not partially mutate the Session');
});

test('Attack: expired interval rest starts the next work set instead of completing it', () => {
  let session = createWorkoutSession({
    plan: intervalPlan(),
    sessionId: 'session_interval_rest_attack',
    originDeviceId: 'device_interval_rest_attack',
    commandKey: 'start_interval_rest_attack',
    nowMs: START_AT
  });
  const stepId = session.planSnapshot.steps[0].id;
  session = applyWorkoutCommand(
    session,
    command('start_step', 1, 'interval_set_1_start', START_AT, { stepId })
  ).session;
  session = applyWorkoutCommand(
    session,
    command('confirm_next', 2, 'interval_set_1_complete', session.timer.expectedEndAt, { stepId })
  ).session;
  session = applyWorkoutCommand(
    session,
    command('checkpoint', 3, 'interval_rest_expire', session.timer.expectedEndAt, {
      reason: 'manual'
    })
  ).session;

  const beforeStart = clone(session);
  const view = buildTimedWorkoutView(session, { nowMs: session.lastCheckpointAt });
  assert.equal(view.controls.start.disabled, false, 'expired interval rest should enable Start');
  assert.equal(view.controls.next.disabled, true, 'generic Next would falsely complete set 2');

  const started = applyWorkoutCommand(
    session,
    command('start_step', 4, 'interval_set_2_start', session.lastCheckpointAt + 1_000, { stepId })
  ).session;
  assert.equal(started.timer.mode, 'step');
  assert.equal(started.timer.status, 'running');
  assert.equal(started.currentSet, 2);
  assert.deepEqual(
    started.stepResults[0].setResults,
    beforeStart.stepResults[0].setResults,
    'starting set 2 must not fabricate its completion result'
  );
});

test('Attack: manual exercise exposes a completion action without starting a timer', () => {
  const session = createWorkoutSession({
    plan: manualPlan(),
    sessionId: 'session_manual_control_attack',
    originDeviceId: 'device_manual_control_attack',
    commandKey: 'start_manual_control_attack',
    nowMs: START_AT
  });
  const view = buildTimedWorkoutView(session, { nowMs: START_AT });
  const completionControls = Object.values(view.controls).filter(
    ({ disabled, label }) => !disabled && /完成/.test(label)
  );

  assert.ok(completionControls.length > 0, 'manual/stretch work needs an enabled completion action');
  assert.equal(session.timer, null, 'manual completion must not require or fabricate a timer');
});

test('develop strength fixture derives active, running-rest and expired-rest views through the real runtime', () => {
  const active = createDeveloperTimedWorkoutRuntime({ mode: 'strength', state: 'active' }).load({});
  assert.equal(active.state, 'ready');
  assert.equal(active.step.kind, 'strength');
  assert.equal(active.controls.completeSet.disabled, false);
  assert.equal(active.strength.currentSet, 1);

  const rest = createDeveloperTimedWorkoutRuntime({ mode: 'strength', state: 'rest' }).load({});
  assert.equal(rest.state, 'running');
  assert.equal(rest.step.kind, 'strength');
  assert.equal(rest.strength.currentSet, 2);
  assert.equal(rest.controls.completeSet.disabled, true);
  assert.equal(rest.remainingSeconds > 0, true);

  const expired = createDeveloperTimedWorkoutRuntime({ mode: 'strength', state: 'expired' }).load({});
  assert.equal(expired.state, 'rest-expired-awaiting-start-set');
  assert.equal(expired.step.kind, 'strength');
  assert.equal(expired.strength.currentSet, 2);
  assert.equal(expired.showStartSetConfirmation, true);
  assert.equal(expired.controls.startSet.disabled, false);
  assert.equal(expired.controls.completeSet.disabled, true);
});

test('Attack: previous correction keeps completed strength sets and appends an audit revision', () => {
  let session = createWorkoutSession({
    plan: correctionPlan(),
    sessionId: 'session_strength_correction_attack',
    originDeviceId: 'device_strength_correction_attack',
    commandKey: 'start_strength_correction_attack',
    nowMs: START_AT
  });
  const strengthStepId = session.planSnapshot.steps[0].id;
  session = applyWorkoutCommand(
    session,
    command('complete_set', 1, 'strength_correction_complete', START_AT + 1_000, {
      stepId: strengthStepId,
      setNumber: 1,
      reps: 11,
      weightKg: 12.5
    })
  ).session;
  const completedSets = clone(session.stepResults[0].setResults);

  const corrected = applyWorkoutCommand(
    session,
    command('previous_step', 2, 'strength_correction_previous', START_AT + 2_000)
  ).session;

  assert.equal(corrected.currentStepIndex, 0);
  assert.deepEqual(
    corrected.stepResults.find(({ stepId }) => stepId === strengthStepId).setResults,
    completedSets,
    'entering correction must not silently erase already completed strength facts'
  );
  assert.equal(corrected.sessionRevision, 3);
  assert.equal(corrected.processedCommands.at(-1).type, 'previous_step');
});

test('Attack: add/reduce set targets are execution overrides and never rewrite the immutable PlanSnapshot', () => {
  const initial = startedStrengthSession();
  const originalSnapshot = clone(initial.planSnapshot);
  const stepId = initial.planSnapshot.steps[0].id;

  const expanded = applyWorkoutCommand(
    initial,
    command('add_set', 1, 'execution_target_add', START_AT + 1_000, { stepId })
  ).session;
  assert.deepEqual(
    expanded.planSnapshot,
    originalSnapshot,
    'adjusting the current execution must not rewrite its signed source-plan snapshot'
  );
  assert.equal(
    buildTimedWorkoutView(expanded, { nowMs: START_AT + 1_000 }).strength.targetSets,
    3,
    'the execution target still reflects the added set'
  );

  const reduced = applyWorkoutCommand(
    expanded,
    command('reduce_set', 2, 'execution_target_reduce', START_AT + 2_000, { stepId })
  ).session;
  assert.deepEqual(reduced.planSnapshot, originalSnapshot);
  assert.equal(
    buildTimedWorkoutView(reduced, { nowMs: START_AT + 2_000 }).strength.targetSets,
    2
  );
});

test('Attack: skip remains an explicit escape during running or expired strength rest without losing completed sets', () => {
  const initial = startedStrengthSession();
  const stepId = initial.planSnapshot.steps[0].id;
  const resting = applyWorkoutCommand(
    initial,
    command('complete_set', 1, 'skip_rest_complete_set_1', START_AT + 1_000, {
      stepId,
      setNumber: 1,
      reps: 12,
      weightKg: 10
    })
  ).session;
  const completedSet = clone(resting.stepResults[0].setResults);

  const skippedWhileRunning = applyWorkoutCommand(
    resting,
    command('skip_step', 2, 'skip_running_rest', START_AT + 2_000, { stepId })
  ).session;
  assert.equal(skippedWhileRunning.status, 'completed');
  assert.equal(skippedWhileRunning.stepResults[0].status, 'skipped');
  assert.deepEqual(skippedWhileRunning.stepResults[0].setResults, completedSet);

  const expired = applyWorkoutCommand(
    resting,
    command('checkpoint', 2, 'skip_rest_expired_checkpoint', resting.timer.expectedEndAt, {
      reason: 'manual'
    })
  ).session;
  const expiredView = buildTimedWorkoutView(expired, { nowMs: expired.lastCheckpointAt });
  assert.equal(
    expiredView.controls.skip.disabled,
    false,
    'rest expiry must not trap the user into starting another set or ending the workout'
  );
  const skippedAfterExpiry = applyWorkoutCommand(
    expired,
    command('skip_step', 3, 'skip_expired_rest', expired.lastCheckpointAt + 1_000, { stepId })
  ).session;
  assert.equal(skippedAfterExpiry.status, 'completed');
  assert.equal(skippedAfterExpiry.stepResults[0].status, 'skipped');
  assert.deepEqual(
    skippedAfterExpiry.stepResults[0].setResults,
    completedSet,
    'skipping the remaining exercise must retain already completed set facts'
  );
});

test('Attack: previous is safely blocked while the current strength step owns partial set/rest state', () => {
  let session = createWorkoutSession({
    plan: manualThenStrengthPlan(),
    sessionId: 'session_partial_strength_previous_attack',
    originDeviceId: 'device_partial_strength_previous_attack',
    commandKey: 'start_partial_strength_previous_attack',
    nowMs: START_AT
  });
  const manualStepId = session.planSnapshot.steps[0].id;
  session = applyWorkoutCommand(
    session,
    command('complete_step', 1, 'partial_previous_manual_complete', START_AT + 1_000, {
      stepId: manualStepId
    })
  ).session;
  const strengthStepId = session.planSnapshot.steps[1].id;
  session = applyWorkoutCommand(
    session,
    command('complete_set', 2, 'partial_previous_set_1_complete', START_AT + 2_000, {
      stepId: strengthStepId,
      setNumber: 1,
      reps: 10,
      weightKg: null
    })
  ).session;

  const resting = clone(session);
  const restingView = buildTimedWorkoutView(resting, { nowMs: START_AT + 2_000 });
  assert.equal(restingView.controls.previous.disabled, true);
  assert.throws(
    () => applyWorkoutCommand(
      resting,
      command('previous_step', 3, 'partial_previous_during_rest', START_AT + 3_000)
    ),
    (error) => error && [
      'SESSION_PREVIOUS_UNAVAILABLE',
      'SESSION_PREVIOUS_CORRECTION_REQUIRED'
    ].includes(error.code),
    'previous must fail explicitly before a partial current strength result can become a future result'
  );
  assert.deepEqual(session, resting, 'rejected previous during rest performs zero mutation');

  const expired = applyWorkoutCommand(
    resting,
    command('checkpoint', 3, 'partial_previous_rest_expire', resting.timer.expectedEndAt, {
      reason: 'manual'
    })
  ).session;
  const activeSet = applyWorkoutCommand(
    expired,
    command('start_set', 4, 'partial_previous_start_set_2', expired.lastCheckpointAt + 1_000, {
      stepId: strengthStepId,
      setNumber: 2
    })
  ).session;
  const activeView = buildTimedWorkoutView(activeSet, { nowMs: activeSet.lastCheckpointAt });
  assert.equal(activeView.controls.previous.disabled, true);
  const beforeActivePrevious = clone(activeSet);
  assert.throws(
    () => applyWorkoutCommand(
      activeSet,
      command('previous_step', 5, 'partial_previous_during_active_set', activeSet.lastCheckpointAt + 1_000)
    ),
    (error) => error && [
      'SESSION_PREVIOUS_UNAVAILABLE',
      'SESSION_PREVIOUS_CORRECTION_REQUIRED'
    ].includes(error.code)
  );
  assert.deepEqual(activeSet, beforeActivePrevious, 'rejected previous during an active set is atomic');
});

test('Attack: reopened strength correction can replace actuals while retaining the prior command audit', () => {
  let session = createWorkoutSession({
    plan: correctionPlan(),
    sessionId: 'session_strength_replacement_attack',
    originDeviceId: 'device_strength_replacement_attack',
    commandKey: 'start_strength_replacement_attack',
    nowMs: START_AT
  });
  const stepId = session.planSnapshot.steps[0].id;
  session = applyWorkoutCommand(
    session,
    command('complete_set', 1, 'strength_original_actuals', START_AT + 1_000, {
      stepId,
      setNumber: 1,
      reps: 11,
      weightKg: 12.5
    })
  ).session;
  const originalFingerprint = session.processedCommands.at(-1).fingerprint;
  session = applyWorkoutCommand(
    session,
    command('previous_step', 2, 'strength_reopen_for_replacement', START_AT + 2_000)
  ).session;

  const correctionView = buildTimedWorkoutView(session, { nowMs: START_AT + 2_000 });
  assert.equal(
    correctionView.controls.completeSet.disabled,
    false,
    'previous-step correction must be actionable instead of a read-only dead end'
  );
  const replaced = applyWorkoutCommand(
    session,
    command('complete_set', 3, 'strength_replaced_actuals', START_AT + 3_000, {
      stepId,
      setNumber: 1,
      reps: 9,
      weightKg: 10
    })
  ).session;

  assert.deepEqual(replaced.stepResults[0].setResults[0], {
    setNumber: 1,
    reps: 9,
    weightKg: 10,
    completedAt: START_AT + 3_000
  });
  assert.equal(
    replaced.processedCommands.some(({ fingerprint }) => fingerprint === originalFingerprint),
    true,
    'the prior actual values remain recoverable from the immutable command audit'
  );
  assert.equal(replaced.processedCommands.at(-1).type, 'complete_set');
});

test('Attack: previous after a partially completed strength skip is explicitly unavailable and never crashes validation', () => {
  let session = createWorkoutSession({
    plan: strengthThenManualPlan(),
    sessionId: 'session_skipped_strength_previous_attack',
    originDeviceId: 'device_skipped_strength_previous_attack',
    commandKey: 'start_skipped_strength_previous_attack',
    nowMs: START_AT
  });
  const strengthStepId = session.planSnapshot.steps[0].id;
  session = applyWorkoutCommand(
    session,
    command('complete_set', 1, 'skipped_strength_set_1', START_AT + 1_000, {
      stepId: strengthStepId,
      setNumber: 1,
      reps: 10,
      weightKg: null
    })
  ).session;
  session = applyWorkoutCommand(
    session,
    command('skip_step_and_start_next', 2, 'skipped_strength_remaining_sets', START_AT + 2_000, {
      stepId: strengthStepId
    })
  ).session;
  assert.equal(session.currentStepIndex, 1);
  assert.equal(session.stepResults[0].status, 'skipped');
  assert.equal(session.stepResults[0].setResults.length, 1);

  const view = buildTimedWorkoutView(session, { nowMs: START_AT + 2_000 });
  assert.equal(
    view.controls.previous.disabled,
    true,
    'a partial skipped strength result needs a dedicated correction flow before Previous is offered'
  );
  const beforePrevious = clone(session);
  assert.throws(
    () => applyWorkoutCommand(
      session,
      command('previous_step', 3, 'previous_after_skipped_strength', START_AT + 3_000)
    ),
    (error) => error && [
      'SESSION_PREVIOUS_UNAVAILABLE',
      'SESSION_PREVIOUS_CORRECTION_REQUIRED'
    ].includes(error.code),
    'the domain must reject this impossible cursor/result shape before final invariant validation'
  );
  assert.deepEqual(session, beforePrevious, 'rejected Previous performs zero mutation');
});

test('Attack: restored Session rejects set-target overrides for future strength steps that no command could reach', () => {
  const session = createWorkoutSession({
    plan: manualThenStrengthPlan(),
    sessionId: 'session_future_override_attack',
    originDeviceId: 'device_future_override_attack',
    commandKey: 'start_future_override_attack',
    nowMs: START_AT
  });
  const futureStrengthStepId = session.planSnapshot.steps[1].id;
  const forged = clone(session);
  forged.setTargetOverrides = { [futureStrengthStepId]: 3 };

  assert.throws(
    () => assertWorkoutSession(forged),
    /setTargetOverrides|future|current|unreachable/i,
    'restore validation must reject an override that cannot be produced before reaching its step'
  );
  assert.equal(session.setTargetOverrides, undefined, 'the valid source Session remains unchanged');
});

test('Attack: restored current-step set override requires matching add/reduce command audit evidence', () => {
  const session = startedStrengthSession();
  const stepId = session.planSnapshot.steps[0].id;
  const forged = clone(session);
  forged.setTargetOverrides = { [stepId]: 3 };

  assert.throws(
    () => assertWorkoutSession(forged),
    /setTargetOverrides|command|audit|revision/i,
    'an override without a revisioned add/reduce command is not a reachable persisted Session'
  );
  assert.equal(session.sessionRevision, 1);
  assert.equal(session.processedCommands.length, 1);
});
