const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyWorkoutCommand,
  assertWorkoutSession,
  createWorkoutSession
} = require('../../../miniprogram/domain/execution/workout-session');
const {
  createDefaultPlans
} = require('../../../miniprogram/domain/planning/default-plan-factory');
const { createTimerEngine } = require('../../../miniprogram/services/timer-engine');

const NOW = 1785717300000;

function timedPlan() {
  return createDefaultPlans({ now: () => NOW })[0];
}

function strengthPlan() {
  const plan = timedPlan();
  plan.id = 'plan_strength_fixture';
  plan.steps = [{ ...plan.steps[3], order: 1 }];
  return plan;
}

function threeSetStrengthPlan() {
  const plan = strengthPlan();
  plan.steps[0].sets = 3;
  return plan;
}

function singleTimedPlan() {
  const plan = timedPlan();
  plan.id = 'plan_timed_fixture';
  plan.steps = [{ ...plan.steps[0], order: 1 }];
  return plan;
}

function intervalPlan() {
  const plan = createDefaultPlans({ now: () => NOW })[3];
  plan.id = 'plan_interval_fixture';
  plan.steps = [{ ...plan.steps[1], order: 1 }];
  return plan;
}

function manualPlan() {
  const plan = createDefaultPlans({ now: () => NOW })[2];
  plan.id = 'plan_manual_fixture';
  plan.steps = [{ ...plan.steps.find(({ kind }) => kind === 'manual'), order: 1 }];
  return plan;
}

function singleSetStrengthPlan() {
  const plan = strengthPlan();
  plan.steps[0].sets = 1;
  return plan;
}

function startedSession(plan = timedPlan()) {
  return createWorkoutSession({
    plan,
    sessionId: 'session_commands',
    originDeviceId: 'device_origin',
    commandKey: 'start_commands',
    nowMs: NOW
  });
}

function command(type, expectedSessionRevision, commandKey, nowMs, payload = {}) {
  return { type, expectedSessionRevision, commandKey, nowMs, payload };
}

test('start creates a validated deep PlanSnapshot with stable origin and initial position', () => {
  const source = timedPlan();
  const session = createWorkoutSession({
    plan: source,
    sessionId: 'session_fixture',
    originDeviceId: 'device_origin',
    commandKey: 'start_fixture',
    nowMs: NOW
  });

  assert.equal(assertWorkoutSession(session), session);
  assert.equal(session.planId, source.id);
  assert.equal(session.planRevision, source.revision);
  assert.equal(session.originDeviceId, 'device_origin');
  assert.equal(session.status, 'in_progress');
  assert.equal(session.currentStepIndex, 0);
  assert.equal(session.currentSet, null);
  assert.equal(session.timer, null);
  assert.equal(session.sessionRevision, 1);
  assert.equal(session.processedCommands[0].key, 'start_fixture');

  source.title = 'edited after start';
  source.steps[0].name = 'edited step after start';
  assert.notEqual(session.planSnapshot.title, source.title);
  assert.notEqual(session.planSnapshot.steps[0].name, source.steps[0].name);

  session.planSnapshot.title = 'mutated returned snapshot';
  const repeated = createWorkoutSession({
    plan: timedPlan(),
    sessionId: 'session_fixture_2',
    originDeviceId: 'device_origin',
    commandKey: 'start_fixture_2',
    nowMs: NOW
  });
  assert.notEqual(repeated.planSnapshot.title, session.planSnapshot.title);
});

test('start rejects rest_day, deleted plans and malformed identity input', () => {
  const plans = createDefaultPlans({ now: () => NOW });
  const restDay = plans.at(-1);
  const deleted = {
    ...plans[0],
    status: 'deleted',
    deletedAt: NOW
  };

  assert.throws(
    () => createWorkoutSession({
      plan: restDay,
      sessionId: 'session_rest',
      originDeviceId: 'device_origin',
      commandKey: 'start_rest',
      nowMs: NOW
    }),
    (error) => error && error.code === 'SESSION_REST_DAY'
  );
  assert.throws(
    () => createWorkoutSession({
      plan: deleted,
      sessionId: 'session_deleted',
      originDeviceId: 'device_origin',
      commandKey: 'start_deleted',
      nowMs: NOW
    }),
    /scheduled|deleted/i
  );

  for (const overrides of [
    { sessionId: '' },
    { originDeviceId: '' },
    { commandKey: '' },
    { nowMs: Number.NaN },
    { nowMs: -0 }
  ]) {
    assert.throws(() => createWorkoutSession({
      plan: plans[0],
      sessionId: 'session_valid',
      originDeviceId: 'device_origin',
      commandKey: 'start_valid',
      nowMs: NOW,
      ...overrides
    }));
  }
});

