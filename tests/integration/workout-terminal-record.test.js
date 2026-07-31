const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785717300000;

function manualPlan(id, trainingDate) {
  const source = createDefaultPlans({ now: () => START_AT })[2];
  return {
    ...clone(source),
    id,
    trainingDate,
    templateSource: null,
    steps: [{ ...clone(source.steps.find(({ kind }) => kind === 'manual')), order: 1 }]
  };
}

function startManualSession(repository, { plan, sessionId }) {
  return repository.start({
    plan,
    sessionId,
    originDeviceId: 'device_terminal_record',
    commandKey: `start_${sessionId}`,
    nowMs: START_AT
  });
}

test('terminal command atomically creates exactly one canonical pending TrainingRecord', () => {
  for (const status of ['completed', 'aborted']) {
    const database = createLocalDatabase({
      storage: new StorageDouble(),
      now: () => START_AT + 90_000
    });
    const repository = createSessionRepository({ database });
    const plan = manualPlan(`plan_terminal_record_${status}`, '2026-09-03');
    const started = startManualSession(repository, {
      plan,
      sessionId: `session_terminal_record_${status}`
    });
    const terminalCommand = {
      type: status === 'completed' ? 'complete_step' : 'abort',
      expectedSessionRevision: started.sessionRevision,
      commandKey: `terminal_${status}`,
      nowMs: START_AT + 60_000,
      payload: status === 'completed'
        ? { stepId: started.planSnapshot.steps[0].id }
        : { reason: 'user-ended-workout' }
    };
    const before = database.load();

    const terminal = repository.apply(terminalCommand, {
      originDeviceId: 'device_terminal_record'
    });
    const after = database.load();

    assert.equal(terminal.session.status, status);
    assert.equal(after.localRevision, before.localRevision + 1);
    assert.equal(after.activeSession.status, status);
    assert.equal(after.records.length, 1);
    const record = after.records[0];
    assert.equal(record.id, `record_${terminal.session.id}`);
    assert.equal(record.sourceSessionId, terminal.session.id);
    assert.equal(record.status, status);
    assert.equal(record.feedback, null);
    assert.equal(record.revision, 1);
    assert.equal(record.createdAt, terminal.session.endedAt);
    assert.equal(record.updatedAt, terminal.session.endedAt);
    assert.deepEqual(record.planSnapshot, terminal.session.planSnapshot);
    assert.deepEqual(record.stepResults, terminal.session.stepResults);
    assert.equal(record.completedStepCount, status === 'completed' ? 1 : 0);
    assert.equal(record.skippedStepCount, 0);
    assert.equal(record.totalStepCount, 1);
    assert.match(record.sourceSessionFingerprint, /^[a-f0-9]{64}$/);

    const replay = repository.apply(terminalCommand, {
      originDeviceId: 'device_terminal_record'
    });
    const replayed = database.load();
    assert.equal(replay.replayed, true);
    assert.equal(replayed.localRevision, after.localRevision);
    assert.equal(replayed.records.length, 1);
    assert.deepEqual(replayed.records[0], record);
  }
});

test('starting a new Session preserves the previous terminal baseline record', () => {
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => START_AT + 120_000
  });
  const repository = createSessionRepository({ database });
  const firstPlan = manualPlan('plan_terminal_preserved_a', '2026-09-04');
  const started = startManualSession(repository, {
    plan: firstPlan,
    sessionId: 'session_terminal_preserved_a'
  });
  repository.apply({
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: 'terminal_preserved_a',
    nowMs: START_AT + 60_000,
    payload: { stepId: started.planSnapshot.steps[0].id }
  }, { originDeviceId: 'device_terminal_record' });

  const second = repository.start({
    plan: manualPlan('plan_terminal_preserved_b', '2026-09-05'),
    sessionId: 'session_terminal_preserved_b',
    originDeviceId: 'device_terminal_record',
    commandKey: 'start_session_terminal_preserved_b',
    nowMs: START_AT + 120_000
  });
  const snapshot = database.load();

  assert.equal(second.id, 'session_terminal_preserved_b');
  assert.equal(snapshot.activeSession.id, second.id);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].sourceSessionId, 'session_terminal_preserved_a');
  assert.equal(snapshot.records[0].feedback, null);
});
