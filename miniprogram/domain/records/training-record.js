const { computeChecksum } = require('../../utils/checksum');
const {
  recordMatchesTerminalSource,
  terminalFactFingerprint,
  terminalSourceFromRecord
} = require('../execution/training-record');

const CORRECTION_COMMAND_FIELDS = Object.freeze([
  'expectedRevision',
  'commandKey',
  'nowMs',
  'actualCorrections',
  'feedback'
]);
const CORRECTION_RECEIPT_FIELDS = Object.freeze([
  'key',
  'fingerprint',
  'resultRevision'
]);
const PAIN_FIELDS = Object.freeze([
  'knee',
  'lowerBack',
  'ankleOrToe',
  'dizziness'
]);

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function assertInertJson(value, path = 'value', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${path} must contain canonical finite JSON numbers`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains a non-JSON ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} cannot contain symbol fields`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${path} must be a plain JSON array`);
    }
    const extraField = Object.getOwnPropertyNames(value).find(
      (field) => field !== 'length' && !/^(0|[1-9]\d*)$/.test(field)
    );
    if (extraField) {
      throw new TypeError(`${path} contains unknown array field ${extraField}`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, index)) {
        throw new TypeError(`${path}[${index}] is a sparse JSON array entry`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor.enumerable || !hasOwn(descriptor, 'value') || descriptor.value === undefined) {
        throw new TypeError(`${path}[${index}] must be an enumerable JSON data field`);
      }
      assertInertJson(descriptor.value, `${path}[${index}]`, ancestors);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${path} must be a plain JSON object without a custom prototype`);
    }
    for (const field of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor.enumerable || !hasOwn(descriptor, 'value') || descriptor.value === undefined) {
        throw new TypeError(`${path}.${field} must be an enumerable JSON data field`);
      }
      assertInertJson(descriptor.value, `${path}.${field}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertClosedObject(value, allowedFields, label, optionalFields = []) {
  assertInertJson(value, label);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const allowed = new Set(allowedFields);
  for (const field of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
  }
  const optional = new Set(optionalFields);
  for (const field of allowedFields) {
    if (!optional.has(field) && !hasOwn(value, field)) {
      throw new TypeError(`${label} requires own field ${field}`);
    }
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
}

function assertNullablePositiveInteger(value, label) {
  if (value !== null) {
    assertSafeInteger(value, label, 1);
  }
}

function assertNullableDuration(value, label) {
  if (value !== null) {
    assertSafeInteger(value, label, 0);
  }
}

function assertNullableMeasurement(value, label) {
  if (value === null) {
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(Math.trunc(value)) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    Math.abs(value * 10 - Math.round(value * 10)) > Number.EPSILON * 10
  ) {
    throw new TypeError(`${label} must be null or a non-negative safe measurement with at most one decimal place`);
  }
}

function cloneJson(value) {
  assertInertJson(value);
  return JSON.parse(JSON.stringify(value));
}

function assertRecord(record) {
  assertInertJson(record, 'record');
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('record must be an object');
  }
  assertNonEmptyString(record.id, 'record.id');
  assertNonEmptyString(record.sourceSessionId, 'record.sourceSessionId');
  if (!['completed', 'aborted'].includes(record.status)) {
    throw new TypeError('record.status must be completed or aborted');
  }
  if (!record.planSnapshot || !Array.isArray(record.planSnapshot.steps)) {
    throw new TypeError('record.planSnapshot.steps must be an array');
  }
  if (!Array.isArray(record.stepResults)) {
    throw new TypeError('record.stepResults must be an array');
  }
  assertSafeInteger(record.revision, 'record.revision', 1);
  assertSafeInteger(record.createdAt, 'record.createdAt');
  assertSafeInteger(record.updatedAt, 'record.updatedAt');
  if (record.updatedAt < record.createdAt) {
    throw new TypeError('record.updatedAt cannot be before record.createdAt');
  }
  let terminalSource;
  try {
    terminalSource = terminalSourceFromRecord(record);
  } catch (_error) {
    throw new TypeError('record terminal source facts are invalid');
  }
  if (!recordMatchesTerminalSource(record, terminalSource)) {
    throw new TypeError('record does not match its immutable terminal source');
  }
  if (
    hasOwn(record, 'sourceSessionFingerprint') &&
    record.sourceSessionFingerprint !== terminalFactFingerprint(record)
  ) {
    throw new TypeError('record terminal source fingerprint is invalid');
  }
  const planStepIds = record.planSnapshot.steps.map((step) => step.id);
  if (planStepIds.some((stepId) => typeof stepId !== 'string' || stepId.length === 0)) {
    throw new TypeError('record PlanSnapshot step ids must be non-empty strings');
  }
  if (new Set(planStepIds).size !== planStepIds.length) {
    throw new TypeError('record PlanSnapshot step ids must be unique');
  }
  const resultStepIds = record.stepResults.map((result) => result.stepId);
  if (new Set(resultStepIds).size !== resultStepIds.length) {
    throw new TypeError('record stepResults step ids must be unique');
  }
  if (resultStepIds.some((stepId) => !planStepIds.includes(stepId))) {
    throw new TypeError('record stepResults must reference PlanSnapshot steps');
  }
  if (record.feedback !== null) {
    const normalizedFeedback = canonicalFeedback(record.feedback);
    if (computeChecksum(record.feedback) !== computeChecksum(normalizedFeedback)) {
      throw new TypeError('record.feedback must use the canonical stored schema');
    }
  }
  const hasCorrections = hasOwn(record, 'actualCorrections');
  const hasCorrectionReceipts = hasOwn(record, 'processedCorrectionCommands');
  if (hasCorrections !== hasCorrectionReceipts) {
    throw new TypeError('record correction overlay and receipts must be stored together');
  }
  if (hasCorrections) {
    const normalizedCorrections = canonicalCorrections(record, record.actualCorrections);
    if (computeChecksum(record.actualCorrections) !== computeChecksum(normalizedCorrections)) {
      throw new TypeError('record.actualCorrections must use the canonical stored schema');
    }
    assertCorrectionReceipts(record.processedCorrectionCommands);
  }
  return record;
}

function canonicalFeedback(feedback) {
  assertClosedObject(
    feedback,
    ['rpe', 'weightBeforeKg', 'pain', 'note'],
    'command.feedback',
    ['weightBeforeKg', 'pain', 'note']
  );
  if (!Number.isSafeInteger(feedback.rpe) || feedback.rpe < 1 || feedback.rpe > 10) {
    throw new TypeError('command.feedback.rpe must be an integer from 1 to 10');
  }
  const weightBeforeKg = hasOwn(feedback, 'weightBeforeKg')
    ? feedback.weightBeforeKg
    : null;
  assertNullableMeasurement(weightBeforeKg, 'command.feedback.weightBeforeKg');

  const suppliedPain = hasOwn(feedback, 'pain') ? feedback.pain : {};
  assertClosedObject(
    suppliedPain,
    PAIN_FIELDS,
    'command.feedback.pain',
    PAIN_FIELDS
  );
  const pain = {};
  for (const field of PAIN_FIELDS) {
    const value = hasOwn(suppliedPain, field) ? suppliedPain[field] : false;
    if (typeof value !== 'boolean') {
      throw new TypeError(`command.feedback.pain.${field} must be boolean`);
    }
    pain[field] = value;
  }

  const note = hasOwn(feedback, 'note') ? feedback.note : '';
  if (typeof note !== 'string' || note.length > 500) {
    throw new TypeError('command.feedback.note must be a string of at most 500 characters');
  }
  return { rpe: feedback.rpe, weightBeforeKg, pain, note };
}

function assertCorrectionReceipts(receipts) {
  assertInertJson(receipts, 'record.processedCorrectionCommands');
  if (!Array.isArray(receipts)) {
    throw new TypeError('record.processedCorrectionCommands must be an array');
  }
  const keys = new Set();
  receipts.forEach((receipt, index) => {
    const label = `record.processedCorrectionCommands[${index}]`;
    assertClosedObject(receipt, CORRECTION_RECEIPT_FIELDS, label);
    assertNonEmptyString(receipt.key, `${label}.key`);
    if (!/^[a-f0-9]{64}$/.test(receipt.fingerprint)) {
      throw new TypeError(`${label}.fingerprint must be a SHA-256 digest`);
    }
    assertSafeInteger(receipt.resultRevision, `${label}.resultRevision`, 2);
    if (keys.has(receipt.key)) {
      throw new TypeError('record correction command keys must be unique');
    }
    keys.add(receipt.key);
  });
}

function findSourceResult(record, stepId) {
  return record.stepResults.find((result) => result.stepId === stepId) || null;
}

function canonicalCorrections(record, actualCorrections) {
  assertInertJson(actualCorrections, 'command.actualCorrections');
  if (!Array.isArray(actualCorrections)) {
    throw new TypeError('command.actualCorrections must be an array');
  }
  const planStepById = new Map(record.planSnapshot.steps.map((step) => [step.id, step]));
  const correctedStepIds = new Set();
  return actualCorrections.map((correction, index) => {
    const label = `command.actualCorrections[${index}]`;
    if (!correction || typeof correction !== 'object' || Array.isArray(correction)) {
      throw new TypeError(`${label} must be an object`);
    }
    const stepIdDescriptor = Object.getOwnPropertyDescriptor(correction, 'stepId');
    if (!stepIdDescriptor || !hasOwn(stepIdDescriptor, 'value')) {
      throw new TypeError(`${label}.stepId must be an inert data field`);
    }
    const stepId = stepIdDescriptor.value;
    assertNonEmptyString(stepId, `${label}.stepId`);
    const step = planStepById.get(stepId);
    const sourceResult = findSourceResult(record, stepId);
    if (!step || !sourceResult || sourceResult.status !== 'completed') {
      throw new TypeError(`${label} may only correct a completed PlanSnapshot step`);
    }
    if (correctedStepIds.has(stepId)) {
      throw new TypeError('command.actualCorrections step ids must be unique');
    }
    correctedStepIds.add(stepId);

    if (step.kind === 'manual') {
      assertClosedObject(correction, ['stepId', 'actualReps'], label);
      assertNullablePositiveInteger(correction.actualReps, `${label}.actualReps`);
      return { stepId, actualReps: correction.actualReps };
    }
    if (step.kind === 'timed' || step.kind === 'interval') {
      assertClosedObject(correction, ['stepId', 'actualDurationSeconds'], label);
      assertNullableDuration(
        correction.actualDurationSeconds,
        `${label}.actualDurationSeconds`
      );
      return { stepId, actualDurationSeconds: correction.actualDurationSeconds };
    }
    if (step.kind === 'strength') {
      assertClosedObject(correction, ['stepId', 'setCorrections'], label);
      if (!Array.isArray(correction.setCorrections)) {
        throw new TypeError(`${label}.setCorrections must be an array`);
      }
      const sourceSets = new Map(
        sourceResult.setResults.map((setResult) => [setResult.setNumber, setResult])
      );
      const correctedSetNumbers = new Set();
      const setCorrections = correction.setCorrections.map((setCorrection, setIndex) => {
        const setLabel = `${label}.setCorrections[${setIndex}]`;
        assertClosedObject(
          setCorrection,
          ['setNumber', 'reps', 'weightKg'],
          setLabel
        );
        assertSafeInteger(setCorrection.setNumber, `${setLabel}.setNumber`, 1);
        if (!sourceSets.has(setCorrection.setNumber)) {
          throw new TypeError(`${setLabel} must reference an existing completed set`);
        }
        if (correctedSetNumbers.has(setCorrection.setNumber)) {
          throw new TypeError(`${label}.setCorrections set numbers must be unique`);
        }
        correctedSetNumbers.add(setCorrection.setNumber);
        assertNullablePositiveInteger(setCorrection.reps, `${setLabel}.reps`);
        assertNullableMeasurement(setCorrection.weightKg, `${setLabel}.weightKg`);
        return {
          setNumber: setCorrection.setNumber,
          reps: setCorrection.reps,
          weightKg: setCorrection.weightKg
        };
      });
      return { stepId, setCorrections };
    }
    throw new TypeError(`${label} references an unsupported step kind`);
  });
}

function assertCorrectionCommand(record, command) {
  assertClosedObject(command, CORRECTION_COMMAND_FIELDS, 'command');
  assertSafeInteger(command.expectedRevision, 'command.expectedRevision', 1);
  assertNonEmptyString(command.commandKey, 'command.commandKey');
  assertSafeInteger(command.nowMs, 'command.nowMs');
  return {
    expectedRevision: command.expectedRevision,
    commandKey: command.commandKey,
    nowMs: command.nowMs,
    actualCorrections: canonicalCorrections(record, command.actualCorrections),
    feedback: canonicalFeedback(command.feedback)
  };
}

function commandFingerprint(command) {
  return computeChecksum({
    expectedRevision: command.expectedRevision,
    commandKey: command.commandKey,
    nowMs: command.nowMs,
    actualCorrections: command.actualCorrections,
    feedback: command.feedback
  });
}

function applyTrainingRecordCorrection(sourceRecord, sourceCommand) {
  assertRecord(sourceRecord);
  const command = assertCorrectionCommand(sourceRecord, sourceCommand);
  const fingerprint = commandFingerprint(command);
  const receipts = hasOwn(sourceRecord, 'processedCorrectionCommands')
    ? sourceRecord.processedCorrectionCommands
    : [];
  const replayReceipt = receipts.find(({ key }) => key === command.commandKey);
  if (replayReceipt) {
    if (replayReceipt.fingerprint !== fingerprint) {
      throw new Error('TrainingRecord correction command key conflicts with prior intent');
    }
    return cloneJson(sourceRecord);
  }
  if (command.expectedRevision !== sourceRecord.revision) {
    throw new Error('TrainingRecord correction revision is stale');
  }
  if (command.nowMs < sourceRecord.updatedAt) {
    throw new TypeError('command.nowMs cannot be before record.updatedAt');
  }

  const nextRevision = sourceRecord.revision + 1;
  return {
    ...cloneJson(sourceRecord),
    actualCorrections: cloneJson(command.actualCorrections),
    feedback: cloneJson(command.feedback),
    processedCorrectionCommands: [
      ...cloneJson(receipts),
      {
        key: command.commandKey,
        fingerprint,
        resultRevision: nextRevision
      }
    ],
    updatedAt: command.nowMs,
    revision: nextRevision
  };
}

function sourceResultForEffectiveView(step, sourceResult) {
  if (!sourceResult) {
    return {
      stepId: step.id,
      status: 'unknown',
      completedAt: null,
      setResults: []
    };
  }
  const result = cloneJson(sourceResult);
  if (result.status !== 'completed' && result.status !== 'skipped') {
    result.status = 'unknown';
  }
  return result;
}

function buildEffectiveTrainingRecord(sourceRecord) {
  assertRecord(sourceRecord);
  const record = cloneJson(sourceRecord);
  const correctionByStepId = new Map(
    (record.actualCorrections || []).map((correction) => [correction.stepId, correction])
  );
  const sourceResultByStepId = new Map(
    record.stepResults.map((result) => [result.stepId, result])
  );

  record.stepResults = record.planSnapshot.steps.map((step) => {
    const result = sourceResultForEffectiveView(step, sourceResultByStepId.get(step.id));
    const correction = correctionByStepId.get(step.id) || null;
    if (step.kind === 'manual') {
      result.actualReps = correction ? correction.actualReps : null;
    } else if (step.kind === 'timed' || step.kind === 'interval') {
      result.actualDurationSeconds = correction
        ? correction.actualDurationSeconds
        : null;
    } else if (step.kind === 'strength' && correction) {
      const correctionBySetNumber = new Map(
        correction.setCorrections.map((entry) => [entry.setNumber, entry])
      );
      result.setResults = result.setResults.map((setResult) => {
        const setCorrection = correctionBySetNumber.get(setResult.setNumber);
        return setCorrection
          ? { ...setResult, reps: setCorrection.reps, weightKg: setCorrection.weightKg }
          : setResult;
      });
    }
    return result;
  });
  return record;
}

function isDeletedTrainingRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return false;
  }
  const deletedAt = Object.getOwnPropertyDescriptor(record, 'deletedAt');
  return Boolean(deletedAt && hasOwn(deletedAt, 'value') && deletedAt.value !== null);
}

module.exports = {
  applyTrainingRecordCorrection,
  buildEffectiveTrainingRecord,
  isDeletedTrainingRecord
};