test('Session boundary rejects custom prototypes, descriptors, unknown and unsafe fields', () => {
  const valid = createWorkoutSession({
    plan: timedPlan(),
    sessionId: 'session_schema',
    originDeviceId: 'device_origin',
    commandKey: 'start_schema',
    nowMs: NOW
  });
  const getter = { ...valid };
  Object.defineProperty(getter, 'status', {
    enumerable: true,
    get() {
      throw new Error('getter must never execute');
    }
  });
  const nonEnumerable = { ...valid };
  Object.defineProperty(nonEnumerable, 'hidden', { value: true, enumerable: false });
  const brokenCommandChain = structuredClone(valid);
  brokenCommandChain.processedCommands[0].sessionRevision = 7;
  brokenCommandChain.sessionRevision = 7;
  const futureStepResult = structuredClone(valid);
  futureStepResult.stepResults.push({
    stepId: futureStepResult.planSnapshot.steps[1].id,
    status: 'completed',
    completedAt: NOW,
    setResults: []
  });
  const deletedSnapshot = structuredClone(valid);
  deletedSnapshot.planSnapshot.status = 'deleted';
  deletedSnapshot.planSnapshot.deletedAt = NOW;
  const excessiveElapsed = structuredClone(valid);
  excessiveElapsed.elapsedActiveSeconds = 1;
  const forgedStartFingerprint = structuredClone(valid);
  forgedStartFingerprint.processedCommands[0].fingerprint = 'forged-but-non-empty';

  const advanced = applyWorkoutCommand(
    applyWorkoutCommand(
      valid,
      command('start_step', 1, 'boundary_start_step', NOW, {
        stepId: valid.planSnapshot.steps[0].id
      })
    ).session,
    command('complete_step', 2, 'boundary_complete_step', NOW + 300_000, {
      stepId: valid.planSnapshot.steps[0].id
    })
  ).session;
  const missingPriorResult = structuredClone(advanced);
  missingPriorResult.stepResults = [];

  for (const candidate of [
    Object.assign(Object.create({ inherited: true }), valid),
    { ...valid, unknown: true },
    { ...valid, elapsedActiveSeconds: undefined },
    { ...valid, elapsedActiveSeconds: Number.POSITIVE_INFINITY },
    getter,
    nonEnumerable,
    brokenCommandChain,
    futureStepResult,
    deletedSnapshot,
    excessiveElapsed,
    forgedStartFingerprint,
    missingPriorResult
  ]) {
    assert.throws(() => assertWorkoutSession(candidate), /session|JSON|field|prototype|finite|safe|enumerable/i);
  }
});

test('timer identity must match both current step ID and supported step kind', () => {
  const session = startedSession(strengthPlan());
  const invalid = structuredClone(session);
  invalid.timer = createTimerEngine().start({
    mode: 'step',
    durationSeconds: 30,
    stepId: invalid.planSnapshot.steps[0].id,
    setNumber: null
  }, NOW);

  assert.throws(
    () => assertWorkoutSession(invalid),
    /timer|kind|mode|strength/i
  );
});

