const { createHash } = require('node:crypto');

const PLAN_FIELDS = Object.freeze([
  'schemaVersion', 'id', 'trainingDate', 'timezone', 'title', 'summary',
  'estimatedDurationSeconds', 'recommendedEndLocalTime', 'safetyNoticeCodes',
  'status', 'steps', 'templateSource', 'createdAt', 'updatedAt', 'deletedAt', 'revision'
]);
const STEP_FIELDS = Object.freeze([
  'id', 'order', 'kind', 'name', 'description', 'durationSeconds', 'sets', 'reps',
  'restSeconds', 'targets', 'optional', 'alternatives', 'safetyNoticeCodes'
]);
const TARGET_FIELDS = new Set([
  'speedKph', 'inclinePercent', 'resistance', 'cadenceSpm', 'effortRpe',
  'durationSeconds', 'weightKg'
]);
const STEP_KINDS = new Set(['timed', 'strength', 'interval', 'manual', 'rest_day']);
const SETTINGS_FIELDS = new Set([
  'vibrationEnabled', 'soundEnabled', 'voiceEnabled', 'keepScreenOn',
  'defaultStartLocalTime', 'recommendedEndLocalTime', 'defaultRestSeconds',
  'timezone', 'cloudSyncEnabled'
]);
const RECORD_REQUIRED_FIELDS = Object.freeze([
  'schemaVersion', 'occurrenceId', 'eventType', 'sourceSessionId', 'status',
  'trainingDate', 'startedAt', 'endedAt', 'elapsedActiveSeconds',
  'completedStepCount', 'skippedStepCount', 'totalStepCount', 'planSnapshot',
  'stepResults', 'feedback', 'id', 'createdAt', 'updatedAt', 'revision'
]);
const RECORD_FIELDS = new Set([
  ...RECORD_REQUIRED_FIELDS,
  'sourceSessionFingerprint',
  'actualCorrections',
  'processedCorrectionCommands'
]);
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/;

