class LocalRecordSummaryProvider {
  constructor({ database }) {
    if (!database || typeof database.load !== 'function') {
      throw new Error('LocalRecordSummaryProvider requires a LocalDatabase');
    }
    this.database = database;
  }

  findRange(weekStart, weekEnd) {
    return this.database.load().records
      .filter((record) => (
        record &&
        typeof record === 'object' &&
        record.trainingDate >= weekStart &&
        record.trainingDate <= weekEnd
      ))
      .map((record) => ({
        trainingDate: record.trainingDate,
        timezone: record.timezone,
        completed: record.completed,
        skipped: record.skipped,
        discomfort: record.discomfort
      }));
  }
}

function createLocalRecordSummaryProvider(options) {
  return new LocalRecordSummaryProvider(options);
}

module.exports = { LocalRecordSummaryProvider, createLocalRecordSummaryProvider };