test('timer mode and duration must remain bound to the current PlanSnapshot step', () => {
  const timed = startedSession(singleTimedPlan());
  const timedStepId = timed.planSnapshot.steps[0].id;
  const stepRunning = applyWorkoutCommand(
    timed,
    command('start_step', 1, 'planned_step_running', NOW, { stepId: timedStepId })
  ).session;
  const stepPaused = applyWorkoutCommand(
    stepRunning,
    command('pause', 2, 'planned_step_paused', NOW + 1_000, { reason: 'user' })
  ).session;
  const stepExpired = applyWorkoutCommand(
    stepRunning,
    command('checkpoint', 2, 'planned_step_expired', NOW + 300_000, { reason: 'manual' })
  ).session;
  const strength = startedSession(threeSetStrengthPlan());
  const strengthStepId = strength.planSnapshot.steps[0].id;
  const restRunning = applyWorkoutCommand(
    strength,
    command('complete_set', 1, 'planned_rest_running', NOW + 1_000, {
      stepId: strengthStepId,
      setNumber: 1,
      reps: 12,
      weightKg: 20
    })
  ).session;
  const restPaused = applyWorkoutCommand(
    restRunning,
    command('pause', 2, 'planned_rest_paused', NOW + 2_000, { reason: 'user' })
  ).session;
  const restExpired = applyWorkoutCommand(
    restRunning,
    command('checkpoint', 2, 'planned_rest_expired', NOW + 76_000, { reason: 'manual' })
  ).session;
  const interval = startedSession(intervalPlan());
  const intervalStepId = interval.planSnapshot.steps[0].id;
  const intervalStep = applyWorkoutCommand(
    interval,
    command('start_step', 1, 'planned_interval_step', NOW, { stepId: intervalStepId })
  ).session;
  const intervalRest = applyWorkoutCommand(
    intervalStep,
    command('complete_step', 2, 'planned_interval_rest', NOW + 60_000, {
      stepId: intervalStepId
    })
  ).session;

  for (const source of [
    stepRunning,
    stepPaused,
    stepExpired,
    restRunning,
    restPaused,
    restExpired,
    intervalStep,
    intervalRest
  ]) {
    const forged = structuredClone(source);
    forged.timer.durationSeconds = 1;
    if (forged.timer.status === 'expired') {
      forged.timer.expirationOccurrenceId = `timer-expiration:${JSON.stringify([
        forged.timer.mode,
        forged.timer.stepId,
        forged.timer.setNumber,
        forged.timer.durationSeconds,
        forged.timer.startedAt
      ])}`;
    }
    assert.throws(
      () => assertWorkoutSession(forged),
      /session|timer|duration|PlanSnapshot/i
    );
  }
});

test('Session status and timer status must form a valid lifecycle state', () => {
  const initial = startedSession(singleTimedPlan());
  const stepId = initial.planSnapshot.steps[0].id;
  const running = applyWorkoutCommand(
    initial,
    command('start_step', 1, 'matrix_start', NOW, { stepId })
  ).session;
  const paused = applyWorkoutCommand(
    running,
    command('pause', 2, 'matrix_pause', NOW + 1_000, { reason: 'user' })
  ).session;
  const pausedWithRunningTimer = structuredClone(running);
  pausedWithRunningTimer.status = 'paused';
  const runningWithPausedTimer = structuredClone(paused);
  runningWithPausedTimer.status = 'in_progress';

  for (const invalid of [pausedWithRunningTimer, runningWithPausedTimer]) {
    assert.throws(
      () => assertWorkoutSession(invalid),
      /session|status|timer|paused|running/i
    );
  }
});

test('paused Sessions reject business progression until an explicit resume', () => {
  const scenarios = [
    {
      plan: singleTimedPlan(),
      commandType: 'start_step',
      payload(session) {
        return { stepId: session.planSnapshot.steps[0].id };
      },
      verify(session) {
        assert.equal(session.status, 'in_progress');
        assert.equal(session.timer.status, 'running');
      }
    },
    {
      plan: manualPlan(),
      commandType: 'complete_step',
      payload(session) {
        return { stepId: session.planSnapshot.steps[0].id };
      },
      verify(session) {
        assert.equal(session.status, 'completed');
      }
    },
    {
      plan: singleSetStrengthPlan(),
      commandType: 'complete_set',
      payload(session) {
        return {
          stepId: session.planSnapshot.steps[0].id,
          setNumber: 1,
          reps: 12,
          weightKg: 20
        };
      },
      verify(session) {
        assert.equal(session.status, 'completed');
      }
    }
  ];

  for (const scenario of scenarios) {
    const initial = startedSession(scenario.plan);
    const paused = applyWorkoutCommand(
      initial,
      command('pause', 1, `pause_before_${scenario.commandType}`, NOW + 1_000, {
        reason: 'user'
      })
    ).session;
    const beforeRejectedCommand = structuredClone(paused);

    assert.throws(
      () => applyWorkoutCommand(
        paused,
        command(
          scenario.commandType,
          2,
          `paused_${scenario.commandType}`,
          NOW + 2_000,
          scenario.payload(paused)
        )
      ),
      (error) => error && error.code === 'SESSION_STATUS_INVALID'
    );
    assert.deepEqual(paused, beforeRejectedCommand);

    const resumed = applyWorkoutCommand(
      paused,
      command('resume', 2, `resume_before_${scenario.commandType}`, NOW + 3_000, {
        reason: 'user'
      })
    ).session;
    const advanced = applyWorkoutCommand(
      resumed,
      command(
        scenario.commandType,
        3,
        `resumed_${scenario.commandType}`,
        NOW + 4_000,
        scenario.payload(resumed)
      )
    ).session;
    scenario.verify(advanced);
  }
});

