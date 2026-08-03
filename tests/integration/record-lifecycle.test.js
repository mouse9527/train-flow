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
  assert.equal(afterCorrection.sync.outbox.at(-1).kind, 'training-record.corrected');
  assert.equal(afterCorrection.statisticsProjection.dirty, true);
  assert.doesNotMatch(JSON.stringify(afterCorrection.sync.outbox.at(-1)), /匿名集成记录|feedback|actualCorrections/);

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
  assert.equal(database.load().sync.outbox.at(-1).kind, 'training-record.deleted');
});
