const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LocalStatisticsService
} = require('../../miniprogram/services/statistics-service');
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
