const { canonicalize, computeChecksum } = require('../../utils/checksum');
const { assertWorkoutPlan } = require('../planning/plan-validation');

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
const TERMINAL_STEP_RESULT_FIELDS = Object.freeze([
  'stepId',
  'status',
  'completedAt',
  'setResults'
]);
const TERMINAL_SET_RESULT_FIELDS = Object.freeze([
  'setNumber',
  'reps',
  'weightKg',
  'completedAt'
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
  assertWorkoutPlan(source.planSnapshot);
  if (source.planSnapshot.status !== 'scheduled') {
    throw new TypeError('TrainingRecord source PlanSnapshot must be scheduled');
  }
  if (!Array.isArray(source.stepResults)) {
    throw new TypeError('TrainingRecord source requires stepResults');
  }
  if (
    source.planSnapshot.trainingDate !== source.trainingDate ||
    !isSafeIntegerAtLeast(source.startedAt, 0) ||
    !isSafeIntegerAtLeast(source.endedAt, source.startedAt) ||
    !isSafeIntegerAtLeast(source.elapsedActiveSeconds, 0)
  ) {
    throw new TypeError('TrainingRecord source terminal timing is invalid');
  }

  const planStepIndexes = new Map(
    source.planSnapshot.steps.map((step, index) => [step.id, index])
  );
  const resultStepIds = new Set();
  source.stepResults.forEach((result, index) => {
    const label = `TrainingRecord source.stepResults[${index}]`;
    if (
      !hasExactFields(result, TERMINAL_STEP_RESULT_FIELDS) ||
      typeof result.stepId !== 'string' ||
      result.stepId.length === 0 ||
      !['completed', 'skipped'].includes(result.status) ||
      !isSafeIntegerAtLeast(result.completedAt, source.startedAt) ||
      result.completedAt > source.endedAt ||
      !Array.isArray(result.setResults) ||
      resultStepIds.has(result.stepId) ||
      planStepIndexes.get(result.stepId) !== index
    ) {
      throw new TypeError(`${label} is invalid`);
    }
    resultStepIds.add(result.stepId);
    const step = source.planSnapshot.steps[index];
    if (
      ['manual', 'timed'].includes(step.kind) &&
      result.setResults.length !== 0
    ) {
      throw new TypeError(`${label}.setResults must be empty for ${step.kind}`);
    }
    result.setResults.forEach((setResult, setIndex) => {
      const setLabel = `${label}.setResults[${setIndex}]`;
      if (
        !hasExactFields(setResult, TERMINAL_SET_RESULT_FIELDS) ||
        setResult.setNumber !== setIndex + 1 ||
        !validNullablePositiveInteger(setResult.reps) ||
        !validNullableMeasurement(setResult.weightKg) ||
        !isSafeIntegerAtLeast(setResult.completedAt, source.startedAt) ||
        setResult.completedAt > result.completedAt
      ) {
        throw new TypeError(`${setLabel} is invalid`);
      }
    });
  });
  if (
    source.stepResults.length > source.planSnapshot.steps.length ||
    (source.status === 'completed' && source.stepResults.length !== source.planSnapshot.steps.length)
  ) {
    throw new TypeError('TrainingRecord source stepResults do not match terminal status');
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
  const source = {
    id: record.sourceSessionId,
    planSnapshot: clone(record.planSnapshot),
    trainingDate: record.trainingDate,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    elapsedActiveSeconds: record.elapsedActiveSeconds,
    stepResults: clone(record.stepResults)
  };
  assertTerminalSource(source);
  return source;
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
  let previousResultRevision = 0;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    if (
      !hasExactFields(receipt, COMMAND_RECEIPT_FIELDS) ||
      typeof receipt.key !== 'string' ||
      receipt.key.length === 0 ||
      !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
      !Number.isSafeInteger(receipt.resultRevision) ||
      receipt.resultRevision < (index === 0 ? 1 : 2) ||
      receipt.resultRevision > recordRevision ||
      receipt.resultRevision <= previousResultRevision ||
      keys.has(receipt.key)
    ) {
      return false;
    }
    keys.add(receipt.key);
    previousResultRevision = receipt.resultRevision;
  }
  return receipts[receipts.length - 1].resultRevision === recordRevision;
}

function isSafeIntegerAtLeast(value, minimum) {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum;
}

function validNullablePositiveInteger(value) {
  return value === null || isSafeIntegerAtLeast(value, 1);
}

function validNullableDuration(value) {
  return value === null || isSafeIntegerAtLeast(value, 0);
}

function validNullableMeasurement(value) {
  if (value === null) {
    return true;
  }
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isSafeInteger(Math.trunc(value)) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER &&
    Math.abs(value * 10 - Math.round(value * 10)) <= Number.EPSILON * 10;
}

function validFeedback(feedback) {
  if (feedback === null) {
    return true;
  }
  if (
    !hasExactFields(feedback, ['rpe', 'weightBeforeKg', 'pain', 'note']) ||
    !Number.isSafeInteger(feedback.rpe) ||
    feedback.rpe < 1 ||
    feedback.rpe > 10 ||
    !validNullableMeasurement(feedback.weightBeforeKg) ||
    !hasExactFields(feedback.pain, ['knee', 'lowerBack', 'ankleOrToe', 'dizziness']) ||
    Object.values(feedback.pain).some((value) => typeof value !== 'boolean') ||
    typeof feedback.note !== 'string' ||
    feedback.note.length > 500
  ) {
    return false;
  }
  return true;
}

function validCorrectionForStep(correction, step, sourceResult) {
  if (step.kind === 'manual') {
    return hasExactFields(correction, ['stepId', 'actualReps']) &&
      validNullablePositiveInteger(correction.actualReps);
  }
  if (step.kind === 'timed' || step.kind === 'interval') {
    return hasExactFields(correction, ['stepId', 'actualDurationSeconds']) &&
      validNullableDuration(correction.actualDurationSeconds);
  }
  if (
    step.kind !== 'strength' ||
    !hasExactFields(correction, ['stepId', 'setCorrections']) ||
    !Array.isArray(correction.setCorrections) ||
    !Array.isArray(sourceResult.setResults)
  ) {
    return false;
  }
  const sourceSetNumbers = new Set(
    sourceResult.setResults.map(({ setNumber }) => setNumber)
  );
  const correctedSetNumbers = new Set();
  for (const setCorrection of correction.setCorrections) {
    if (
      !hasExactFields(setCorrection, ['setNumber', 'reps', 'weightKg']) ||
      !isSafeIntegerAtLeast(setCorrection.setNumber, 1) ||
      !sourceSetNumbers.has(setCorrection.setNumber) ||
      correctedSetNumbers.has(setCorrection.setNumber) ||
      !validNullablePositiveInteger(setCorrection.reps) ||
      !validNullableMeasurement(setCorrection.weightKg)
    ) {
      return false;
    }
    correctedSetNumbers.add(setCorrection.setNumber);
  }
  return true;
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
  if (
    record.revision === 1 &&
    (
      record.actualCorrections.length !== 0 ||
      record.processedCorrectionCommands.length !== 1 ||
      record.processedCorrectionCommands[0].resultRevision !== 1
    )
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
    if (
      !validCorrectionForStep(correction, step, sourceResult)
    ) {
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
    !Array.isArray(record.processedDeletionCommands) ||
    record.processedDeletionCommands.length !== 1 ||
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
    !validFeedback(record.feedback) ||
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
