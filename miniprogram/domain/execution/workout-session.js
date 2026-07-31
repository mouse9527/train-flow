const { assertWorkoutPlan } = require('../planning/plan-validation');
const { assertTimerSnapshot, CLOCK_BACKWARD_TOLERANCE_MS } = require('./timer-snapshot');
const { createTimerEngine } = require('../../services/timer-engine');
const { canonicalize } = require('../../utils/checksum');

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
  'elapsedRemainderMilliseconds',
  'currentStepIndex',
  'currentSet',
  'timer',
  'stepResults',
  'processedCommands',
  'sessionRevision',
  'lastCheckpointAt'
]);
const COMMAND_RECORD_FIELDS = Object.freeze(['key', 'type', 'fingerprint', 'sessionRevision']);
const COMMAND_FIELDS = Object.freeze([
  'type',
  'expectedSessionRevision',
  'commandKey',
  'nowMs',
  'payload'
]);
const COMMAND_PAYLOAD_FIELDS = Object.freeze({
  start_step: Object.freeze(['stepId']),
  checkpoint: Object.freeze(['reason']),
  pause: Object.freeze(['reason']),
  resume: Object.freeze(['reason']),
  adjust_timer: Object.freeze(['deltaSeconds']),
  complete_step: Object.freeze(['stepId']),
  confirm_next: Object.freeze(['stepId']),
  confirm_next_and_start_next: Object.freeze(['stepId']),
  early_complete_step: Object.freeze(['stepId']),
  early_complete_step_and_start_next: Object.freeze(['stepId']),
  skip_step: Object.freeze(['stepId']),
  skip_step_and_start_next: Object.freeze(['stepId']),
  previous_step: Object.freeze([]),
  complete_set: Object.freeze(['stepId', 'setNumber', 'reps', 'weightKg']),
  abort: Object.freeze(['reason'])
});
const BUSINESS_PROGRESSION_COMMANDS = Object.freeze([
  'start_step',
  'complete_step',
  'confirm_next',
  'confirm_next_and_start_next',
  'early_complete_step',
  'early_complete_step_and_start_next',
  'skip_step',
  'skip_step_and_start_next',
  'previous_step',
  'complete_set'
]);
const AUTO_START_PROGRESSION_COMMANDS = Object.freeze({
  confirm_next_and_start_next: 'confirm_next',
  early_complete_step_and_start_next: 'early_complete_step',
  skip_step_and_start_next: 'skip_step'
});
const STEP_RESULT_FIELDS = Object.freeze(['stepId', 'status', 'completedAt', 'setResults']);
const SET_RESULT_FIELDS = Object.freeze(['setNumber', 'reps', 'weightKg', 'completedAt']);

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

function assertNullableMeasurement(value, label) {
  if (value !== null && (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    value < 0
  )) {
    throw new TypeError(`${label} must be null or a non-negative finite number`);
  }
}

function assertSetResult(result, label) {
  assertClosedObject(result, SET_RESULT_FIELDS, label);
  assertSafeInteger(result.setNumber, `${label}.setNumber`, 1);
  if (result.reps !== null) {
    assertSafeInteger(result.reps, `${label}.reps`, 1);
  }
  assertNullableMeasurement(result.weightKg, `${label}.weightKg`);
  assertSafeInteger(result.completedAt, `${label}.completedAt`);
}

