const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyWorkoutCommand,
  createWorkoutSession
} = require('../../miniprogram/domain/execution/workout-session');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
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
