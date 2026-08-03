const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRecordApplicationService
} = require('../../miniprogram/application/record-application-service');

function clone(value) {
  return structuredClone(value);
}

function effectiveRecord(overrides = {}) {
  return {
    id: 'record_application_fixture',
    sourceSessionId: 'session_application_fixture',
    revision: 4,
    status: 'aborted',
    trainingDate: '2026-08-03',
    startedAt: 1785717300000,
    endedAt: 1785719340000,
    elapsedActiveSeconds: 925,
    planSnapshot: {
      title: '全身基础训练',
      steps: [
        { id: 'step_manual', order: 10, name: '深蹲', kind: 'manual' },
        { id: 'step_timed', order: 20, name: '平板支撑', kind: 'timed' },
        { id: 'step_strength', order: 30, name: '哑铃划船', kind: 'strength' }
      ]
    },
    stepResults: [
      { stepId: 'step_manual', status: 'completed', completedAt: 1785718000000, setResults: [], actualReps: 12 },
      { stepId: 'step_timed', status: 'skipped', completedAt: 1785718100000, setResults: [], actualDurationSeconds: null },
      { stepId: 'step_strength', status: 'unknown', completedAt: null, setResults: [] }
    ],
    actualCorrections: [{ stepId: 'step_manual', actualReps: 12 }],
    feedback: {
      rpe: 7,
      weightBeforeKg: 81.5,
      pain: {
        knee: true,
        lowerBack: false,
        ankleOrToe: false,
        dizziness: false
      },
      note: '膝盖轻微不适'
    },
    ...overrides
  };
}

function repositoryDouble(records = [effectiveRecord()]) {
  let current = clone(records);
  const calls = { list: [], findById: [], correct: [], delete: [] };
  return {
    calls,
    list(query) {
      calls.list.push(clone(query));
      return clone(current.filter((record) => (
        (query.trainingDate === null || record.trainingDate === query.trainingDate) &&
        (query.kind === null || record.planSnapshot.steps.some(({ kind }) => kind === query.kind))
      )));
    },
    findById(recordId) {
      calls.findById.push(recordId);
      return clone(current.find(({ id }) => id === recordId) || null);
    },
    correct(command) {
      calls.correct.push(clone(command));
      const index = current.findIndex(({ id }) => id === command.recordId);
      current[index] = {
        ...current[index],
        revision: current[index].revision + 1,
        actualCorrections: clone(command.actualCorrections),
        feedback: clone(command.feedback)
      };
      return clone(current[index]);
    },
    delete(command) {
      calls.delete.push(clone(command));
      const index = current.findIndex(({ id }) => id === command.recordId);
      const [removed] = current.splice(index, 1);
      return { ...clone(removed), revision: removed.revision + 1, deletedAt: command.nowMs };
    }
  };
}

test('record application maps deterministic filters, list summaries and honest completed/skipped/unknown detail', () => {
  const repository = repositoryDouble([
    effectiveRecord(),
    effectiveRecord({
      id: 'record_application_completed',
      sourceSessionId: 'session_application_completed',
      revision: 2,
      status: 'completed',
      trainingDate: '2026-08-04',
      endedAt: 1785805740000,
      elapsedActiveSeconds: 2040,
      planSnapshot: {
        title: '间歇训练',
        steps: [{ id: 'step_interval', order: 10, name: '划船间歇', kind: 'interval' }]
      },
      stepResults: [{
        stepId: 'step_interval',
        status: 'completed',
        completedAt: 1785805740000,
        setResults: [],
        actualDurationSeconds: 300
      }],
      actualCorrections: [{ stepId: 'step_interval', actualDurationSeconds: 300 }],
      feedback: null
    })
  ]);
  const application = createRecordApplicationService({ repository });

  const view = application.getView({
    trainingDate: null,
    kind: null,
    selectedRecordId: 'record_application_fixture'
  });

  assert.deepEqual(repository.calls.list, [{ trainingDate: null, kind: null }]);
  assert.equal(view.records.length, 2);
  assert.deepEqual(view.kindOptions.map(({ value }) => value), [null, 'manual', 'timed', 'interval', 'strength']);
  assert.equal(view.records[0].statusLabel, '已中止');
  assert.equal(view.records[0].progressLabel, '1 完成 · 1 跳过 · 1 未执行');
  assert.equal(view.records[0].durationLabel, '15:25');
  assert.equal(view.records[0].hasPain, true);
  assert.equal(view.selectedRecord.id, 'record_application_fixture');
  assert.deepEqual(
    view.selectedRecord.steps.map(({ statusLabel, actualLabel }) => [statusLabel, actualLabel]),
    [['已完成', '12 次'], ['已跳过', '未记录'], ['未执行', '未记录']]
  );
  assert.equal(view.selectedRecord.feedback.rpe, 7);
  assert.equal(view.emptyState, null);

  const filtered = application.getView({
    trainingDate: '2026-08-04',
    kind: 'interval',
    selectedRecordId: null
  });
  assert.equal(filtered.records.length, 1);
  assert.equal(filtered.selectedRecord.id, 'record_application_completed');
  assert.equal(filtered.filters.trainingDate, '2026-08-04');
  assert.equal(filtered.filters.kind, 'interval');

  const empty = application.getView({
    trainingDate: '2099-01-01',
    kind: null,
    selectedRecordId: null
  });
  assert.deepEqual(empty.records, []);
  assert.equal(empty.selectedRecord, null);
  assert.match(empty.emptyState.title, /没有训练记录/);
  assert.match(empty.emptyState.guidance, /调整日期|类型/);
});