function assertStepResult(result, index) {
  const label = `session.stepResults[${index}]`;
  assertClosedObject(result, STEP_RESULT_FIELDS, label);
  assertNonEmptyString(result.stepId, `${label}.stepId`);
  if (!['completed', 'skipped', 'in_progress'].includes(result.status)) {
    throw new TypeError(`${label}.status must be completed, skipped or in_progress`);
  }
  if (result.completedAt !== null) {
    assertSafeInteger(result.completedAt, `${label}.completedAt`);
  }
  if ((result.status !== 'in_progress') !== (result.completedAt !== null)) {
    throw new TypeError(`${label} status and completedAt must agree`);
  }
  if (!Array.isArray(result.setResults)) {
    throw new TypeError(`${label}.setResults must be an array`);
  }
  result.setResults.forEach((entry, setIndex) => assertSetResult(entry, `${label}.setResults[${setIndex}]`));
  const setNumbers = result.setResults.map(({ setNumber }) => setNumber);
  if (new Set(setNumbers).size !== setNumbers.length) {
    throw new TypeError(`${label}.setResults setNumber values must be unique`);
  }
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
  if (session.planSnapshot.status !== 'scheduled') {
    throw new TypeError('session PlanSnapshot must preserve a scheduled workout plan');
  }
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
  assertSafeInteger(session.elapsedRemainderMilliseconds, 'session.elapsedRemainderMilliseconds');
  if (session.elapsedRemainderMilliseconds >= 1_000) {
    throw new TypeError('session.elapsedRemainderMilliseconds must be less than 1000');
  }
  assertSafeInteger(session.currentStepIndex, 'session.currentStepIndex');
  const terminal = session.status === 'completed' || session.status === 'aborted';
  if (
    session.status === 'completed'
      ? session.currentStepIndex !== session.planSnapshot.steps.length
      : session.currentStepIndex >= session.planSnapshot.steps.length
  ) {
    throw new TypeError('session.currentStepIndex is outside PlanSnapshot steps');
  }
  if (session.currentSet !== null) {
    assertSafeInteger(session.currentSet, 'session.currentSet', 1);
  }
  const currentStep = session.planSnapshot.steps[session.currentStepIndex] || null;
  if (session.timer !== null) {
    assertTimerSnapshot(session.timer);
    if (session.status === 'paused' && session.timer.status !== 'paused') {
      throw new TypeError('paused session requires a paused timer when a timer exists');
    }
    if (session.status === 'in_progress' && session.timer.status === 'paused') {
      throw new TypeError('in-progress session cannot retain a paused timer');
    }
    if (!currentStep || session.timer.stepId !== currentStep.id) {
      throw new TypeError('session timer identity must match the current PlanSnapshot step');
    }
    if (session.timer.mode === 'rest' && session.timer.setNumber !== session.currentSet) {
      throw new TypeError('session rest timer identity must match currentSet');
    }
    if (session.timer.mode === 'rest' && session.currentSet < 2) {
      throw new TypeError('session rest timer requires a completed prior set');
    }
    if (
      session.timer.mode === 'step' &&
      currentStep.kind !== 'timed' &&
      currentStep.kind !== 'interval'
    ) {
      throw new TypeError('session step timer mode is unsupported by the current step kind');
    }
    if (
      session.timer.mode === 'rest' &&
      currentStep.kind !== 'strength' &&
      currentStep.kind !== 'interval'
    ) {
      throw new TypeError('session rest timer mode is unsupported by the current step kind');
    }
    const plannedDurationSeconds = session.timer.mode === 'step'
      ? currentStep.durationSeconds
      : currentStep.restSeconds;
    if (session.timer.durationSeconds !== plannedDurationSeconds) {
      throw new TypeError('session timer duration must match the current PlanSnapshot step');
    }
  }
  if (!Array.isArray(session.stepResults)) {
    throw new TypeError('session.stepResults must be an array');
  }
  session.stepResults.forEach(assertStepResult);
  const resultStepIds = session.stepResults.map(({ stepId }) => stepId);
  if (new Set(resultStepIds).size !== resultStepIds.length) {
    throw new TypeError('session.stepResults stepId values must be unique');
  }
  const knownStepIds = new Set(session.planSnapshot.steps.map(({ id }) => id));
  if (resultStepIds.some((stepId) => !knownStepIds.has(stepId))) {
    throw new TypeError('session.stepResults must reference PlanSnapshot steps');
  }
  let previousResultIndex = -1;
  session.stepResults.forEach((result) => {
    const resultIndex = session.planSnapshot.steps.findIndex(({ id }) => id === result.stepId);
    if (resultIndex <= previousResultIndex) {
      throw new TypeError('session.stepResults must follow PlanSnapshot step order');
    }
    if (resultIndex > session.currentStepIndex) {
      throw new TypeError('session.stepResults cannot contain future PlanSnapshot steps');
    }
    if (resultIndex < session.currentStepIndex && result.status === 'in_progress') {
      throw new TypeError('session prior stepResults must be terminal');
    }
    if (
      session.status !== 'completed' &&
      resultIndex === session.currentStepIndex &&
      result.status !== 'in_progress'
    ) {
      throw new TypeError('session current stepResult must remain in_progress');
    }
    const resultStep = session.planSnapshot.steps[resultIndex];
    result.setResults.forEach(({ setNumber }, setIndex) => {
      if (setNumber !== setIndex + 1) {
        throw new TypeError('session setResults setNumber values must be contiguous from 1');
      }
    });
    if (resultStep.sets !== null && result.setResults.some(({ setNumber }) => setNumber > resultStep.sets)) {
      throw new TypeError('session setResult cannot exceed PlanSnapshot step sets');
    }
    const tracksSets = resultStep.kind === 'strength' || resultStep.kind === 'interval';
    if (tracksSets && result.status === 'completed' && result.setResults.length !== resultStep.sets) {
      throw new TypeError('completed session stepResult requires every planned set');
    }
    if (
      tracksSets &&
      !terminal &&
      resultIndex === session.currentStepIndex &&
      result.setResults.length !== session.currentSet - 1
    ) {
      throw new TypeError('session currentSet must immediately follow contiguous setResults');
    }
    if (
      result.completedAt !== null &&
      (result.completedAt < session.startedAt || result.completedAt > session.lastCheckpointAt)
    ) {
      throw new TypeError('session stepResult completedAt must be within Session checkpoints');
    }
    if (result.setResults.some(
      ({ completedAt }) => completedAt < session.startedAt || completedAt > session.lastCheckpointAt
    )) {
      throw new TypeError('session setResult completedAt must be within Session checkpoints');
    }
    previousResultIndex = resultIndex;
  });
  for (let index = 0; index < session.currentStepIndex; index += 1) {
    if (!session.stepResults.some(
      ({ stepId, status }) => stepId === session.planSnapshot.steps[index].id && status !== 'in_progress'
    )) {
      throw new TypeError('session cannot advance past a step without its terminal result');
    }
  }
  if (session.status === 'completed' && session.stepResults.length !== session.planSnapshot.steps.length) {
    throw new TypeError('completed session requires a completed result for every step');
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
  if (session.processedCommands.length !== session.sessionRevision) {
    throw new TypeError('session command history length must match sessionRevision');
  }
  session.processedCommands.forEach((record, index) => {
    if (record.sessionRevision !== index + 1) {
      throw new TypeError('session command history revisions must be contiguous');
    }
  });
  if (session.processedCommands[0].type !== 'start_session') {
    throw new TypeError('session first command must be start_session');
  }
  const expectedStartFingerprint = JSON.stringify([
    'start_session',
    session.planId,
    session.planRevision,
    session.originDeviceId
  ]);
  if (session.processedCommands[0].fingerprint !== expectedStartFingerprint) {
    throw new TypeError('session start command fingerprint must match Session identity');
  }
  if (
    session.processedCommands[session.processedCommands.length - 1].sessionRevision !==
    session.sessionRevision
  ) {
    throw new TypeError('session latest command revision must match sessionRevision');
  }
  assertSafeInteger(session.lastCheckpointAt, 'session.lastCheckpointAt');
  if (session.lastCheckpointAt < session.startedAt) {
    throw new TypeError('session.lastCheckpointAt cannot be before startedAt');
  }
  const observedWallMilliseconds = session.lastCheckpointAt - session.startedAt;
  const observedWallSeconds = Math.floor(observedWallMilliseconds / 1_000);
  if (
    session.elapsedActiveSeconds > observedWallSeconds ||
    (
      session.elapsedActiveSeconds === observedWallSeconds &&
      session.elapsedRemainderMilliseconds > observedWallMilliseconds % 1_000
    )
  ) {
    throw new TypeError('session elapsed active time cannot exceed observed wall-clock time');
  }
  if (terminal !== (session.endedAt !== null)) {
    throw new TypeError('terminal session status and endedAt must agree');
  }
  if (terminal && session.endedAt !== session.lastCheckpointAt) {
    throw new TypeError('terminal session endedAt must equal its final checkpoint');
  }
  if (terminal && (session.timer !== null || session.currentSet !== null)) {
    throw new TypeError('terminal session cannot retain timer or currentSet state');
  }
  if (!terminal && currentStep) {
    const needsSet = currentStep.kind === 'strength' || currentStep.kind === 'interval';
    if (needsSet !== (session.currentSet !== null)) {
      throw new TypeError('session.currentSet must match the current step kind');
    }
    if (session.currentSet !== null && session.currentSet > currentStep.sets) {
      throw new TypeError('session.currentSet cannot exceed current step sets');
    }
    if (
      needsSet &&
      session.currentSet > 1 &&
      !session.stepResults.some(({ stepId }) => stepId === currentStep.id)
    ) {
      throw new TypeError('session currentSet after 1 requires the current stepResult');
    }
    if (
      needsSet &&
      session.currentSet > 1 &&
      currentStep.restSeconds > 0 &&
      session.timer === null
    ) {
      throw new TypeError('session currentSet after 1 requires its planned rest or step timer');
    }
  }
  return session;
}

function assertCommand(command) {
  assertClosedObject(command, COMMAND_FIELDS, 'command');
  assertNonEmptyString(command.type, 'command.type');
  const payloadFields = COMMAND_PAYLOAD_FIELDS[command.type];
  if (!payloadFields) {
    throw createSessionError(`Unsupported Session command ${command.type}`, 'SESSION_COMMAND_UNSUPPORTED');
  }
  assertSafeInteger(command.expectedSessionRevision, 'command.expectedSessionRevision', 1);
  assertNonEmptyString(command.commandKey, 'command.commandKey');
  assertSafeInteger(command.nowMs, 'command.nowMs');
  assertClosedObject(command.payload, payloadFields, 'command.payload');

  if (hasOwn(command.payload, 'stepId')) {
    assertNonEmptyString(command.payload.stepId, 'command.payload.stepId');
  }
  if (command.type === 'checkpoint') {
    if (!['hide', 'unload', 'startup', 'show', 'manual'].includes(command.payload.reason)) {
      throw new TypeError('command.payload.reason is not a supported checkpoint reason');
    }
  }
  if (command.type === 'abort' || command.type === 'pause' || command.type === 'resume') {
    assertNonEmptyString(command.payload.reason, 'command.payload.reason');
  }
  if (command.type === 'complete_set') {
    assertSafeInteger(command.payload.setNumber, 'command.payload.setNumber', 1);
    assertSafeInteger(command.payload.reps, 'command.payload.reps', 1);
    assertNullableMeasurement(command.payload.weightKg, 'command.payload.weightKg');
  }
  if (command.type === 'adjust_timer') {
    if (command.payload.deltaSeconds !== 30 && command.payload.deltaSeconds !== -30) {
      throw new TypeError('command.payload.deltaSeconds must be either 30 or -30');
    }
  }
  return command;
}

function commandFingerprint(command) {
  return canonicalize({
    type: command.type,
    expectedSessionRevision: command.expectedSessionRevision,
    nowMs: command.nowMs,
    payload: command.payload
  });
}

function currentStepFor(session) {
  return session.planSnapshot.steps[session.currentStepIndex] || null;
}

function findStepResult(session, stepId) {
  return session.stepResults.find((result) => result.stepId === stepId) || null;
}

function ensureStepResult(session, stepId) {
  let result = findStepResult(session, stepId);
  if (!result) {
    result = { stepId, status: 'in_progress', completedAt: null, setResults: [] };
    session.stepResults.push(result);
  }
  return result;
}

function assertBusinessProgressionStatus(session, command) {
  if (
    BUSINESS_PROGRESSION_COMMANDS.includes(command.type) &&
    session.status !== 'in_progress'
  ) {
    throw createSessionError(
      'Workout progression requires an in-progress Session',
      'SESSION_STATUS_INVALID'
    );
  }
}

function materializeCheckpoint(session, nowMs, timerEngine) {
  const previousCheckpointAt = session.lastCheckpointAt;
  const rollbackMilliseconds = previousCheckpointAt - nowMs;
  let timerClockAnomaly = false;

  if (session.timer !== null) {
    session.timer = timerEngine.restore(session.timer, nowMs);
    timerClockAnomaly =
      session.timer.status === 'paused' &&
      session.timer.pauseReason === 'clock-anomaly';
  }
  if (rollbackMilliseconds > 0) {
    if (session.timer === null && rollbackMilliseconds > CLOCK_BACKWARD_TOLERANCE_MS) {
      throw createSessionError(
        'Session checkpoint time exceeded the backward-clock tolerance',
        'SESSION_CLOCK_ANOMALY'
      );
    }
    if (timerClockAnomaly) {
      session.status = 'paused';
    }
    return;
  }
  if (timerClockAnomaly) {
    session.status = 'paused';
    session.lastCheckpointAt = nowMs;
    return;
  }
  if (session.status === 'in_progress') {
    const elapsedMilliseconds = nowMs - previousCheckpointAt;
    const remainderMilliseconds = session.elapsedRemainderMilliseconds + elapsedMilliseconds % 1_000;
    session.elapsedActiveSeconds += Math.floor(elapsedMilliseconds / 1_000) +
      Math.floor(remainderMilliseconds / 1_000);
    session.elapsedRemainderMilliseconds = remainderMilliseconds % 1_000;
  }
  session.lastCheckpointAt = nowMs;
}

function advanceAfterStep(session, stepId, nowMs, status = 'completed') {
  const result = ensureStepResult(session, stepId);
  result.status = status;
  result.completedAt = nowMs;
  session.timer = null;
  session.currentStepIndex += 1;
  if (session.currentStepIndex === session.planSnapshot.steps.length) {
    session.status = 'completed';
    session.endedAt = nowMs;
    session.currentSet = null;
    return;
  }
  const nextStep = currentStepFor(session);
  session.currentSet = nextStep.kind === 'strength' || nextStep.kind === 'interval' ? 1 : null;
}

function startCurrentTimedStep(session, nowMs, timerEngine) {
  if (session.status !== 'in_progress') {
    return;
  }
  const step = currentStepFor(session);
  if (!step || (step.kind !== 'timed' && step.kind !== 'interval')) {
    return;
  }
  session.timer = timerEngine.start({
    mode: 'step',
    durationSeconds: step.durationSeconds,
    stepId: step.id,
    setNumber: null
  }, nowMs);
}

function applyTransition(session, command, timerEngine) {
  assertBusinessProgressionStatus(session, command);
  materializeCheckpoint(session, command.nowMs, timerEngine);
  assertBusinessProgressionStatus(session, command);
  const step = currentStepFor(session);
  const progressionType = AUTO_START_PROGRESSION_COMMANDS[command.type] || command.type;
  const autoStartNext = Object.prototype.hasOwnProperty.call(
    AUTO_START_PROGRESSION_COMMANDS,
    command.type
  );
  const confirmsClockAnomaly =
    command.type === 'resume' &&
    session.timer !== null &&
    session.timer.pauseReason === 'clock-anomaly';
  const transitionNowMs = confirmsClockAnomaly
    ? command.nowMs
    : Math.max(command.nowMs, session.lastCheckpointAt);

  if (command.type === 'checkpoint') {
    return;
  }
  if (command.type === 'abort') {
    session.status = 'aborted';
    session.endedAt = transitionNowMs;
    session.timer = null;
    session.currentSet = null;
    return;
  }
  if (command.type === 'pause') {
    if (session.status !== 'in_progress') {
      throw createSessionError('Only an in-progress Session can pause', 'SESSION_PAUSE_INVALID');
    }
    if (session.timer !== null) {
      if (session.timer.status !== 'running') {
        throw createSessionError('Only a running timer can pause', 'SESSION_TIMER_PAUSE_INVALID');
      }
      session.timer = timerEngine.pause(session.timer, transitionNowMs);
    }
    session.status = 'paused';
    return;
  }
  if (command.type === 'resume') {
    if (session.status !== 'paused') {
      throw createSessionError('Only a paused Session can resume', 'SESSION_RESUME_INVALID');
    }
    if (session.timer !== null) {
      if (session.timer.status !== 'paused') {
        throw createSessionError('Only a paused timer can resume', 'SESSION_TIMER_RESUME_INVALID');
      }
      session.timer = timerEngine.resume(session.timer, transitionNowMs);
    }
    session.status = 'in_progress';
    return;
  }
  if (command.type === 'adjust_timer') {
    if (session.timer === null) {
      throw createSessionError('Current step has no timer to adjust', 'SESSION_TIMER_MISSING');
    }
    session.timer = timerEngine.adjust(
      session.timer,
      command.payload.deltaSeconds,
      transitionNowMs
    );
    return;
  }
  if (command.type === 'previous_step') {
    if (session.currentStepIndex === 0) {
      throw createSessionError('Session is already at the first step', 'SESSION_PREVIOUS_UNAVAILABLE');
    }
    const previousIndex = session.currentStepIndex - 1;
    const previousStep = session.planSnapshot.steps[previousIndex];
    if (previousStep.kind === 'strength' || previousStep.kind === 'interval') {
      throw createSessionError(
        'Set-tracking steps require a dedicated correction flow',
        'SESSION_PREVIOUS_UNSUPPORTED'
      );
    }
    const previousResult = findStepResult(session, previousStep.id);
    if (!previousResult || previousResult.status === 'in_progress') {
      throw createSessionError('Previous step has no terminal result', 'SESSION_PREVIOUS_UNAVAILABLE');
    }
    session.timer = null;
    session.currentStepIndex = previousIndex;
    session.currentSet = null;
    previousResult.status = 'in_progress';
    previousResult.completedAt = null;
    return;
  }
  if (command.payload.stepId !== step.id) {
    throw createSessionError('Command stepId does not match current step', 'SESSION_STEP_MISMATCH');
  }
  if (command.type === 'start_step') {
    if (session.timer !== null) {
      const completedIntervalRest = step.kind === 'interval' &&
        session.timer.mode === 'rest' &&
        session.timer.setNumber === session.currentSet &&
        session.timer.status === 'expired';
      if (!completedIntervalRest) {
        throw createSessionError('Current step already has a timer', 'SESSION_TIMER_ALREADY_STARTED');
      }
      session.timer = null;
    }
    if (step.kind !== 'timed' && step.kind !== 'interval') {
      throw createSessionError('Current step cannot start a step timer', 'SESSION_TIMER_UNSUPPORTED');
    }
    session.timer = timerEngine.start({
      mode: 'step',
      durationSeconds: step.durationSeconds,
      stepId: step.id,
      setNumber: null
    }, transitionNowMs);
    return;
  }
  if (
    session.timer !== null &&
    session.timer.mode === 'step' &&
    session.timer.status === 'expired' &&
    (progressionType === 'skip_step' || progressionType === 'early_complete_step')
  ) {
    throw createSessionError(
      'Expired step requires explicit next confirmation',
      'SESSION_EXPIRED_CONFIRMATION_REQUIRED'
    );
  }
  if (progressionType === 'complete_step' && step.kind === 'timed') {
    throw createSessionError(
      'Timed step completion requires confirm_next',
      'SESSION_CONFIRM_NEXT_REQUIRED'
    );
  }
  if (progressionType === 'complete_step' || progressionType === 'confirm_next') {
    if (progressionType === 'confirm_next' && step.kind === 'manual') {
      throw createSessionError(
        'Manual step does not have an expired timer to confirm',
        'SESSION_CONFIRM_NEXT_INVALID'
      );
    }
    if (step.kind !== 'manual') {
      if (session.timer === null || session.timer.mode !== 'step') {
        throw createSessionError('Timed step requires its matching timer', 'SESSION_TIMER_MISSING');
      }
      if (session.timer.status !== 'expired') {
        throw createSessionError('Step timer must expire before completion', 'SESSION_TIMER_NOT_EXPIRED');
      }
    }
    if (step.kind === 'interval' && session.currentSet < step.sets) {
      const result = ensureStepResult(session, step.id);
      result.setResults.push({
        setNumber: session.currentSet,
        reps: null,
        weightKg: null,
        completedAt: transitionNowMs
      });
      session.currentSet += 1;
      session.timer = step.restSeconds > 0 ? timerEngine.start({
        mode: 'rest',
        durationSeconds: step.restSeconds,
        stepId: step.id,
        setNumber: session.currentSet
      }, transitionNowMs) : null;
      return;
    }
    if (step.kind === 'interval') {
      ensureStepResult(session, step.id).setResults.push({
        setNumber: session.currentSet,
        reps: null,
        weightKg: null,
        completedAt: transitionNowMs
      });
    }
    advanceAfterStep(session, step.id, transitionNowMs);
    if (autoStartNext) {
      startCurrentTimedStep(session, transitionNowMs, timerEngine);
    }
    return;
  }
  if (progressionType === 'early_complete_step') {
    if (step.kind !== 'timed') {
      throw createSessionError(
        'Early completion is only available for timed steps',
        'SESSION_EARLY_COMPLETE_UNSUPPORTED'
      );
    }
    if (session.timer === null || session.timer.mode !== 'step') {
      throw createSessionError(
        'Early completion requires a started step timer',
        'SESSION_TIMER_MISSING'
      );
    }
    advanceAfterStep(session, step.id, transitionNowMs);
    if (autoStartNext) {
      startCurrentTimedStep(session, transitionNowMs, timerEngine);
    }
    return;
  }
  if (progressionType === 'skip_step') {
    advanceAfterStep(session, step.id, transitionNowMs, 'skipped');
    if (autoStartNext) {
      startCurrentTimedStep(session, transitionNowMs, timerEngine);
    }
    return;
  }
  if (command.type === 'complete_set') {
    if (step.kind !== 'strength') {
      throw createSessionError('complete_set requires a strength step', 'SESSION_SET_UNSUPPORTED');
    }
    if (command.payload.setNumber !== session.currentSet) {
      const existingResult = findStepResult(session, step.id);
      const existing = existingResult && existingResult.setResults
        .some(({ setNumber }) => setNumber === command.payload.setNumber);
      throw createSessionError(
        existing ? 'Set was already completed' : 'Set number does not match currentSet',
        existing ? 'SESSION_SET_ALREADY_COMPLETED' : 'SESSION_SET_MISMATCH'
      );
    }
    if (session.timer !== null) {
      if (
        session.timer.mode !== 'rest' ||
        session.timer.setNumber !== session.currentSet ||
        session.timer.status !== 'expired'
      ) {
        throw createSessionError('Rest timer must expire before next set', 'SESSION_REST_NOT_EXPIRED');
      }
      session.timer = null;
    }
    const result = ensureStepResult(session, step.id);
    if (result.setResults.some(({ setNumber }) => setNumber === command.payload.setNumber)) {
      throw createSessionError('Set was already completed', 'SESSION_SET_ALREADY_COMPLETED');
    }
    result.setResults.push({
      setNumber: command.payload.setNumber,
      reps: command.payload.reps,
      weightKg: command.payload.weightKg,
      completedAt: transitionNowMs
    });
    if (session.currentSet === step.sets) {
      advanceAfterStep(session, step.id, transitionNowMs);
      return;
    }
    session.currentSet += 1;
    session.timer = step.restSeconds > 0 ? timerEngine.start({
      mode: 'rest',
      durationSeconds: step.restSeconds,
      stepId: step.id,
      setNumber: session.currentSet
    }, transitionNowMs) : null;
  }
}

function applyWorkoutCommand(sourceSession, command, { timerEngine = createTimerEngine() } = {}) {
  assertWorkoutSession(sourceSession);
  assertCommand(command);
  const fingerprint = commandFingerprint(command);
  const existing = sourceSession.processedCommands.find(({ key }) => key === command.commandKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint || existing.type !== command.type) {
      throw createSessionError('Command key was already used for another command', 'SESSION_COMMAND_KEY_REUSED');
    }
    return { session: cloneJson(sourceSession), replayed: true };
  }
  if (command.expectedSessionRevision !== sourceSession.sessionRevision) {
    throw createSessionError('Session revision does not match command expectation', 'SESSION_REVISION_CONFLICT');
  }
  if (sourceSession.status === 'completed' || sourceSession.status === 'aborted') {
    throw createSessionError('Terminal Session rejects new commands', 'SESSION_TERMINAL');
  }

  const session = cloneJson(sourceSession);
  applyTransition(session, command, timerEngine);
  session.sessionRevision += 1;
  session.processedCommands.push({
    key: command.commandKey,
    type: command.type,
    fingerprint,
    sessionRevision: session.sessionRevision
  });
  assertWorkoutSession(session);
  return { session: cloneJson(session), replayed: false };
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
    elapsedRemainderMilliseconds: 0,
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
  applyWorkoutCommand,
  assertInertJson,
  assertWorkoutSession,
  cloneWorkoutSession: cloneJson,
  createSessionError,
  createWorkoutSession
};
