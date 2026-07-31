const { LOCAL_TIME_PATTERN, TIMEZONE_PATTERN } = require('../../utils/constants');

const PLAN_FIELDS = Object.freeze([
  'schemaVersion',
  'id',
  'trainingDate',
  'timezone',
  'title',
  'summary',
  'estimatedDurationSeconds',
  'recommendedEndLocalTime',
  'safetyNoticeCodes',
  'status',
  'steps',
  'templateSource',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'revision'
]);
const STEP_FIELDS = Object.freeze([
  'id',
  'order',
  'kind',
  'name',
  'description',
  'durationSeconds',
  'sets',
  'reps',
  'restSeconds',
  'targets',
  'optional',
  'alternatives',
  'safetyNoticeCodes'
]);
const TARGET_FIELDS = new Set([
  'speedKph',
  'inclinePercent',
  'resistance',
  'cadenceSpm',
  'effortRpe',
  'durationSeconds',
  'weightKg'
]);
const STEP_KINDS = new Set(['timed', 'strength', 'interval', 'manual', 'rest_day']);

class PlanValidationError extends Error {
  constructor(fields) {
    super(`WorkoutPlan validation failed: ${fields.join('; ')}`);
    this.name = 'PlanValidationError';
    this.code = 'PLAN_VALIDATION_FAILED';
    this.fields = fields;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidTrainingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function pushUnexpectedFields(value, allowed, path, fields) {
  if (!isPlainObject(value)) {
    fields.push(`${path} must be an object`);
    return;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fields.push(`${path}.${key} is not supported`);
    }
  }
}

function validateStringArray(value, path, fields) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fields.push(`${path} must be an array of non-empty strings`);
  }
}

function validateTargets(targets, path, fields) {
  if (!isPlainObject(targets)) {
    fields.push(`${path} must be an object`);
    return;
  }
  for (const [key, range] of Object.entries(targets)) {
    if (!TARGET_FIELDS.has(key)) {
      fields.push(`${path}.${key} is not supported`);
      continue;
    }
    if (range === null) {
      continue;
    }
    if (!isPlainObject(range) || Object.keys(range).some((field) => field !== 'min' && field !== 'max')) {
      fields.push(`${path}.${key} must be null or a min/max object`);
      continue;
    }
    const min = Object.prototype.hasOwnProperty.call(range, 'min') ? range.min : null;
    const max = Object.prototype.hasOwnProperty.call(range, 'max') ? range.max : null;
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) {
      fields.push(`${path}.${key} min/max must be finite numbers or null`);
      continue;
    }
    if (min !== null && max !== null && min > max) {
      fields.push(`${path}.${key} min must not exceed max`);
    }
  }
}

function validateStep(step, path, fields) {
  pushUnexpectedFields(step, STEP_FIELDS, path, fields);
  if (!isPlainObject(step)) {
    return;
  }
  if (typeof step.id !== 'string' || step.id.length === 0) fields.push(`${path}.id is required`);
  if (!isPositiveInteger(step.order)) fields.push(`${path}.order must be a positive integer`);
  if (!STEP_KINDS.has(step.kind)) fields.push(`${path}.kind is unsupported`);
  if (typeof step.name !== 'string' || step.name.trim().length === 0) fields.push(`${path}.name is required`);
  if (typeof step.description !== 'string') fields.push(`${path}.description must be a string`);
  if (typeof step.optional !== 'boolean') fields.push(`${path}.optional must be a boolean`);
  validateStringArray(step.alternatives, `${path}.alternatives`, fields);
  validateStringArray(step.safetyNoticeCodes, `${path}.safetyNoticeCodes`, fields);
  validateTargets(step.targets, `${path}.targets`, fields);

  if (step.kind === 'timed') {
    if (!isPositiveInteger(step.durationSeconds)) fields.push(`${path}.durationSeconds must be positive for timed`);
    if (step.sets !== null || step.reps !== null || step.restSeconds !== null) fields.push(`${path} timed fields must not include sets/reps/restSeconds`);
  } else if (step.kind === 'strength') {
    if (step.durationSeconds !== null) fields.push(`${path}.durationSeconds must be null for strength`);
    if (!isPositiveInteger(step.sets)) fields.push(`${path}.sets must be positive for strength`);
    if (!isPositiveInteger(step.reps)) fields.push(`${path}.reps must be positive for strength`);
    if (!isNonNegativeInteger(step.restSeconds)) fields.push(`${path}.restSeconds must be non-negative for strength`);
  } else if (step.kind === 'interval') {
    if (!isPositiveInteger(step.durationSeconds)) fields.push(`${path}.durationSeconds must be positive for interval`);
    if (!isPositiveInteger(step.sets)) fields.push(`${path}.sets must be positive for interval`);
    if (step.reps !== null) fields.push(`${path}.reps must be null for interval`);
    if (!isNonNegativeInteger(step.restSeconds)) fields.push(`${path}.restSeconds must be non-negative for interval`);
  } else if (step.kind === 'manual') {
    if (step.durationSeconds !== null || step.restSeconds !== null) fields.push(`${path} manual steps cannot start timers`);
    if (step.sets !== null && !isPositiveInteger(step.sets)) fields.push(`${path}.sets must be positive or null for manual`);
    if (step.reps !== null && !isPositiveInteger(step.reps)) fields.push(`${path}.reps must be positive or null for manual`);
    if (step.sets === null && step.reps === null) fields.push(`${path} manual steps require sets or reps`);
  } else if (step.kind === 'rest_day') {
    if (step.durationSeconds !== null || step.sets !== null || step.reps !== null || step.restSeconds !== null) {
      fields.push(`${path} rest_day cannot contain timer or set fields`);
    }
    if (isPlainObject(step.targets) && Object.keys(step.targets).length > 0) fields.push(`${path}.targets must be empty for rest_day`);
  }
}

