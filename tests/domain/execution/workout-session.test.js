const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertWorkoutSession,
  createWorkoutSession
} = require('../../../miniprogram/domain/execution/workout-session');
const {
  createDefaultPlans
} = require('../../../miniprogram/domain/planning/default-plan-factory');

const NOW = 1785717300000;

function timedPlan() {
  return createDefaultPlans({ now: () => NOW })[0];
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

  for (const candidate of [
    Object.assign(Object.create({ inherited: true }), valid),
    { ...valid, unknown: true },
    { ...valid, elapsedActiveSeconds: undefined },
    { ...valid, elapsedActiveSeconds: Number.POSITIVE_INFINITY },
    getter,
    nonEnumerable
  ]) {
    assert.throws(() => assertWorkoutSession(candidate), /session|JSON|field|prototype|finite|safe|enumerable/i);
  }
});