test('Session checkpoints preserve TimerEngine rollback boundaries and fail closed without a timer', () => {
  function checkpointedTimedSession() {
    const initial = startedSession(singleTimedPlan());
    const stepId = initial.planSnapshot.steps[0].id;
    const running = applyWorkoutCommand(
      initial,
      command('start_step', 1, 'rollback_timer_start', NOW, { stepId })
    ).session;
    return applyWorkoutCommand(
      running,
      command('checkpoint', 2, 'rollback_timer_anchor', NOW + 10_000, { reason: 'hide' })
    ).session;
  }

  for (const rollbackMilliseconds of [1, 5_000]) {
    const anchored = checkpointedTimedSession();
    const restoredAt = anchored.lastCheckpointAt - rollbackMilliseconds;
    const restored = applyWorkoutCommand(
      anchored,
      command(
        'checkpoint',
        3,
        `rollback_timer_tolerated_${rollbackMilliseconds}`,
        restoredAt,
        { reason: 'startup' }
      )
    ).session;

    assert.equal(restored.status, 'in_progress');
    assert.equal(restored.timer.status, 'running');
    assert.equal(restored.timer.checkpointAt, restoredAt);
    assert.equal(restored.lastCheckpointAt, anchored.lastCheckpointAt);
    assert.equal(restored.elapsedActiveSeconds, anchored.elapsedActiveSeconds);
  }

  const anchored = checkpointedTimedSession();
  const anomalyAt = anchored.lastCheckpointAt - 5_001;
  const anomalous = applyWorkoutCommand(
    anchored,
    command('checkpoint', 3, 'rollback_timer_anomaly', anomalyAt, { reason: 'startup' })
  ).session;
  assert.equal(anomalous.status, 'paused');
  assert.equal(anomalous.timer.status, 'paused');
  assert.equal(anomalous.timer.pauseReason, 'clock-anomaly');
  assert.equal(anomalous.timer.requiresConfirmation, true);
  assert.equal(anomalous.lastCheckpointAt, anchored.lastCheckpointAt);
  assert.equal(anomalous.elapsedActiveSeconds, anchored.elapsedActiveSeconds);

  const confirmationAt = anchored.lastCheckpointAt + 5_000;
  const confirmed = applyWorkoutCommand(
    anomalous,
    command('resume', 4, 'rollback_timer_confirm', confirmationAt, { reason: 'clock-confirmed' })
  ).session;
  assert.equal(confirmed.status, 'in_progress');
  assert.equal(confirmed.timer.status, 'running');
  assert.equal(confirmed.timer.pauseReason, null);
  assert.equal(confirmed.lastCheckpointAt, confirmationAt);
  const afterConfirmation = applyWorkoutCommand(
    confirmed,
    command('checkpoint', 5, 'rollback_timer_after_confirm', confirmationAt + 1_000, {
      reason: 'manual'
    })
  ).session;
  assert.equal(
    afterConfirmation.elapsedActiveSeconds,
    anchored.elapsedActiveSeconds + 1
  );

  const timerlessAnchor = applyWorkoutCommand(
    startedSession(manualPlan()),
    command('checkpoint', 1, 'rollback_timerless_anchor', NOW + 10_000, { reason: 'hide' })
  ).session;
  for (const rollbackMilliseconds of [1, 5_000]) {
    const tolerated = applyWorkoutCommand(
      timerlessAnchor,
      command(
        'checkpoint',
        2,
        `rollback_timerless_tolerated_${rollbackMilliseconds}`,
        timerlessAnchor.lastCheckpointAt - rollbackMilliseconds,
        { reason: 'startup' }
      )
    ).session;
    assert.equal(tolerated.status, 'in_progress');
    assert.equal(tolerated.lastCheckpointAt, timerlessAnchor.lastCheckpointAt);
    assert.equal(tolerated.elapsedActiveSeconds, timerlessAnchor.elapsedActiveSeconds);
  }
  const completedWithinTolerance = applyWorkoutCommand(
    timerlessAnchor,
    command(
      'complete_step',
      2,
      'rollback_timerless_complete',
      timerlessAnchor.lastCheckpointAt - 5_000,
      { stepId: timerlessAnchor.planSnapshot.steps[0].id }
    )
  ).session;
  assert.equal(completedWithinTolerance.status, 'completed');
  assert.equal(completedWithinTolerance.endedAt, timerlessAnchor.lastCheckpointAt);
  assert.equal(
    completedWithinTolerance.stepResults[0].completedAt,
    timerlessAnchor.lastCheckpointAt
  );
  assert.throws(
    () => applyWorkoutCommand(
      timerlessAnchor,
      command(
        'checkpoint',
        2,
        'rollback_timerless_anomaly',
        timerlessAnchor.lastCheckpointAt - 5_001,
        { reason: 'startup' }
      )
    ),
    (error) => error && error.code === 'SESSION_CLOCK_ANOMALY'
  );
});

