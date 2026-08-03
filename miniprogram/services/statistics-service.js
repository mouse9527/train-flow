const {
  applyStatisticsRecordChanged,
  publicStatisticsProjection,
  rebuildStatisticsProjection
} = require('../domain/records/statistics-projection');
const { computeChecksum } = require('../utils/checksum');

class StatisticsService {
  constructor({ now = Date.now } = {}) {
    if (typeof now !== 'function') {
      throw new Error('StatisticsService now must be a function');
    }
    this.now = now;
  }

  timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('StatisticsService now must return a non-negative safe integer');
    }
    return value;
  }

  rebuild(records, plans, range) {
    return rebuildStatisticsProjection(records, plans, range, this.timestamp());
  }

  applyRecordChanged(currentProjection, beforeRecord, afterRecord) {
    return applyStatisticsRecordChanged(
      currentProjection,
      beforeRecord,
      afterRecord,
      this.timestamp()
    );
  }

  publicProjection(projection) {
    return publicStatisticsProjection(projection);
  }
}

function sameRange(left, right) {
  return Boolean(
    left &&
    left.startDate === right.startDate &&
    left.endDate === right.endDate
  );
}

function cacheMatches(cache, range, sourceFingerprint, databaseRevision) {
  return Boolean(
    cache &&
    cache.schemaVersion === 1 &&
    cache.dirty !== true &&
    sameRange(cache.range, range) &&
    cache.sourceFingerprint === sourceFingerprint &&
    cache.databaseRevision === databaseRevision &&
    cache.summary &&
    cache.latestStrength &&
    cache.recent &&
    Array.isArray(cache._plannedDates) &&
    Array.isArray(cache._recordContributions)
  );
}

class LocalStatisticsService extends StatisticsService {
  constructor({ database, recordRepository, planRepository, now = Date.now } = {}) {
    super({ now });
    if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
      throw new Error('LocalStatisticsService requires a LocalDatabase');
    }
    if (!recordRepository || typeof recordRepository.list !== 'function') {
      throw new Error('LocalStatisticsService requires a TrainingRecordRepository');
    }
    if (!planRepository || typeof planRepository.findRange !== 'function') {
      throw new Error('LocalStatisticsService requires a PlanRepository');
    }
    this.database = database;
    this.recordRepository = recordRepository;
    this.planRepository = planRepository;
    this.lastCacheWriteError = null;
  }

  readStableFacts(range) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.database.load();
      const records = this.recordRepository.list({});
      const plans = this.planRepository.findRange(range.startDate, range.endDate);
      const after = this.database.load();
      if (before.localRevision === after.localRevision) {
        return { snapshot: after, records, plans };
      }
    }
    throw new Error('Statistics facts changed repeatedly while reading; retry the page');
  }

  getProjection(range) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { snapshot, records, plans } = this.readStableFacts(range);
      const sourceFingerprint = computeChecksum({ range, plans, records });
      if (cacheMatches(
        snapshot.statisticsProjection,
        range,
        sourceFingerprint,
        snapshot.localRevision
      )) {
        this.lastCacheWriteError = null;
        return this.publicProjection(snapshot.statisticsProjection);
      }

      const rebuilt = {
        ...this.rebuild(records, plans, range),
        sourceFingerprint,
        databaseRevision: snapshot.localRevision + 1
      };
      try {
        this.database.commit((draft) => {
          draft.statisticsProjection = rebuilt;
        }, snapshot.localRevision);
        this.lastCacheWriteError = null;
        return this.publicProjection(rebuilt);
      } catch (error) {
        this.lastCacheWriteError = error;
        if (/revision conflict/i.test(error.message) && attempt === 0) {
          continue;
        }
        return this.publicProjection(rebuilt);
      }
    }
    throw new Error('Statistics projection could not stabilize');
  }
}

function createStatisticsService(options) {
  return new StatisticsService(options);
}

function createLocalStatisticsService(options) {
  return new LocalStatisticsService(options);
}

module.exports = {
  LocalStatisticsService,
  StatisticsService,
  createLocalStatisticsService,
  createStatisticsService
};
