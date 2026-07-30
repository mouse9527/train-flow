const { assertWorkoutPlan } = require('../planning/plan-validation');

const SESSION_SCHEMA_VERSION = 1;
const SESSION_STATUSES = Object.freeze(['in_progress', 'paused', 'completed', 'aborted']);
const SESSION_FIELDS = Object.freeze([
  'schemaVersion',
  'id',
  'planId',
  'planRevision',
  'planSnapshot',
  'trainingDate',
  'timezone',
  'originDeviceId',
  'status',
  'startedAt',
  'endedAt',
  'elapsedActiveSeconds',
  'currentStepIndex',
  'currentSet',
  'timer',
  'stepResults',
  'processedCommands',
  'sessionRevision',
  'lastCheckpointAt'
]);
const COMMAND_RECORD_FIELDS = Object.freeze(['key', 'type', 'fingerprint', 'sessionRevision']);

function createSessionError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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

function assertClosedObject(value, allowedFields, label) {
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
  for (const field of allowedFields) {
    if (!hasOwn(value, field)) {
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

function cloneJson(value) {
  assertInertJson(value);
  return JSON.parse(JSON.stringify(value));
}

function assertCommandRecord(record, index) {
  const label = `session.processedCommands[${index}]`;
  assertClosedObject(record, COMMAND_RECORD_FIELDS, label);
  assertNonEmptyString(record.key, `${label}.key`);
  assertNonEmptyString(record.type, `${label}.type`);
  assertNonEmptyString(record.fingerprint, `${label}.fingerprint`);
  assertSafeInteger(record.sessionRevision, `${label}.sessionRevision`, 1);
}

function assertWorkoutSession(session) {
  assertClosedObject(session, SESSION_FIELDS, 'session');
  if (session.schemaVersion !== SESSION_SCHEMA_VERSION) {
    throw new TypeError(`session.schemaVersion must equal ${SESSION_SCHEMA_VERSION}`);
  }
  assertNonEmptyString(session.id, 'session.id');
  assertNonEmptyString(session.planId, 'session.planId');
  assertSafeInteger(session.planRevision, 'session.planRevision', 1);
  assertWorkoutPlan(session.planSnapshot);
  if (
    session.planSnapshot.id !== session.planId ||
    session.planSnapshot.revision !== session.planRevision ||
    session.planSnapshot.trainingDate !== session.trainingDate ||
    session.planSnapshot.timezone !== session.timezone
  ) {
    throw new TypeError('session PlanSnapshot identity does not match session plan fields');
  }
  assertNonEmptyString(session.originDeviceId, 'session.originDeviceId');
  if (!SESSION_STATUSES.includes(session.status)) {
    throw new TypeError(`session.status must be one of ${SESSION_STATUSES.join(', ')}`);
  }
  assertSafeInteger(session.startedAt, 'session.startedAt');
  if (session.endedAt !== null) {
    assertSafeInteger(session.endedAt, 'session.endedAt');
    if (session.endedAt < session.startedAt) {
      throw new TypeError('session.endedAt cannot be before startedAt');
    }
  }
  assertSafeInteger(session.elapsedActiveSeconds, 'session.elapsedActiveSeconds');
  assertSafeInteger(session.currentStepIndex, 'session.currentStepIndex');
  const terminal = session.status === 'completed' || session.status === 'aborted';
  if (terminal ? session.currentStepIndex > session.planSnapshot.steps.length : session.currentStepIndex >= session.planSnapshot.steps.length) {
    throw new TypeError('session.currentStepIndex is outside PlanSnapshot steps');
  }
  if (session.currentSet !== null) {
    assertSafeInteger(session.currentSet, 'session.currentSet', 1);
  }
  if (session.timer !== null && (typeof session.timer !== 'object' || Array.isArray(session.timer))) {
    throw new TypeError('session.timer must be null or a TimerSnapshot object');
  }
  if (!Array.isArray(session.stepResults)) {
    throw new TypeError('session.stepResults must be an array');
  }
  if (!Array.isArray(session.processedCommands) || session.processedCommands.length === 0) {
    throw new TypeError('session.processedCommands must contain the start command');
  }
  session.processedCommands.forEach(assertCommandRecord);
  const commandKeys = session.processedCommands.map(({ key }) => key);
  if (new Set(commandKeys).size !== commandKeys.length) {
    throw new TypeError('session.processedCommands keys must be unique');
  }
  assertSafeInteger(session.sessionRevision, 'session.sessionRevision', 1);
  if (session.processedCommands.at(-1).sessionRevision !== session.sessionRevision) {
    throw new TypeError('session latest command revision must match sessionRevision');
  }
  assertSafeInteger(session.lastCheckpointAt, 'session.lastCheckpointAt');
  if (session.lastCheckpointAt < session.startedAt) {
    throw new TypeError('session.lastCheckpointAt cannot be before startedAt');
  }
  if (terminal !== (session.endedAt !== null)) {
    throw new TypeError('terminal session status and endedAt must agree');
  }
  return session;
}

function createWorkoutSession({
  plan,
  sessionId,
  originDeviceId,
  commandKey,
  nowMs
}) {
  assertInertJson(plan, 'plan');
  assertWorkoutPlan(plan);
  if (plan.status !== 'scheduled') {
    throw createSessionError('Session requires a scheduled plan', 'SESSION_PLAN_UNAVAILABLE');
  }
  if (plan.steps.every(({ kind }) => kind === 'rest_day')) {
    throw createSessionError('rest_day plans cannot create an active workout Session', 'SESSION_REST_DAY');
  }
  assertNonEmptyString(sessionId, 'sessionId');
  assertNonEmptyString(originDeviceId, 'originDeviceId');
  assertNonEmptyString(commandKey, 'commandKey');
  assertSafeInteger(nowMs, 'nowMs');

  const planSnapshot = cloneJson(plan);
  const firstStep = planSnapshot.steps[0];
  const session = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: sessionId,
    planId: planSnapshot.id,
    planRevision: planSnapshot.revision,
    planSnapshot,
    trainingDate: planSnapshot.trainingDate,
    timezone: planSnapshot.timezone,
    originDeviceId,
    status: 'in_progress',
    startedAt: nowMs,
    endedAt: null,
    elapsedActiveSeconds: 0,
    currentStepIndex: 0,
    currentSet: firstStep.kind === 'strength' || firstStep.kind === 'interval' ? 1 : null,
    timer: null,
    stepResults: [],
    processedCommands: [{
      key: commandKey,
      type: 'start_session',
      fingerprint: JSON.stringify(['start_session', planSnapshot.id, planSnapshot.revision, originDeviceId]),
      sessionRevision: 1
    }],
    sessionRevision: 1,
    lastCheckpointAt: nowMs
  };
  assertWorkoutSession(session);
  return cloneJson(session);
}

module.exports = {
  SESSION_SCHEMA_VERSION,
  SESSION_STATUSES,
  assertInertJson,
  assertWorkoutSession,
  cloneWorkoutSession: cloneJson,
  createSessionError,
  createWorkoutSession
};
