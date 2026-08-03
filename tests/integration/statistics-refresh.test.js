const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LocalStatisticsService
} = require('../../miniprogram/services/statistics-service');
const {
  createStatisticsApplicationService
} = require('../../miniprogram/application/statistics-application-service');
const {
  createRecordApplicationService
} = require('../../miniprogram/application/record-application-service');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  createPlanRepository
} = require('../../miniprogram/domain/planning/plan-repository');
const {
  createTrainingRecordRepository
} = require('../../miniprogram/domain/records/training-record-repository');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const RANGE = { startDate: '2026-08-03', endDate: '2026-08-09' };

function timedPlan(trainingDate = '2026-08-03') {
  return {
    id: `plan_${trainingDate}`,
    trainingDate,
    status: 'scheduled',
    steps: [{
      id: `step_${trainingDate}`,
      kind: 'timed',
      name: '跑步机快走',
      durationSeconds: 600
    }]
  };
}

function completedRecord({ revision = 1, activeSeconds = 600 } = {}) {
  return {
    id: 'record_statistics_refresh',
    revision,
    status: 'completed',
    trainingDate: '2026-08-03',
    endedAt: 1785719400000,
    elapsedActiveSeconds: activeSeconds,
    planSnapshot: { steps: timedPlan().steps },
    stepResults: [{
      stepId: 'step_2026-08-03',
      status: 'completed',
      actualDurationSeconds: activeSeconds,
      setResults: []
    }],
    feedback: null
  };
}

function repositories(database) {
  return {
    recordRepository: {
      list() {
        return clone(database.load().records.filter((record) => !record.deletedAt));
      }
    },
    planRepository: {
      findRange(startDate, endDate) {
        return clone(database.load().plans.filter(({ trainingDate, status }) => (
          status !== 'deleted' && trainingDate >= startDate && trainingDate <= endDate
        )));
      }
    }
  };
}

test('local statistics refreshes dirty record changes and repairs a corrupted projection from current facts', () => {
  let clock = 1786032000000;
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => clock++
  });
  database.commit((draft) => {
    draft.plans = [timedPlan()];
    draft.records = [completedRecord()];
  });
  const service = new LocalStatisticsService({
    database,
    ...repositories(database),
    now: () => 1786032100000
  });

  const initial = service.getProjection(RANGE);
  const cached = database.load().statisticsProjection;
  assert.equal(initial.summary.totalActiveSeconds, 600);
  assert.match(cached.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(cached.databaseRevision, database.load().localRevision);

  database.commit((draft) => {
    draft.records[0] = completedRecord({ revision: 2, activeSeconds: 900 });
    draft.statisticsProjection = {
      dirty: true,
      reason: 'training-record-changed',
      recordId: 'record_statistics_refresh',
      recordRevision: 2,
      invalidatedAt: 1786032200000
    };
  });
  const afterEdit = service.getProjection(RANGE);
  assert.equal(afterEdit.summary.totalActiveSeconds, 900);
  assert.equal(database.load().statisticsProjection.summary.totalActiveSeconds, 900);

  database.commit((draft) => {
    draft.statisticsProjection = {
      schemaVersion: 1,
      range: clone(RANGE),
      sourceFingerprint: '0'.repeat(64),
      summary: { completedCount: 999 }
    };
  });
  const repaired = service.getProjection(RANGE);
  assert.equal(repaired.summary.completedCount, 1);
  assert.notEqual(database.load().statisticsProjection.sourceFingerprint, '0'.repeat(64));

  database.commit((draft) => {
    draft.records[0] = {
      id: 'record_statistics_refresh',
      trainingDate: '2026-08-03',
      status: 'deleted',
      deletedAt: 1786032300000
    };
    draft.statisticsProjection = { dirty: true, reason: 'training-record-changed' };
  });
  const afterDelete = service.getProjection(RANGE);
  assert.equal(afterDelete.summary.completedCount, 0);
  assert.equal(afterDelete.summary.totalActiveSeconds, 0);
});

test('cache persistence failure does not hide a freshly rebuilt read-only statistics result', () => {
  const snapshot = {
    localRevision: 7,
    statisticsProjection: {},
    plans: [timedPlan()],
    records: [completedRecord()]
  };
  const database = {
    load() {
      return clone(snapshot);
    },
    commit() {
      throw new Error('simulated storage full');
    }
  };
  const service = new LocalStatisticsService({
    database,
    recordRepository: { list: () => clone(snapshot.records) },
    planRepository: { findRange: () => clone(snapshot.plans) },
    now: () => 1786032400000
  });

  const projection = service.getProjection(RANGE);

  assert.equal(projection.summary.completedCount, 1);
  assert.equal(projection.summary.totalActiveSeconds, 600);
  assert.match(service.lastCacheWriteError.message, /storage full/);
});

