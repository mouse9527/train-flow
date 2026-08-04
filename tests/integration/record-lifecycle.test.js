const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRecordApplicationService
} = require('../../miniprogram/application/record-application-service');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  findTrainingRecords
} = require('../../miniprogram/domain/execution/training-record');
const {
  isDeletedTrainingRecord
} = require('../../miniprogram/domain/records/training-record');
const {
  createTrainingRecordRepository
} = require('../../miniprogram/domain/records/training-record-repository');
const {
  createRecordPageDefinition
} = require('../../miniprogram/pages/record/index');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1786234500000;

function manualPlan() {
  const source = createDefaultPlans({ now: () => START_AT })[2];
  return {
    ...clone(source),
    id: 'plan_record_lifecycle',
    title: '记录生命周期训练',
    trainingDate: '2026-08-09',
    templateSource: null,
    steps: [{
      ...clone(source.steps.find(({ kind }) => kind === 'manual')),
      id: 'step_record_lifecycle_manual',
      order: 10
    }]
  };
}

function assignDataPath(target, pathExpression, value) {
  const parts = pathExpression
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current = current[part];
  }
  current[parts.at(-1)] = clone(value);
}

function mount(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setData(patch) {
      for (const [pathExpression, value] of Object.entries(patch)) {
        if (pathExpression.includes('.') || pathExpression.includes('[')) {
          assignDataPath(this.data, pathExpression, value);
        } else {
          this.data[pathExpression] = clone(value);
        }
      }
    }
  };
}

test('real record lifecycle materializes from terminal Session, edits through application/repository and deletes to a hidden tombstone', () => {
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => START_AT + 300_000
  });
  const sessions = createSessionRepository({ database });
  const records = createTrainingRecordRepository({ database });
  const application = createRecordApplicationService({ repository: records });
  const started = sessions.start({
    plan: manualPlan(),
    sessionId: 'session_record_lifecycle',
    originDeviceId: 'device_record_lifecycle',
    commandKey: 'start_record_lifecycle',
    nowMs: START_AT
  });
  sessions.apply({
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: 'complete_record_lifecycle',
    nowMs: START_AT + 60_000,
    payload: { stepId: started.planSnapshot.steps[0].id }
  }, { originDeviceId: 'device_record_lifecycle' });

  const initial = application.getView();
  assert.equal(initial.records.length, 1);
  assert.equal(initial.selectedRecord.statusLabel, '已完成');
  assert.equal(initial.selectedRecord.steps[0].statusLabel, '已完成');
  assert.equal(initial.selectedRecord.steps[0].actualLabel, '未记录');

  const draft = application.createEditDraft(initial.selectedRecord);
  draft.steps[0].actualReps = '18';
  draft.feedback.rpe = '8';
  draft.feedback.weightBeforeKg = '80.5';
  draft.feedback.pain.knee = true;
  draft.feedback.note = '匿名集成记录';
  application.correctRecord({
    recordId: initial.selectedRecord.id,
    expectedRevision: initial.selectedRecord.revision,
    commandKey: 'correct_record_lifecycle',
    nowMs: START_AT + 120_000,
    draft
  });

  const corrected = application.getView({
    selectedRecordId: initial.selectedRecord.id
  });
  assert.equal(corrected.selectedRecord.steps[0].actualLabel, '18 次');
  assert.equal(corrected.selectedRecord.feedback.rpe, 8);
  assert.equal(corrected.selectedRecord.feedback.note, '匿名集成记录');
  const afterCorrection = database.load();
  assert.equal(afterCorrection.sync.outbox.at(-1).entityType, 'training_record');
  assert.equal(afterCorrection.sync.outbox.at(-1).action, 'upsert');
  assert.deepEqual(afterCorrection.sync.outbox.at(-1).payload, afterCorrection.records[0]);
  assert.equal(afterCorrection.statisticsProjection.dirty, true);

  application.deleteRecord({
    recordId: corrected.selectedRecord.id,
    expectedRevision: corrected.selectedRecord.revision,
    commandKey: 'delete_record_lifecycle',
    nowMs: START_AT + 180_000
  });

  const empty = application.getView();
  assert.deepEqual(empty.records, []);
  assert.equal(empty.selectedRecord, null);
  assert.match(empty.emptyState.title, /没有训练记录/);
  const durable = findTrainingRecords(
    database.load().records,
    'session_record_lifecycle'
  );
  assert.equal(durable.length, 1);
  assert.equal(isDeletedTrainingRecord(durable[0]), true);
  assert.equal(database.load().sync.outbox.at(-1).action, 'delete');
  assert.equal(database.load().sync.outbox.at(-1).payload, null);
});

