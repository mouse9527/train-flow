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

test('completed and aborted historical records reserve their Session IDs before replacement start', () => {
  for (const status of ['completed', 'aborted']) {
    const database = createLocalDatabase({
      storage: new StorageDouble(),
      now: () => START_AT + 180_000
    });
    const repository = createSessionRepository({ database });
    const sessionId = `session_reserved_history_${status}`;
    const started = startManualSession(repository, {
      plan: manualPlan(`plan_reserved_history_${status}`, '2026-09-08'),
      sessionId
    });
    repository.apply({
      type: status === 'completed' ? 'complete_step' : 'abort',
      expectedSessionRevision: started.sessionRevision,
      commandKey: `terminal_reserved_history_${status}`,
      nowMs: START_AT + 60_000,
      payload: status === 'completed'
        ? { stepId: started.planSnapshot.steps[0].id }
        : { reason: 'user-ended-workout' }
    }, { originDeviceId: 'device_terminal_record' });
    const beforeReuse = database.load();

    assert.throws(
      () => repository.start({
        plan: manualPlan(`plan_illegal_reuse_${status}`, '2026-09-09'),
        sessionId,
        originDeviceId: 'device_terminal_record',
        commandKey: `new_intent_reusing_${status}`,
        nowMs: START_AT + 120_000
      }),
      (error) => error &&
        error.code === 'SESSION_ID_REUSED' &&
        /historical|record|already/i.test(error.message)
    );
    assert.deepEqual(
      database.load(),
      beforeReuse,
      `${status} Session ID reuse must be a zero-write rejection`
    );

    const nextId = `session_reserved_history_${status}_next`;
    const next = repository.start({
      plan: manualPlan(`plan_reserved_history_${status}_next`, '2026-09-10'),
      sessionId: nextId,
      originDeviceId: 'device_terminal_record',
      commandKey: `start_${nextId}`,
      nowMs: START_AT + 120_000
    });
    const afterNext = database.load();
    assert.equal(next.id, nextId);
    assert.equal(afterNext.activeSession.id, nextId);
    assert.equal(afterNext.records.length, 1);
    assert.deepEqual(afterNext.records, beforeReuse.records);
  }
});

test('record identity collisions, duplicates and tampered candidates reserve a future Session ID', async (t) => {
  const collisionFactories = {
    'canonical record id': (candidateId) => [{
      id: `record_${candidateId}`,
      sourceSessionId: 'unrelated_source'
    }],
    'source Session id': (candidateId) => [{
      id: 'forged_noncanonical_record',
      sourceSessionId: candidateId
    }],
    'duplicate candidates': (candidateId) => [{
      id: `record_${candidateId}`,
      sourceSessionId: 'unrelated_source'
    }, {
      id: 'second_forged_record',
      sourceSessionId: candidateId
    }],
    'tampered candidate': (candidateId) => [{
      id: `record_${candidateId}`,
      sourceSessionId: candidateId,
      status: 'forged',
      feedback: { rpe: 'not-canonical' }
    }]
  };

  for (const [index, [label, createCollisions]] of Object.entries(collisionFactories).entries()) {
    await t.test(label, () => {
      const database = createLocalDatabase({
        storage: new StorageDouble(),
        now: () => START_AT + 180_000
      });
      const repository = createSessionRepository({ database });
      const started = startManualSession(repository, {
        plan: manualPlan(`plan_collision_history_${index}`, '2026-09-11'),
        sessionId: `session_collision_history_${index}`
      });
      repository.apply({
        type: 'complete_step',
        expectedSessionRevision: started.sessionRevision,
        commandKey: `terminal_collision_history_${index}`,
        nowMs: START_AT + 60_000,
        payload: { stepId: started.planSnapshot.steps[0].id }
      }, { originDeviceId: 'device_terminal_record' });

      const candidateId = `session_collision_candidate_${index}`;
      database.commit((draft) => {
        draft.records.push(...clone(createCollisions(candidateId)));
      });
      const before = database.load();
      assert.throws(
        () => repository.start({
          plan: manualPlan(`plan_collision_candidate_${index}`, '2026-09-12'),
          sessionId: candidateId,
          originDeviceId: 'device_terminal_record',
          commandKey: `start_collision_candidate_${index}`,
          nowMs: START_AT + 120_000
        }),
        (error) => error && error.code === 'SESSION_ID_REUSED'
      );
      assert.deepEqual(database.load(), before, `${label} must reject with zero writes`);
    });
  }
});