function assertWorkoutPlan(plan) {
  const fields = [];
  pushUnexpectedFields(plan, PLAN_FIELDS, 'plan', fields);
  if (!isPlainObject(plan)) {
    throw new PlanValidationError(fields);
  }
  if (plan.schemaVersion !== 1) fields.push('plan.schemaVersion must equal 1');
  if (typeof plan.id !== 'string' || plan.id.length === 0) fields.push('plan.id is required');
  if (!isValidTrainingDate(plan.trainingDate)) fields.push('plan.trainingDate must be a real YYYY-MM-DD date');
  if (typeof plan.timezone !== 'string' || !TIMEZONE_PATTERN.test(plan.timezone)) fields.push('plan.timezone must be UTC or an IANA timezone');
  if (typeof plan.title !== 'string' || plan.title.trim().length === 0) fields.push('plan.title is required');
  if (typeof plan.summary !== 'string') fields.push('plan.summary must be a string');
  if (!isNonNegativeInteger(plan.estimatedDurationSeconds)) fields.push('plan.estimatedDurationSeconds must be non-negative');
  if (plan.recommendedEndLocalTime !== null && (
    typeof plan.recommendedEndLocalTime !== 'string' || !LOCAL_TIME_PATTERN.test(plan.recommendedEndLocalTime)
  )) fields.push('plan.recommendedEndLocalTime must be HH:mm or null');
  validateStringArray(plan.safetyNoticeCodes, 'plan.safetyNoticeCodes', fields);
  if (!['scheduled', 'deleted'].includes(plan.status)) fields.push('plan.status must be scheduled or deleted');
  if (plan.templateSource !== null && (typeof plan.templateSource !== 'string' || plan.templateSource.length === 0)) fields.push('plan.templateSource must be null or a non-empty string');
  if (!Number.isFinite(plan.createdAt) || !Number.isFinite(plan.updatedAt)) fields.push('plan timestamps must be finite epoch milliseconds');
  if (plan.deletedAt !== null && !Number.isFinite(plan.deletedAt)) fields.push('plan.deletedAt must be null or a finite timestamp');
  if (!isPositiveInteger(plan.revision)) fields.push('plan.revision must be a positive integer');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    fields.push('plan.steps must contain at least one step');
  } else {
    plan.steps.forEach((step, index) => validateStep(step, `plan.steps[${index}]`, fields));
    const validSteps = plan.steps.filter(isPlainObject);
    const ids = validSteps.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) fields.push('plan.steps IDs must be unique');
    for (let index = 1; index < validSteps.length; index += 1) {
      if (!(validSteps[index - 1].order < validSteps[index].order)) {
        fields.push('plan.steps order must be strictly increasing');
        break;
      }
    }
    const restSteps = validSteps.filter(({ kind }) => kind === 'rest_day');
    if (restSteps.length > 0 && restSteps.length !== validSteps.length) fields.push('rest_day cannot be mixed with workout steps');
    if (restSteps.length > 0 && plan.estimatedDurationSeconds !== 0) fields.push('rest_day plan duration must be zero');
  }
  if ((plan.status === 'deleted') !== (plan.deletedAt !== null)) fields.push('deleted status and deletedAt must agree');
  if (fields.length > 0) throw new PlanValidationError(fields);
  return plan;
}

function canStartStepTimer(step) {
  return Boolean(step && (step.kind === 'timed' || step.kind === 'interval'));
}

module.exports = {
  PLAN_FIELDS,
  PlanValidationError,
  STEP_FIELDS,
  assertWorkoutPlan,
  canStartStepTimer
};
