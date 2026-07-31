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