test('real session create plus public record edit and delete invalidate, refresh and update statistics UI', () => {
  let clock = 1786234500000;
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => clock++
  });
  const plan = {
    id: 'plan_statistics_public_lifecycle',
    trainingDate: '2026-08-09',
    status: 'scheduled',
    title: '统计公共生命周期训练',
    summary: '匿名集成测试',
    estimatedDurationSeconds: 600,
    recommendedEndLocalTime: null,
    timezone: 'Asia/Shanghai',
    schemaVersion: 1,
    templateSource: null,
    createdAt: clock,
    updatedAt: clock,
    deletedAt: null,
    revision: 1,
    safetyNoticeCodes: [],
    steps: [{
      id: 'step_statistics_public_lifecycle',
      order: 10,
      kind: 'manual',
      name: '徒手深蹲',
      description: '匿名集成动作',
      durationSeconds: null,
      sets: null,
      reps: 12,
      restSeconds: null,
      targets: {},
      optional: false,
      alternatives: [],
      safetyNoticeCodes: []
    }]
  };
  database.commit((draft) => {
    draft.plans = [clone(plan)];
  });
  const records = createTrainingRecordRepository({ database });
  const statistics = new LocalStatisticsService({
    database,
    recordRepository: records,
    planRepository: createPlanRepository({ database }),
    now: () => 1786234900000
  });
  const statisticsApplication = createStatisticsApplicationService({ service: statistics });
  const recordApplication = createRecordApplicationService({ repository: records });
  const sessions = createSessionRepository({ database });

  const beforeCreate = statisticsApplication.getView('2026-08-09');
  assert.equal(beforeCreate.week.completionCountLabel, '0 / 1 次');

  const started = sessions.start({
    plan,
    sessionId: 'session_statistics_public_lifecycle',
    originDeviceId: 'device_statistics_public_lifecycle',
    commandKey: 'start_statistics_public_lifecycle',
    nowMs: 1786234500000
  });
  sessions.apply({
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: 'complete_statistics_public_lifecycle',
    nowMs: 1786234560000,
    payload: { stepId: plan.steps[0].id }
  }, { originDeviceId: 'device_statistics_public_lifecycle' });

  assert.deepEqual(database.load().statisticsProjection, {
    dirty: true,
    reason: 'training-record-changed',
    recordId: 'record_session_statistics_public_lifecycle',
    recordRevision: 1,
    invalidatedAt: 1786234560000
  });
  const afterCreate = statisticsApplication.getView('2026-08-09');
  assert.equal(afterCreate.week.completionCountLabel, '1 / 1 次');
  assert.equal(afterCreate.metrics.activeMinutes.valueLabel, '1');

  const selected = recordApplication.getView().selectedRecord;
  const draft = recordApplication.createEditDraft(selected);
  draft.steps[0].actualReps = '18';
  draft.feedback.rpe = '8';
  draft.feedback.weightBeforeKg = '80.5';
  recordApplication.correctRecord({
    recordId: selected.id,
    expectedRevision: selected.revision,
    commandKey: 'correct_statistics_public_lifecycle',
    nowMs: 1786234620000,
    draft
  });

  assert.equal(database.load().statisticsProjection.dirty, true);
  const afterEdit = statisticsApplication.getView('2026-08-09');
  assert.equal(afterEdit.latestBodyWeight.valueLabel, '80.5 kg');
  assert.equal(
    afterEdit.trends.find(({ key }) => key === 'rpe').points.at(-1).valueLabel,
    '8'
  );

  const corrected = recordApplication.getView().selectedRecord;
  recordApplication.deleteRecord({
    recordId: corrected.id,
    expectedRevision: corrected.revision,
    commandKey: 'delete_statistics_public_lifecycle',
    nowMs: 1786234680000
  });

  assert.equal(database.load().statisticsProjection.dirty, true);
  const afterDelete = statisticsApplication.getView('2026-08-09');
  assert.equal(afterDelete.week.completionCountLabel, '0 / 1 次');
  assert.equal(afterDelete.metrics.activeMinutes.valueLabel, '0');
  assert.deepEqual(afterDelete.trends.flatMap(({ points }) => points), []);
});
