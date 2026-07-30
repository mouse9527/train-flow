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

function singleTimedPlan() {
  const plan = timedPlan();
  plan.id = 'plan_timed_fixture';
  plan.steps = [{ ...plan.steps[0], order: 1 }];
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
