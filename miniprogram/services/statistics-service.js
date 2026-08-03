const {
  applyStatisticsRecordChanged,
  publicStatisticsProjection,
  rebuildStatisticsProjection
} = require('../domain/records/statistics-projection');

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

function createStatisticsService(options) {
  return new StatisticsService(options);
}

module.exports = { StatisticsService, createStatisticsService };