test('record application builds a closed correction command only from completed editable actuals and canonical feedback', () => {
  const repository = repositoryDouble();
  const application = createRecordApplicationService({ repository });
  const record = effectiveRecord();
  const draft = application.createEditDraft(record);
  draft.steps[0].actualReps = '15';
  draft.steps[1].actualDurationSeconds = '999';
  draft.feedback.rpe = '8';
  draft.feedback.weightBeforeKg = '';
  draft.feedback.pain.lowerBack = true;
  draft.feedback.note = '更新后的匿名备注';

  const corrected = application.correctRecord({
    recordId: record.id,
    expectedRevision: record.revision,
    commandKey: 'record-app-correct',
    nowMs: 1785719400000,
    draft
  });

  assert.equal(corrected.revision, record.revision + 1);
  assert.deepEqual(repository.calls.correct, [{
    recordId: record.id,
    expectedRevision: record.revision,
    commandKey: 'record-app-correct',
    nowMs: 1785719400000,
    actualCorrections: [{ stepId: 'step_manual', actualReps: 15 }],
    feedback: {
      rpe: 8,
      weightBeforeKg: null,
      pain: {
        knee: true,
        lowerBack: true,
        ankleOrToe: false,
        dizziness: false
      },
      note: '更新后的匿名备注'
    }
  }]);
  assert.equal(draft.steps[1].status, 'skipped', 'skipped actual inputs are not promoted into correction payloads');
});

test('record application maps strength set corrections and delegates stale-safe deletion without leaking record payloads', () => {
  const strength = effectiveRecord({
    id: 'record_application_strength',
    sourceSessionId: 'session_application_strength',
    status: 'completed',
    planSnapshot: {
      title: '力量训练',
      steps: [{ id: 'step_strength_done', order: 10, name: '划船', kind: 'strength' }]
    },
    stepResults: [{
      stepId: 'step_strength_done',
      status: 'completed',
      completedAt: 1785719000000,
      setResults: [
        { setNumber: 1, reps: 10, weightKg: 20, completedAt: 1785718500000 },
        { setNumber: 2, reps: 9, weightKg: 22.5, completedAt: 1785719000000 }
      ]
    }],
    actualCorrections: [],
    feedback: {
      rpe: 6,
      weightBeforeKg: null,
      pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
      note: ''
    }
  });
  const repository = repositoryDouble([strength]);
  const application = createRecordApplicationService({ repository });
  const draft = application.createEditDraft(strength);
  draft.steps[0].sets[1].weightKg = '25';

  application.correctRecord({
    recordId: strength.id,
    expectedRevision: strength.revision,
    commandKey: 'record-app-strength',
    nowMs: 1785719500000,
    draft
  });
  assert.deepEqual(repository.calls.correct[0].actualCorrections, [{
    stepId: 'step_strength_done',
    setCorrections: [
      { setNumber: 1, reps: 10, weightKg: 20 },
      { setNumber: 2, reps: 9, weightKg: 25 }
    ]
  }]);

  application.deleteRecord({
    recordId: strength.id,
    expectedRevision: strength.revision + 1,
    commandKey: 'record-app-delete',
    nowMs: 1785719600000
  });
  assert.deepEqual(repository.calls.delete, [{
    recordId: strength.id,
    expectedRevision: strength.revision + 1,
    commandKey: 'record-app-delete',
    nowMs: 1785719600000
  }]);
});