function invalid() {
  throw new TypeError('wire payload is invalid');
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function isPlainObject(value) {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactFields(value, fields) {
  return isPlainObject(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => hasOwn(value, field));
}

function assertClosedObject(value, allowedFields, requiredFields = allowedFields) {
  if (!isPlainObject(value)) invalid();
  const allowed = new Set(allowedFields);
  if (Object.keys(value).some((field) => !allowed.has(field))) invalid();
  if (requiredFields.some((field) => !hasOwn(value, field))) invalid();
}

function isSafeIntegerAtLeast(value, minimum) {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum;
}

function isPositiveInteger(value) {
  return isSafeIntegerAtLeast(value, 1);
}

function isNonNegativeInteger(value) {
  return isSafeIntegerAtLeast(value, 0);
}

function isValidTrainingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function assertStringArray(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    invalid();
  }
}

function assertTargets(targets) {
  if (!isPlainObject(targets)) invalid();
  for (const [field, range] of Object.entries(targets)) {
    if (!TARGET_FIELDS.has(field)) invalid();
    if (range === null) continue;
    if (
      !isPlainObject(range) ||
      Object.keys(range).some((key) => key !== 'min' && key !== 'max')
    ) invalid();
    const minimum = hasOwn(range, 'min') ? range.min : null;
    const maximum = hasOwn(range, 'max') ? range.max : null;
    if (
      (minimum !== null && !Number.isFinite(minimum)) ||
      (maximum !== null && !Number.isFinite(maximum)) ||
      (minimum !== null && maximum !== null && minimum > maximum)
    ) invalid();
  }
}

function assertStep(step) {
  assertClosedObject(step, STEP_FIELDS);
  if (
    typeof step.id !== 'string' || step.id.length === 0 ||
    !isPositiveInteger(step.order) ||
    !STEP_KINDS.has(step.kind) ||
    typeof step.name !== 'string' || step.name.trim().length === 0 ||
    typeof step.description !== 'string' ||
    typeof step.optional !== 'boolean'
  ) invalid();
  assertStringArray(step.alternatives);
  assertStringArray(step.safetyNoticeCodes);
  assertTargets(step.targets);

  if (step.kind === 'timed') {
    if (!isPositiveInteger(step.durationSeconds) || step.sets !== null || step.reps !== null || step.restSeconds !== null) invalid();
  } else if (step.kind === 'strength') {
    if (step.durationSeconds !== null || !isPositiveInteger(step.sets) || !isPositiveInteger(step.reps) || !isNonNegativeInteger(step.restSeconds)) invalid();
  } else if (step.kind === 'interval') {
    if (!isPositiveInteger(step.durationSeconds) || !isPositiveInteger(step.sets) || step.reps !== null || !isNonNegativeInteger(step.restSeconds)) invalid();
  } else if (step.kind === 'manual') {
    if (
      step.durationSeconds !== null || step.restSeconds !== null ||
      (step.sets !== null && !isPositiveInteger(step.sets)) ||
      (step.reps !== null && !isPositiveInteger(step.reps)) ||
      (step.sets === null && step.reps === null)
    ) invalid();
  } else if (
    step.durationSeconds !== null || step.sets !== null || step.reps !== null ||
    step.restSeconds !== null || Object.keys(step.targets).length > 0
  ) invalid();
}

function assertWorkoutPlan(plan) {
  assertClosedObject(plan, PLAN_FIELDS);
  if (
    plan.schemaVersion !== 1 ||
    typeof plan.id !== 'string' || plan.id.length === 0 ||
    !isValidTrainingDate(plan.trainingDate) ||
    typeof plan.timezone !== 'string' || !TIMEZONE_PATTERN.test(plan.timezone) ||
    typeof plan.title !== 'string' || plan.title.trim().length === 0 ||
    typeof plan.summary !== 'string' ||
    !isNonNegativeInteger(plan.estimatedDurationSeconds) ||
    (plan.recommendedEndLocalTime !== null && (
      typeof plan.recommendedEndLocalTime !== 'string' ||
      !LOCAL_TIME_PATTERN.test(plan.recommendedEndLocalTime)
    )) ||
    !['scheduled', 'deleted'].includes(plan.status) ||
    (plan.templateSource !== null && (
      typeof plan.templateSource !== 'string' || plan.templateSource.length === 0
    )) ||
    !Number.isFinite(plan.createdAt) || !Number.isFinite(plan.updatedAt) ||
    (plan.deletedAt !== null && !Number.isFinite(plan.deletedAt)) ||
    !isPositiveInteger(plan.revision) ||
    !Array.isArray(plan.steps) || plan.steps.length === 0
  ) invalid();
  assertStringArray(plan.safetyNoticeCodes);
  plan.steps.forEach(assertStep);
  const stepIds = plan.steps.map(({ id }) => id);
  if (new Set(stepIds).size !== stepIds.length) invalid();
  for (let index = 1; index < plan.steps.length; index += 1) {
    if (plan.steps[index - 1].order >= plan.steps[index].order) invalid();
  }
  const restSteps = plan.steps.filter(({ kind }) => kind === 'rest_day');
  if (
    (restSteps.length > 0 && restSteps.length !== plan.steps.length) ||
    (restSteps.length > 0 && plan.estimatedDurationSeconds !== 0) ||
    ((plan.status === 'deleted') !== (plan.deletedAt !== null))
  ) invalid();
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(value[key])}`
  )).join(',')}}`;
}

