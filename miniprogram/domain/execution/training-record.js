const { canonicalize, computeChecksum } = require('../../utils/checksum');

const TERMINAL_RECORD_FACT_FIELDS = Object.freeze([
  'schemaVersion',
  'occurrenceId',
  'eventType',
  'sourceSessionId',
  'status',
  'trainingDate',
  'startedAt',
  'endedAt',
  'elapsedActiveSeconds',
  'completedStepCount',
  'skippedStepCount',
  'totalStepCount',
  'planSnapshot',
  'stepResults'
]);
const TERMINAL_RECORD_REQUIRED_FIELDS = Object.freeze([
  ...TERMINAL_RECORD_FACT_FIELDS,
  'feedback',
  'id',
  'createdAt',
  'updatedAt',
  'revision'
]);
const TERMINAL_RECORD_FIELDS = new Set([
  ...TERMINAL_RECORD_REQUIRED_FIELDS,
  'sourceSessionFingerprint',
  'actualCorrections',
  'processedCorrectionCommands'
]);
const TOMBSTONE_FIELDS = Object.freeze([
  'id',
  'sourceSessionId',
  'sourceSessionFingerprint',
  'status',
  'trainingDate',
  'createdAt',
  'updatedAt',
  'revision',
  'deletedAt',
  'processedDeletionCommands'
]);
const COMMAND_RECEIPT_FIELDS = Object.freeze([
  'key',
  'fingerprint',
  'resultRevision'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertTerminalSource(source) {
  if (!source || !['completed', 'aborted'].includes(source.status)) {
    throw new TypeError('TrainingRecord requires a completed or aborted source');
  }
  if (typeof source.id !== 'string' || source.id.length === 0) {
    throw new TypeError('TrainingRecord source id must be a non-empty string');
  }
  if (!source.planSnapshot || !Array.isArray(source.planSnapshot.steps)) {
    throw new TypeError('TrainingRecord source requires a PlanSnapshot');
  }
  if (!Array.isArray(source.stepResults)) {
    throw new TypeError('TrainingRecord source requires stepResults');
  }
}

function createTerminalRecordFact(source) {
  assertTerminalSource(source);
  const completedStepCount = source.stepResults
    .filter(({ status }) => status === 'completed').length;
  const skippedStepCount = source.stepResults
    .filter(({ status }) => status === 'skipped').length;
  return {
    schemaVersion: 1,
    occurrenceId: JSON.stringify([
      'workout-session-terminal',
      source.id,
      source.status,
      source.endedAt
    ]),
    eventType: source.status === 'completed'
      ? 'WorkoutSessionCompleted'
      : 'WorkoutSessionAborted',
    sourceSessionId: source.id,
    status: source.status,
    trainingDate: source.trainingDate,
    startedAt: source.startedAt,
    endedAt: source.endedAt,
    elapsedActiveSeconds: source.elapsedActiveSeconds,
    completedStepCount,
    skippedStepCount,
    totalStepCount: source.planSnapshot.steps.length,
    planSnapshot: clone(source.planSnapshot),
    stepResults: clone(source.stepResults)
  };
}

function terminalFactFingerprint(source) {
  return computeChecksum({
    sourceSessionId: source.sourceSessionId === undefined ? source.id : source.sourceSessionId,
    planSnapshot: source.planSnapshot,
    trainingDate: source.trainingDate,
    status: source.status,
    startedAt: source.startedAt,
    endedAt: source.endedAt,
    elapsedActiveSeconds: source.elapsedActiveSeconds,
    stepResults: source.stepResults
  });
}

function createBaselineTrainingRecord(session) {
  const fact = createTerminalRecordFact(session);
  return {
    ...fact,
    feedback: null,
    sourceSessionFingerprint: terminalFactFingerprint(session),
    id: `record_${session.id}`,
    createdAt: session.endedAt,
    updatedAt: session.endedAt,
    revision: 1
  };
}

function terminalSourceFromRecord(record) {
  return {
    id: record.sourceSessionId,
    planSnapshot: clone(record.planSnapshot),
    trainingDate: record.trainingDate,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    elapsedActiveSeconds: record.elapsedActiveSeconds,
    stepResults: clone(record.stepResults)
  };
}

function recordMetadataMatches(record, sourceSessionId) {
  return record.id === `record_${sourceSessionId}` &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0 &&
    Number.isSafeInteger(record.updatedAt) &&
    record.updatedAt >= record.createdAt &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 1;
}

function hasExactFields(value, fields) {
  return isPlainObject(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function validCommandReceipts(receipts, recordRevision) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return false;
  }
  const keys = new Set();
  for (const receipt of receipts) {
    if (
      !hasExactFields(receipt, COMMAND_RECEIPT_FIELDS) ||
      typeof receipt.key !== 'string' ||
      receipt.key.length === 0 ||
      !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
      !Number.isSafeInteger(receipt.resultRevision) ||
      receipt.resultRevision < 2 ||
      receipt.resultRevision > recordRevision ||
      keys.has(receipt.key)
    ) {
      return false;
    }
    keys.add(receipt.key);
  }
  return receipts[receipts.length - 1].resultRevision === recordRevision;
}

function validCorrectionOverlay(record) {
  const hasCorrections = Object.prototype.hasOwnProperty.call(record, 'actualCorrections');
  const hasReceipts = Object.prototype.hasOwnProperty.call(record, 'processedCorrectionCommands');
  if (!hasCorrections && !hasReceipts) {
    return true;
  }
  if (
    !hasCorrections ||
    !hasReceipts ||
    !Array.isArray(record.actualCorrections) ||
    !validCommandReceipts(record.processedCorrectionCommands, record.revision)
  ) {
    return false;
  }
  const planSteps = new Map(record.planSnapshot.steps.map((step) => [step.id, step]));
  const sourceResults = new Map(record.stepResults.map((result) => [result.stepId, result]));
  const stepIds = new Set();
  for (const correction of record.actualCorrections) {
    if (!isPlainObject(correction) || typeof correction.stepId !== 'string') {
      return false;
    }
    const step = planSteps.get(correction.stepId);
    const sourceResult = sourceResults.get(correction.stepId);
    if (!step || !sourceResult || sourceResult.status !== 'completed' || stepIds.has(step.id)) {
      return false;
    }
    stepIds.add(step.id);
    const fields = Object.keys(correction).sort();
    if (
      step.kind === 'manual'
        ? canonicalize(fields) !== canonicalize(['actualReps', 'stepId'])
        : step.kind === 'timed' || step.kind === 'interval'
          ? canonicalize(fields) !== canonicalize(['actualDurationSeconds', 'stepId'])
          : step.kind === 'strength'
            ? canonicalize(fields) !== canonicalize(['setCorrections', 'stepId'])
            : true
    ) {
      return false;
    }
    if (step.kind === 'strength' && !Array.isArray(correction.setCorrections)) {
      return false;
    }
  }
  return true;
}

function tombstoneMatchesTerminalSource(record, source) {
  if (
    !hasExactFields(record, TOMBSTONE_FIELDS) ||
    record.id !== `record_${source.id}` ||
    record.sourceSessionId !== source.id ||
    record.sourceSessionFingerprint !== terminalFactFingerprint(source) ||
    record.status !== source.status ||
    record.trainingDate !== source.trainingDate ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < record.createdAt ||
    !Number.isSafeInteger(record.deletedAt) ||
    record.deletedAt !== record.updatedAt ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 2 ||
    !validCommandReceipts(record.processedDeletionCommands, record.revision)
  ) {
    return false;
  }
  return true;
}

function recordMatchesTerminalSource(record, source) {
  if (
    isPlainObject(record) &&
    (Object.prototype.hasOwnProperty.call(record, 'deletedAt') ||
      Object.prototype.hasOwnProperty.call(record, 'processedDeletionCommands'))
  ) {
    return tombstoneMatchesTerminalSource(record, source);
  }
  if (
    !isPlainObject(record) ||
    Object.keys(record).some((field) => !TERMINAL_RECORD_FIELDS.has(field)) ||
    TERMINAL_RECORD_REQUIRED_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(record, field)
    ) ||
    !(record.feedback === null || isPlainObject(record.feedback)) ||
    !validCorrectionOverlay(record) ||
    !recordMetadataMatches(record, source.id)
  ) {
    return false;
  }
  let expectedFact;
  try {
    expectedFact = createTerminalRecordFact(source);
  } catch (_error) {
    return false;
  }
  if (TERMINAL_RECORD_FACT_FIELDS.some(
    (field) => canonicalize(record[field]) !== canonicalize(expectedFact[field])
  )) {
    return false;
  }
  const derivedFingerprint = terminalFactFingerprint(record);
  return !Object.prototype.hasOwnProperty.call(record, 'sourceSessionFingerprint') ||
    record.sourceSessionFingerprint === derivedFingerprint;
}

function findTrainingRecords(records, sessionId) {
  const canonicalRecordId = `record_${sessionId}`;
  return records.filter((record) => record && (
    record.sourceSessionId === sessionId || record.id === canonicalRecordId
  ));
}

function ensureTerminalTrainingRecord(records, session) {
  const candidates = findTrainingRecords(records, session.id);
  if (candidates.length > 1) {
    throw new Error('Terminal Session has conflicting TrainingRecords');
  }
  if (candidates.length === 1) {
    if (!recordMatchesTerminalSource(candidates[0], session)) {
      throw new Error('Terminal Session TrainingRecord does not match its source');
    }
    return candidates[0];
  }
  const baseline = createBaselineTrainingRecord(session);
  records.push(baseline);
  return baseline;
}

module.exports = {
  TERMINAL_RECORD_FACT_FIELDS,
  TERMINAL_RECORD_FIELDS,
  createBaselineTrainingRecord,
  createTerminalRecordFact,
  ensureTerminalTrainingRecord,
  findTrainingRecords,
  isPlainObject,
  recordMatchesTerminalSource,
  terminalFactFingerprint,
  terminalSourceFromRecord
};