test('setResults must be contiguous and aligned with currentSet', () => {
  const firstSet = applyWorkoutCommand(
    startedSession(threeSetStrengthPlan()),
    command('complete_set', 1, 'integrity_set_1', NOW + 1_000, {
      stepId: threeSetStrengthPlan().steps[0].id,
      setNumber: 1,
      reps: 12,
      weightKg: 20
    })
  ).session;
  const skippedFirstSet = structuredClone(firstSet);
  skippedFirstSet.stepResults[0].setResults[0].setNumber = 2;
  const jumpedCurrentSet = structuredClone(firstSet);
  jumpedCurrentSet.currentSet = 3;
  jumpedCurrentSet.timer.setNumber = 3;

  for (const invalid of [skippedFirstSet, jumpedCurrentSet]) {
    assert.throws(
      () => assertWorkoutSession(invalid),
      /session|setResults|setNumber|contiguous|currentSet/i
    );
  }
});

test('set-tracking currentSet after one requires the current in-progress stepResult', () => {
  const initialStrength = startedSession(threeSetStrengthPlan());
  const missingCurrentResult = structuredClone(initialStrength);
  missingCurrentResult.currentSet = 2;

  assert.equal(assertWorkoutSession(initialStrength), initialStrength);
  assert.equal(assertWorkoutSession(startedSession(singleTimedPlan())).currentSet, null);
  assert.throws(
    () => assertWorkoutSession(missingCurrentResult),
    /session|currentSet|stepResult/i
  );
});

test('set-tracking steps cannot omit a required rest boundary after the first set', () => {
  const strength = startedSession(threeSetStrengthPlan());
  const strengthAfterSet = applyWorkoutCommand(
    strength,
    command('complete_set', 1, 'required_strength_rest', NOW + 1_000, {
      stepId: strength.planSnapshot.steps[0].id,
      setNumber: 1,
      reps: 12,
      weightKg: 20
    })
  ).session;
  const interval = startedSession(intervalPlan());
  const intervalStepId = interval.planSnapshot.steps[0].id;
  const intervalRunning = applyWorkoutCommand(
    interval,
    command('start_step', 1, 'required_interval_start', NOW, { stepId: intervalStepId })
  ).session;
  const intervalAfterSet = applyWorkoutCommand(
    intervalRunning,
    command('complete_step', 2, 'required_interval_rest', NOW + 60_000, {
      stepId: intervalStepId
    })
  ).session;

  for (const source of [strengthAfterSet, intervalAfterSet]) {
    assert.equal(source.currentSet, 2);
    assert.equal(source.timer.mode, 'rest');
    const missingRest = structuredClone(source);
    missingRest.timer = null;
    assert.throws(
      () => assertWorkoutSession(missingRest),
      /session|rest|timer|currentSet/i
    );
  }

  const noRestPlan = threeSetStrengthPlan();
  noRestPlan.steps[0].restSeconds = 0;
  const noRest = startedSession(noRestPlan);
  const noRestAfterSet = applyWorkoutCommand(
    noRest,
    command('complete_set', 1, 'zero_rest_allowed', NOW + 1_000, {
      stepId: noRest.planSnapshot.steps[0].id,
      setNumber: 1,
      reps: 12,
      weightKg: 20
    })
  ).session;
  assert.equal(noRestAfterSet.timer, null);
  assert.equal(assertWorkoutSession(noRestAfterSet), noRestAfterSet);
});