function checksum(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function validNullablePositiveInteger(value) {
  return value === null || isPositiveInteger(value);
}

function validNullableDuration(value) {
  return value === null || isNonNegativeInteger(value);
}

function validNullableMeasurement(value) {
  return value === null || (
    typeof value === 'number' && Number.isFinite(value) &&
    Number.isSafeInteger(Math.trunc(value)) && !Object.is(value, -0) &&
    value >= 0 && value <= Number.MAX_SAFE_INTEGER &&
    Math.abs(value * 10 - Math.round(value * 10)) <= Number.EPSILON * 10
  );
}

function assertFeedback(feedback) {
  if (feedback === null) return;
  if (
    !hasExactFields(feedback, ['rpe', 'weightBeforeKg', 'pain', 'note']) ||
    !Number.isSafeInteger(feedback.rpe) || feedback.rpe < 1 || feedback.rpe > 10 ||
    !validNullableMeasurement(feedback.weightBeforeKg) ||
    !hasExactFields(feedback.pain, ['knee', 'lowerBack', 'ankleOrToe', 'dizziness']) ||
    Object.values(feedback.pain).some((value) => typeof value !== 'boolean') ||
    typeof feedback.note !== 'string' || feedback.note.length > 500
  ) invalid();
}

function assertCommandReceipts(receipts, revision) {
  if (!Array.isArray(receipts) || receipts.length === 0) invalid();
  const keys = new Set();
  let previousRevision = 0;
  receipts.forEach((receipt, index) => {
    if (
      !hasExactFields(receipt, ['key', 'fingerprint', 'resultRevision']) ||
      typeof receipt.key !== 'string' || receipt.key.length === 0 ||
      !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
      !isSafeIntegerAtLeast(receipt.resultRevision, index === 0 ? 1 : 2) ||
      receipt.resultRevision > revision || receipt.resultRevision <= previousRevision ||
      keys.has(receipt.key)
    ) invalid();
    keys.add(receipt.key);
    previousRevision = receipt.resultRevision;
  });
  if (receipts[receipts.length - 1].resultRevision !== revision) invalid();
}

function assertSetResult(setResult, index, startedAt, completedAt) {
  if (
    !hasExactFields(setResult, ['setNumber', 'reps', 'weightKg', 'completedAt']) ||
    setResult.setNumber !== index + 1 ||
    !validNullablePositiveInteger(setResult.reps) ||
    !validNullableMeasurement(setResult.weightKg) ||
    !isSafeIntegerAtLeast(setResult.completedAt, startedAt) ||
    setResult.completedAt > completedAt
  ) invalid();
}

function assertStepResults(record) {
  if (!Array.isArray(record.stepResults)) invalid();
  if (
    record.stepResults.length > record.planSnapshot.steps.length ||
    (record.status === 'completed' && record.stepResults.length !== record.planSnapshot.steps.length)
  ) invalid();
  const seen = new Set();
  record.stepResults.forEach((result, index) => {
    const step = record.planSnapshot.steps[index];
    if (
      !step ||
      !hasExactFields(result, ['stepId', 'status', 'completedAt', 'setResults']) ||
      result.stepId !== step.id || seen.has(result.stepId) ||
      !['completed', 'skipped'].includes(result.status) ||
      !isSafeIntegerAtLeast(result.completedAt, record.startedAt) ||
      result.completedAt > record.endedAt ||
      !Array.isArray(result.setResults) ||
      (['manual', 'timed'].includes(step.kind) && result.setResults.length !== 0)
    ) invalid();
    seen.add(result.stepId);
    result.setResults.forEach((setResult, setIndex) => (
      assertSetResult(setResult, setIndex, record.startedAt, result.completedAt)
    ));
  });
}

function assertCorrection(correction, step, result) {
  if (!isPlainObject(correction) || correction.stepId !== step.id || result.status !== 'completed') invalid();
  if (step.kind === 'manual') {
    if (!hasExactFields(correction, ['stepId', 'actualReps']) || !validNullablePositiveInteger(correction.actualReps)) invalid();
    return;
  }
  if (step.kind === 'timed' || step.kind === 'interval') {
    if (!hasExactFields(correction, ['stepId', 'actualDurationSeconds']) || !validNullableDuration(correction.actualDurationSeconds)) invalid();
    return;
  }
  if (step.kind !== 'strength' || !hasExactFields(correction, ['stepId', 'setCorrections']) || !Array.isArray(correction.setCorrections)) invalid();
  const sourceSets = new Set(result.setResults.map(({ setNumber }) => setNumber));
  const seen = new Set();
  correction.setCorrections.forEach((entry) => {
    if (
      !hasExactFields(entry, ['setNumber', 'reps', 'weightKg']) ||
      !isPositiveInteger(entry.setNumber) || !sourceSets.has(entry.setNumber) ||
      seen.has(entry.setNumber) || !validNullablePositiveInteger(entry.reps) ||
      !validNullableMeasurement(entry.weightKg)
    ) invalid();
    seen.add(entry.setNumber);
  });
}

function assertCorrectionOverlay(record) {
  const hasCorrections = hasOwn(record, 'actualCorrections');
  const hasReceipts = hasOwn(record, 'processedCorrectionCommands');
  if (!hasCorrections && !hasReceipts) return;
  if (!hasCorrections || !hasReceipts || !Array.isArray(record.actualCorrections)) invalid();
  assertCommandReceipts(record.processedCorrectionCommands, record.revision);
  if (
    record.revision === 1 && (
      record.actualCorrections.length !== 0 ||
      record.processedCorrectionCommands.length !== 1 ||
      record.processedCorrectionCommands[0].resultRevision !== 1
    )
  ) invalid();
  const planSteps = new Map(record.planSnapshot.steps.map((step) => [step.id, step]));
  const results = new Map(record.stepResults.map((result) => [result.stepId, result]));
  const seen = new Set();
  record.actualCorrections.forEach((correction) => {
    const step = correction && planSteps.get(correction.stepId);
    const result = correction && results.get(correction.stepId);
    if (!step || !result || seen.has(step.id)) invalid();
    seen.add(step.id);
    assertCorrection(correction, step, result);
  });
}

function assertTrainingRecord(record) {
  assertClosedObject(record, RECORD_FIELDS, RECORD_REQUIRED_FIELDS);
  assertWorkoutPlan(record.planSnapshot);
  if (
    record.schemaVersion !== 1 ||
    typeof record.sourceSessionId !== 'string' || record.sourceSessionId.length === 0 ||
    record.id !== `record_${record.sourceSessionId}` ||
    !['completed', 'aborted'].includes(record.status) ||
    record.eventType !== (record.status === 'completed' ? 'WorkoutSessionCompleted' : 'WorkoutSessionAborted') ||
    record.occurrenceId !== JSON.stringify([
      'workout-session-terminal', record.sourceSessionId, record.status, record.endedAt
    ]) ||
    record.planSnapshot.status !== 'scheduled' ||
    record.trainingDate !== record.planSnapshot.trainingDate ||
    !isSafeIntegerAtLeast(record.startedAt, 0) ||
    !isSafeIntegerAtLeast(record.endedAt, record.startedAt) ||
    !isSafeIntegerAtLeast(record.elapsedActiveSeconds, 0) ||
    !isNonNegativeInteger(record.completedStepCount) ||
    !isNonNegativeInteger(record.skippedStepCount) ||
    record.totalStepCount !== record.planSnapshot.steps.length ||
    record.completedStepCount + record.skippedStepCount !== record.stepResults.length ||
    !isSafeIntegerAtLeast(record.createdAt, 0) ||
    !isSafeIntegerAtLeast(record.updatedAt, record.createdAt) ||
    !isPositiveInteger(record.revision)
  ) invalid();
  assertStepResults(record);
  const completed = record.stepResults.filter(({ status }) => status === 'completed').length;
  const skipped = record.stepResults.filter(({ status }) => status === 'skipped').length;
  if (record.completedStepCount !== completed || record.skippedStepCount !== skipped) invalid();
  assertFeedback(record.feedback);
  assertCorrectionOverlay(record);
  if (hasOwn(record, 'sourceSessionFingerprint')) {
    const expected = checksum({
      sourceSessionId: record.sourceSessionId,
      planSnapshot: record.planSnapshot,
      trainingDate: record.trainingDate,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      elapsedActiveSeconds: record.elapsedActiveSeconds,
      stepResults: record.stepResults
    });
    if (record.sourceSessionFingerprint !== expected) invalid();
  }
}

function assertSettingsPatch(payload) {
  if (!isPlainObject(payload)) invalid();
  const fields = Object.keys(payload);
  if (fields.length === 0 || fields.some((field) => !SETTINGS_FIELDS.has(field))) invalid();
  for (const [field, value] of Object.entries(payload)) {
    if (['vibrationEnabled', 'soundEnabled', 'voiceEnabled', 'keepScreenOn', 'cloudSyncEnabled'].includes(field)) {
      if (typeof value !== 'boolean') invalid();
    } else if (['defaultStartLocalTime', 'recommendedEndLocalTime'].includes(field)) {
      if (typeof value !== 'string' || !LOCAL_TIME_PATTERN.test(value)) invalid();
    } else if (field === 'defaultRestSeconds') {
      if (!isSafeIntegerAtLeast(value, 0) || value > 600) invalid();
    } else if (typeof value !== 'string' || !TIMEZONE_PATTERN.test(value)) invalid();
  }
}

function assertWirePayload(entityType, payload) {
  if (entityType === 'workout_plan') assertWorkoutPlan(payload);
  else if (entityType === 'training_record') assertTrainingRecord(payload);
  else if (entityType === 'user_settings') assertSettingsPatch(payload);
  else invalid();
}

module.exports = {
  assertTrainingRecord,
  assertWirePayload,
  assertWorkoutPlan
};