test('real record lifecycle preserves null feedback during an actual-only correction', () => {
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => START_AT + 300_000
  });
  const sessions = createSessionRepository({ database });
  const application = createRecordApplicationService({
    repository: createTrainingRecordRepository({ database })
  });
  const started = sessions.start({
    plan: manualPlan(),
    sessionId: 'session_record_without_feedback',
    originDeviceId: 'device_record_without_feedback',
    commandKey: 'start_record_without_feedback',
    nowMs: START_AT
  });
  sessions.apply({
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: 'complete_record_without_feedback',
    nowMs: START_AT + 60_000,
    payload: { stepId: started.planSnapshot.steps[0].id }
  }, { originDeviceId: 'device_record_without_feedback' });

  const initial = application.getView();
  assert.equal(initial.selectedRecord.feedbackMissing, true);
  const draft = application.createEditDraft(initial.selectedRecord);
  draft.steps[0].actualReps = '18';
  application.correctRecord({
    recordId: initial.selectedRecord.id,
    expectedRevision: initial.selectedRecord.revision,
    commandKey: 'correct_record_without_feedback',
    nowMs: START_AT + 120_000,
    draft
  });

  const corrected = application.getView({ selectedRecordId: initial.selectedRecord.id });
  assert.equal(corrected.selectedRecord.steps[0].actualLabel, '18 次');
  assert.equal(corrected.selectedRecord.feedbackMissing, true);
  assert.equal(corrected.selectedRecord.feedback.rpe, null);
  const durable = findTrainingRecords(
    database.load().records,
    'session_record_without_feedback'
  )[0];
  assert.equal(durable.feedback, null);
});

test('real record page drives the production application and repository through edit and confirmed delete', () => {
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => START_AT + 300_000
  });
  const sessions = createSessionRepository({ database });
  const repository = createTrainingRecordRepository({ database });
  const application = createRecordApplicationService({ repository });
  const started = sessions.start({
    plan: manualPlan(),
    sessionId: 'session_record_page_lifecycle',
    originDeviceId: 'device_record_page_lifecycle',
    commandKey: 'start_record_page_lifecycle',
    nowMs: START_AT
  });
  sessions.apply({
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: 'complete_record_page_lifecycle',
    nowMs: START_AT + 60_000,
    payload: { stepId: started.planSnapshot.steps[0].id }
  }, { originDeviceId: 'device_record_page_lifecycle' });
  const toasts = [];
  const times = [START_AT + 120_000, START_AT + 180_000];
  const page = mount(createRecordPageDefinition({
    applicationFactory: () => application,
    getWx: () => ({
      getAccountInfoSync() {
        return { miniProgram: { envVersion: 'release' } };
      },
      showToast(options) {
        toasts.push(clone(options));
      }
    }),
    now: () => times.shift(),
    commandKeyFactory: (kind) => `page_real_${kind}`
  }));

  page.onLoad({});
  assert.equal(page.data.view.records.length, 1);
  assert.equal(page.data.view.selectedRecord.steps[0].actualLabel, '未记录');

  page.onStartEdit();
  page.onStepValueInput({
    currentTarget: { dataset: { stepIndex: 0, field: 'actualReps' } },
    detail: { value: '20' }
  });
  page.onFeedbackInput({
    currentTarget: { dataset: { field: 'rpe' } },
    detail: { value: '7' }
  });
  page.onFeedbackInput({
    currentTarget: { dataset: { field: 'note' } },
    detail: { value: '匿名页面集成记录' }
  });
  page.onSaveEdit();

  assert.equal(page.data.view.selectedRecord.steps[0].actualLabel, '20 次');
  assert.equal(page.data.view.selectedRecord.feedback.rpe, 7);
  assert.equal(page.data.view.selectedRecord.feedback.note, '匿名页面集成记录');
  assert.equal(database.load().sync.outbox.at(-1).action, 'upsert');

  page.onRequestDelete();
  assert.equal(page.data.deleteConfirmation.recordId, page.data.view.selectedRecord.id);
  page.onConfirmDelete();

  assert.deepEqual(page.data.view.records, []);
  assert.equal(page.data.view.selectedRecord, null);
  assert.equal(database.load().sync.outbox.at(-1).action, 'delete');
  assert.deepEqual(toasts, [
    { title: '训练记录已更新', icon: 'none' },
    { title: '训练记录已删除', icon: 'none' }
  ]);
});