test('terminal Sessions keep completed and aborted positions/results in canonical shapes', () => {
  const timed = startedSession(singleTimedPlan());
  const stepId = timed.planSnapshot.steps[0].id;
  const running = applyWorkoutCommand(
    timed,
    command('start_step', 1, 'terminal_shape_start', NOW, { stepId })
  ).session;
  const completed = applyWorkoutCommand(
    running,
    command('complete_step', 2, 'terminal_shape_complete', NOW + 300_000, { stepId })
  ).session;
  assert.equal(assertWorkoutSession(completed), completed);

  const forgedCompleted = structuredClone(completed);
  forgedCompleted.currentStepIndex = 0;
  forgedCompleted.stepResults[0].status = 'in_progress';
  forgedCompleted.stepResults[0].completedAt = null;
  assert.throws(
    () => assertWorkoutSession(forgedCompleted),
    /session|completed|currentStepIndex|stepResult/i
  );

  const strength = startedSession(threeSetStrengthPlan());
  const partial = applyWorkoutCommand(
    strength,
    command('complete_set', 1, 'terminal_shape_partial', NOW + 1_000, {
      stepId: strength.planSnapshot.steps[0].id,
      setNumber: 1,
      reps: 12,
      weightKg: 20
    })
  ).session;
  const aborted = applyWorkoutCommand(
    partial,
    command('abort', 2, 'terminal_shape_abort', NOW + 2_000, { reason: 'user' })
  ).session;
  assert.equal(assertWorkoutSession(aborted), aborted);
  assert.equal(aborted.stepResults[0].status, 'in_progress');

  const forgedAborted = structuredClone(completed);
  forgedAborted.status = 'aborted';
  forgedAborted.currentStepIndex = 0;
  assert.throws(
    () => assertWorkoutSession(forgedAborted),
    /session|aborted|currentStepIndex|stepResult/i
  );
});

test('commands require revision and provide replay-safe idempotency without mutating input', () => {
  const initial = startedSession();
  const start = command(
    'start_step',
    1,
    'start_step_1',
    NOW,
    { stepId: initial.planSnapshot.steps[0].id }
  );
  const first = applyWorkoutCommand(initial, start);

  assert.equal(first.replayed, false);
  assert.equal(first.session.sessionRevision, 2);
  assert.equal(first.session.timer.mode, 'step');
  assert.equal(first.session.timer.stepId, initial.planSnapshot.steps[0].id);
  assert.equal(initial.timer, null);
  assert.equal(initial.sessionRevision, 1);

  const replay = applyWorkoutCommand(first.session, start);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.session, first.session);
  assert.notEqual(replay.session, first.session);

  assert.throws(
    () => applyWorkoutCommand(first.session, { ...start, payload: { stepId: 'different' } }),
    (error) => error && error.code === 'SESSION_COMMAND_KEY_REUSED'
  );
  assert.throws(
    () => applyWorkoutCommand(
      first.session,
      command('checkpoint', 1, 'stale_checkpoint', NOW + 1_000, { reason: 'hide' })
    ),
    (error) => error && error.code === 'SESSION_REVISION_CONFLICT'
  );
});

