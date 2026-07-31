const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWorkoutSummaryRuntime
} = require('../../miniprogram/application/workout-summary-runtime');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createWorkoutSummaryPageDefinition
} = require('../../miniprogram/pages/workout/summary/index');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785717300000;

function manualPlan(id, trainingDate, title) {
  const source = createDefaultPlans({ now: () => START_AT })[2];
  return {
    ...clone(source),
    id,
    trainingDate,
    title,
    templateSource: null,
    steps: [{ ...clone(source.steps.find(({ kind }) => kind === 'manual')), order: 1 }]
  };
}

function completeSession(repository, { plan, sessionId, endedAt }) {
  const ready = repository.start({
    plan,
    sessionId,
    originDeviceId: 'device_summary_binding',
    commandKey: `start_${sessionId}`,
    nowMs: endedAt - 60_000
  });
  return repository.apply({
    type: 'complete_step',
    expectedSessionRevision: ready.sessionRevision,
    commandKey: `complete_${sessionId}`,
    nowMs: endedAt,
    payload: { stepId: ready.planSnapshot.steps[0].id }
  }, { originDeviceId: 'device_summary_binding' }).session;
}

function historyFixture() {
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => START_AT + 300_000
  });
  const repository = createSessionRepository({ database });
  const sessionA = completeSession(repository, {
    plan: manualPlan('plan_summary_a', '2026-09-06', '历史训练 A'),
    sessionId: 'session_summary_a',
    endedAt: START_AT + 60_000
  });
  const sessionB = completeSession(repository, {
    plan: manualPlan('plan_summary_b', '2026-09-07', '当前训练 B'),
    sessionId: 'session_summary_b',
    endedAt: START_AT + 180_000
  });
  return { database, sessionA, sessionB };
}

function mount(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setData(next) { this.data = { ...this.data, ...next }; }
  };
}

test('production summary page passes the exact route sessionId and fails closed when missing', () => {
  const calls = [];
  const runtime = {
    load(input) {
      calls.push(input);
      if (!input || typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
        throw new Error('sessionId is required');
      }
      return {
        summary: {
          sessionId: input.sessionId,
          status: 'completed',
          trainingDate: '2026-09-06',
          planTitle: '绑定测试',
          elapsedActiveSeconds: 60,
          elapsedLabel: '01:00',
          completedStepCount: 1,
          skippedStepCount: 0,
          totalStepCount: 1,
          endedAt: START_AT + 60_000
        },
        feedback: null,
        saved: false
      };
    }
  };
  const definition = createWorkoutSummaryPageDefinition({
    runtimeFactory: () => runtime,
    getWx: () => ({
      getAccountInfoSync() { return { miniProgram: { envVersion: 'release' } }; }
    })
  });
  const bound = mount(definition);
  bound.onLoad({ sessionId: 'session_summary_a' });
  assert.deepEqual(calls[0], { sessionId: 'session_summary_a' });
  assert.equal(bound.data.summary.sessionId, 'session_summary_a');
  assert.equal(bound.data.validationError, null);

  const missing = mount(definition);
  missing.onLoad({});
  assert.deepEqual(calls[1], { sessionId: undefined });
  assert.match(missing.data.validationError, /sessionId.*required/i);
  assert.equal(missing.data.summary, null);
});

test('historical A route loads and saves A from its baseline record while active terminal Session is B', () => {
  const { database, sessionA, sessionB } = historyFixture();
  const runtime = createWorkoutSummaryRuntime({
    database,
    now: () => START_AT + 360_000
  });

  const loaded = runtime.load({ sessionId: sessionA.id });
  assert.equal(loaded.summary.sessionId, sessionA.id);
  assert.equal(loaded.summary.planTitle, '历史训练 A');
  assert.equal(loaded.feedback.rpe, null);
  assert.equal(loaded.saved, false);
  assert.equal(database.load().activeSession.id, sessionB.id);

  runtime.saveFeedback({ rpe: 7, note: 'A feedback' });
  const saved = database.load();
  assert.equal(saved.activeSession.id, sessionB.id);
  const recordA = saved.records.find(({ sourceSessionId }) => sourceSessionId === sessionA.id);
  const recordB = saved.records.find(({ sourceSessionId }) => sourceSessionId === sessionB.id);
  assert.equal(recordA.feedback.rpe, 7);
  assert.equal(recordA.feedback.note, 'A feedback');
  assert.equal(recordA.revision, 2);
  assert.equal(recordB.feedback, null);
  assert.equal(recordB.revision, 1);

  const reloaded = createWorkoutSummaryRuntime({ database })
    .load({ sessionId: sessionA.id });
  assert.equal(reloaded.saved, true);
  assert.equal(reloaded.feedback.rpe, 7);
  assert.equal(reloaded.summary.sessionId, sessionA.id);
});

test('missing, conflicting or tampered historical sessionId fails closed without falling back to active B', async (t) => {
  for (const mode of ['missing', 'conflict', 'tamper']) {
    await t.test(mode, () => {
      const { database, sessionA, sessionB } = historyFixture();
      if (mode === 'conflict') {
        database.commit((draft) => {
          draft.records.push(clone(
            draft.records.find(({ sourceSessionId }) => sourceSessionId === sessionA.id)
          ));
        });
      } else if (mode === 'tamper') {
        database.commit((draft) => {
          const record = draft.records.find(
            ({ sourceSessionId }) => sourceSessionId === sessionA.id
          );
          record.stepResults[0].completedAt -= 1;
        });
      }
      const before = database.load();
      const requestedSessionId = mode === 'missing' ? 'session_summary_missing' : sessionA.id;
      assert.throws(
        () => createWorkoutSummaryRuntime({ database }).load({ sessionId: requestedSessionId }),
        /不存在|冲突|不匹配|损坏|找不到/
      );
      const after = database.load();
      assert.equal(after.localRevision, before.localRevision);
      assert.deepEqual(after.records, before.records);
      assert.equal(after.activeSession.id, sessionB.id);
    });
  }
});
