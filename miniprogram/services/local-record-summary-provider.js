function isDeletedRecord(record) {
  const hasTombstone = record.tombstone === true ||
    Boolean(record.tombstone && typeof record.tombstone === 'object');
  return Boolean(
    record.deleted === true ||
    record.status === 'deleted' ||
    (record.deletedAt !== null && record.deletedAt !== undefined) ||
    hasTombstone
  );
}

function recordTimezone(record) {
  if (
    record.planSnapshot &&
    typeof record.planSnapshot === 'object' &&
    typeof record.planSnapshot.timezone === 'string'
  ) {
    return record.planSnapshot.timezone;
  }
  return record.timezone;
}

function hasSkippedStep(record) {
  return Array.isArray(record.stepResults) &&
    record.stepResults.some((result) => (
      result && typeof result === 'object' && result.status === 'skipped'
    ));
}

function hasDiscomfort(record) {
  const pain = record.feedback && record.feedback.pain;
  return Boolean(
    pain &&
    typeof pain === 'object' &&
    !Array.isArray(pain) &&
    Object.values(pain).some((value) => value === true)
  );
}

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
        !Array.isArray(record) &&
        !isDeletedRecord(record) &&
        record.trainingDate >= weekStart &&
        record.trainingDate <= weekEnd
      ))
      .map((record) => ({
        trainingDate: record.trainingDate,
        timezone: recordTimezone(record),
        completed: record.status === 'completed',
        skipped: hasSkippedStep(record),
        discomfort: hasDiscomfort(record)
      }));
  }
}

function createLocalRecordSummaryProvider(options) {
  return new LocalRecordSummaryProvider(options);
}

module.exports = { LocalRecordSummaryProvider, createLocalRecordSummaryProvider };