test('checkpoint and step completion atomically advance revision, elapsed time and timer state', () => {
  const initial = startedSession();
  const stepId = initial.planSnapshot.steps[0].id;
  const started = applyWorkoutCommand(
    initial,
    command('start_step', 1, 'start_timer', NOW, { stepId })
  ).session;
  const checkpointed = applyWorkoutCommand(
    started,
    command('checkpoint', 2, 'hide_checkpoint', NOW + 2_000, { reason: 'hide' })
  ).session;

  assert.equal(checkpointed.sessionRevision, 3);
  assert.equal(checkpointed.elapsedActiveSeconds, 2);
  assert.equal(checkpointed.lastCheckpointAt, NOW + 2_000);
  assert.equal(checkpointed.timer.remainingSecondsAtCheckpoint, 298);
  assert.equal(checkpointed.timer.checkpointAt, NOW + 2_000);

  assert.throws(
    () => applyWorkoutCommand(
      checkpointed,
      command('complete_step', 3, 'early_complete', NOW + 3_000, { stepId })
    ),
    (error) => error && error.code === 'SESSION_TIMER_NOT_EXPIRED'
  );

  const completed = applyWorkoutCommand(
    checkpointed,
    command('complete_step', 3, 'complete_step', NOW + 300_000, { stepId })
  ).session;
  assert.equal(completed.sessionRevision, 4);
  assert.equal(completed.currentStepIndex, 1);
  assert.equal(completed.timer, null);
  assert.deepEqual(completed.stepResults[0], {
    stepId,
    status: 'completed',
    completedAt: NOW + 300_000,
    setResults: []
  });
});

test('fractional checkpoints accumulate without dropping elapsed milliseconds', () => {
  const initial = startedSession(singleTimedPlan());
  const firstHalf = applyWorkoutCommand(
    initial,
    command('checkpoint', 1, 'fractional_checkpoint_1', NOW + 500, { reason: 'hide' })
  ).session;
  const secondHalf = applyWorkoutCommand(
    firstHalf,
    command('checkpoint', 2, 'fractional_checkpoint_2', NOW + 1_000, { reason: 'show' })
  ).session;

  assert.equal(firstHalf.elapsedActiveSeconds, 0);
  assert.equal(firstHalf.elapsedRemainderMilliseconds, 500);
  assert.equal(secondHalf.elapsedActiveSeconds, 1);
  assert.equal(secondHalf.elapsedRemainderMilliseconds, 0);
});

test('interval rest expiry starts every next set and completes the full interval step', () => {
  const initial = startedSession(intervalPlan());
  const step = initial.planSnapshot.steps[0];
  let session = initial;
  let nowMs = NOW;

  for (let setNumber = 1; setNumber <= step.sets; setNumber += 1) {
    session = applyWorkoutCommand(
      session,
      command('start_step', session.sessionRevision, `interval_start_${setNumber}`, nowMs, {
        stepId: step.id
      })
    ).session;
    assert.equal(session.timer.mode, 'step');

    nowMs = session.timer.expectedEndAt;
    session = applyWorkoutCommand(
      session,
      command('complete_step', session.sessionRevision, `interval_complete_${setNumber}`, nowMs, {
        stepId: step.id
      })
    ).session;

    if (setNumber < step.sets) {
      assert.equal(session.currentSet, setNumber + 1);
      assert.equal(session.timer.mode, 'rest');
      assert.equal(session.timer.setNumber, setNumber + 1);
      nowMs = session.timer.expectedEndAt;
    }
  }

  assert.equal(session.status, 'completed');
  assert.equal(session.currentStepIndex, 1);
  assert.deepEqual(
    session.stepResults[0].setResults.map(({ setNumber }) => setNumber),
    [1, 2, 3, 4, 5]
  );
});

test('set completion rejects double transitions and keeps rest timer identity with next set', () => {
  const initial = startedSession(strengthPlan());
  const stepId = initial.planSnapshot.steps[0].id;
  const completed = applyWorkoutCommand(
    initial,
    command('complete_set', 1, 'set_1', NOW + 1_000, {
      stepId,
      setNumber: 1,
      reps: 12,
      weightKg: 20
    })
  ).session;

  assert.equal(completed.currentSet, 2);
  assert.equal(completed.timer.mode, 'rest');
  assert.equal(completed.timer.stepId, stepId);
  assert.equal(completed.timer.setNumber, 2);
  assert.deepEqual(completed.stepResults[0].setResults[0], {
    setNumber: 1,
    reps: 12,
    weightKg: 20,
    completedAt: NOW + 1_000
  });
  assert.throws(
    () => applyWorkoutCommand(
      completed,
      command('complete_set', 2, 'set_1_again', NOW + 2_000, {
        stepId,
        setNumber: 1,
        reps: 12,
        weightKg: 20
      })
    ),
    (error) => error && error.code === 'SESSION_SET_ALREADY_COMPLETED'
  );
});

test('terminal Sessions reject new transitions while exact command replay remains safe', () => {
  const initial = startedSession(singleTimedPlan());
  const stepId = initial.planSnapshot.steps[0].id;
  const started = applyWorkoutCommand(
    initial,
    command('start_step', 1, 'terminal_start', NOW, { stepId })
  ).session;
  const finish = command('complete_step', 2, 'terminal_finish', NOW + 300_000, { stepId });
  const terminal = applyWorkoutCommand(started, finish).session;

  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.endedAt, NOW + 300_000);
  assert.equal(terminal.currentStepIndex, 1);
  assert.equal(applyWorkoutCommand(terminal, finish).replayed, true);
  assert.throws(
    () => applyWorkoutCommand(
      terminal,
      command('checkpoint', 3, 'after_terminal', NOW + 301_000, { reason: 'hide' })
    ),
    (error) => error && error.code === 'SESSION_TERMINAL'
  );
});

test('pause freezes elapsed/timer progress, resume restarts it, and abort is replay-safe terminal', () => {
  const initial = startedSession();
  const stepId = initial.planSnapshot.steps[0].id;
  const started = applyWorkoutCommand(
    initial,
    command('start_step', 1, 'pause_start', NOW, { stepId })
  ).session;
  const paused = applyWorkoutCommand(
    started,
    command('pause', 2, 'pause_session', NOW + 1_000, { reason: 'user' })
  ).session;

  assert.equal(paused.status, 'paused');
  assert.equal(paused.elapsedActiveSeconds, 1);
  assert.equal(paused.timer.status, 'paused');
  assert.equal(paused.timer.remainingSecondsAtCheckpoint, 299);

  const hidden = applyWorkoutCommand(
    paused,
    command('checkpoint', 3, 'paused_hide', NOW + 5_000, { reason: 'hide' })
  ).session;
  assert.equal(hidden.elapsedActiveSeconds, 1);
  assert.equal(hidden.timer.remainingSecondsAtCheckpoint, 299);

  const resumed = applyWorkoutCommand(
    hidden,
    command('resume', 4, 'resume_session', NOW + 6_000, { reason: 'user' })
  ).session;
  assert.equal(resumed.status, 'in_progress');
  assert.equal(resumed.timer.status, 'running');
  assert.equal(resumed.timer.expectedEndAt, NOW + 305_000);

  const abort = command('abort', 5, 'abort_session', NOW + 7_000, { reason: 'user' });
  const aborted = applyWorkoutCommand(resumed, abort).session;
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.endedAt, NOW + 7_000);
  assert.equal(aborted.timer, null);
  assert.equal(applyWorkoutCommand(aborted, abort).replayed, true);
  assert.throws(
    () => applyWorkoutCommand(
      aborted,
      command('checkpoint', 6, 'after_abort', NOW + 8_000, { reason: 'hide' })
    ),
    (error) => error && error.code === 'SESSION_TERMINAL'
  );
});

test('command boundary rejects custom prototypes, unknown fields and unsafe values', () => {
  const session = startedSession();
  const valid = command('checkpoint', 1, 'safe', NOW, { reason: 'hide' });
  const getter = { ...valid };
  Object.defineProperty(getter, 'payload', {
    enumerable: true,
    get() {
      throw new Error('getter must never execute');
    }
  });

  for (const candidate of [
    Object.assign(Object.create({ inherited: true }), valid),
    { ...valid, unknown: true },
    { ...valid, nowMs: Number.POSITIVE_INFINITY },
    { ...valid, expectedSessionRevision: -0 },
    { ...valid, payload: { reason: 'hide', unknown: true } },
    getter
  ]) {
    assert.throws(() => applyWorkoutCommand(session, candidate));
  }
});
