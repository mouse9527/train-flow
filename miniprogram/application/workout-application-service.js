const { createSessionError } = require('../domain/execution/workout-session');

const PAIN_FIELDS = Object.freeze(['knee', 'lowerBack', 'ankleOrToe', 'dizziness']);
const FEEDBACK_FIELDS = Object.freeze(['rpe', 'weightBeforeKg', 'pain', 'note']);
const SAFETY_ADVICE = '请立即停止训练，并根据症状严重程度寻求专业医疗或紧急帮助。';

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function normalizeNullableRpe(value) {
  if (value === undefined || value === null || value === '') {
    throw new TypeError('RPE is required and must be an integer between 1 and 10');
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new TypeError('RPE must be an integer between 1 and 10');
  }
  return value;
}

function createWorkoutFeedbackDraft() {
  return {
    rpe: null,
    weightBeforeKg: null,
    pain: {
      knee: false,
      lowerBack: false,
      ankleOrToe: false,
      dizziness: false
    },
    note: '',
    hasSafetyAlarm: false,
    safetyAdvice: null
  };
}

function normalizeNullableWeight(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    Math.abs(value * 10 - Math.round(value * 10)) > Number.EPSILON * 10
  ) {
    throw new TypeError('weightBeforeKg must be null or a non-negative kg value with at most one decimal place');
  }
  return value;
}

function normalizePain(value) {
  if (value === undefined || value === null) {
    value = {};
  }
  assertPlainObject(value, 'feedback.pain');
  const unknown = Object.keys(value).find((field) => !PAIN_FIELDS.includes(field));
  if (unknown) {
    throw new TypeError(`feedback.pain contains unknown field ${unknown}`);
  }
  const pain = {};
  for (const field of PAIN_FIELDS) {
    const entry = hasOwn(value, field) ? value[field] : false;
    if (typeof entry !== 'boolean') {
      throw new TypeError(`feedback.pain.${field} must be a boolean`);
    }
    pain[field] = entry;
  }
  return pain;
}

function normalizeWorkoutFeedback(input = {}) {
  assertPlainObject(input, 'feedback');
  const unknown = Object.keys(input).find((field) => !FEEDBACK_FIELDS.includes(field));
  if (unknown) {
    throw new TypeError(`feedback contains unknown field ${unknown}`);
  }
  const note = hasOwn(input, 'note') ? input.note : '';
  if (typeof note !== 'string' || note.length > 500) {
    throw new TypeError('feedback.note must be a string of at most 500 characters');
  }
  const pain = normalizePain(input.pain);
  const hasSafetyAlarm = PAIN_FIELDS.some((field) => pain[field]);
  return {
    rpe: normalizeNullableRpe(input.rpe),
    weightBeforeKg: normalizeNullableWeight(input.weightBeforeKg),
    pain,
    note,
    hasSafetyAlarm,
    safetyAdvice: hasSafetyAlarm ? SAFETY_ADVICE : null
  };
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function assertTerminalSession(session) {
  if (!session || !['completed', 'aborted'].includes(session.status)) {
    throw createSessionError('Workout summary requires a terminal Session', 'SESSION_NOT_TERMINAL');
  }
}

function buildWorkoutCompletionSummary(session) {
  assertTerminalSession(session);
  const completedStepCount = session.stepResults.filter(({ status }) => status === 'completed').length;
  const skippedStepCount = session.stepResults.filter(({ status }) => status === 'skipped').length;
  return {
    sessionId: session.id,
    status: session.status,
    trainingDate: session.trainingDate,
    planTitle: session.planSnapshot.title,
    elapsedActiveSeconds: session.elapsedActiveSeconds,
    elapsedLabel: formatDuration(session.elapsedActiveSeconds),
    completedStepCount,
    skippedStepCount,
    totalStepCount: session.planSnapshot.steps.length,
    endedAt: session.endedAt
  };
}

function createWorkoutCompletionFact(session, feedback = {}) {
  assertTerminalSession(session);
  const normalizedFeedback = normalizeWorkoutFeedback({
    rpe: feedback.rpe,
    weightBeforeKg: feedback.weightBeforeKg,
    pain: feedback.pain,
    note: feedback.note
  });
  return {
    schemaVersion: 1,
    occurrenceId: JSON.stringify(['workout-session-terminal', session.id, session.status, session.endedAt]),
    eventType: session.status === 'completed'
      ? 'WorkoutSessionCompleted'
      : 'WorkoutSessionAborted',
    sourceSessionId: session.id,
    status: session.status,
    trainingDate: session.trainingDate,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    elapsedActiveSeconds: session.elapsedActiveSeconds,
    planSnapshot: JSON.parse(JSON.stringify(session.planSnapshot)),
    stepResults: JSON.parse(JSON.stringify(session.stepResults)),
    feedback: {
      rpe: normalizedFeedback.rpe,
      weightBeforeKg: normalizedFeedback.weightBeforeKg,
      pain: normalizedFeedback.pain,
      note: normalizedFeedback.note
    }
  };
}

function assertDependency(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    throw new Error(`${label} must provide ${method}()`);
  }
}

function recoveryFailure(error) {
  return {
    ok: false,
    session: null,
    error: {
      code: error && error.code === 'SESSION_DEVICE_MISMATCH'
        ? error.code
        : 'SESSION_RECOVERY_REQUIRED',
      message: error instanceof Error ? error.message : 'Session recovery failed',
      recoverable: true
    }
  };
}

class WorkoutApplicationService {
  constructor({ planRepository, sessionRepository, deviceId, idFactory, now = Date.now }) {
    assertDependency(planRepository, 'findById', 'WorkoutApplicationService planRepository');
    assertDependency(sessionRepository, 'loadActive', 'WorkoutApplicationService sessionRepository');
    assertDependency(sessionRepository, 'start', 'WorkoutApplicationService sessionRepository');
    assertDependency(sessionRepository, 'apply', 'WorkoutApplicationService sessionRepository');
    if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
      throw new Error('WorkoutApplicationService deviceId must be a non-empty string');
    }
    if (typeof idFactory !== 'function' || typeof now !== 'function') {
      throw new Error('WorkoutApplicationService requires idFactory and now functions');
    }
    this.planRepository = planRepository;
    this.sessionRepository = sessionRepository;
    this.deviceId = deviceId;
    this.idFactory = idFactory;
    this.now = now;
  }

  startSession({ planId, commandKey, nowMs = this.now() }) {
    const plan = this.planRepository.findById(planId);
    if (plan === null) {
      throw createSessionError(`WorkoutPlan ${planId} is unavailable`, 'SESSION_PLAN_UNAVAILABLE');
    }
    return this.sessionRepository.start({
      plan,
      sessionId: this.idFactory(),
      originDeviceId: this.deviceId,
      commandKey,
      nowMs
    });
  }

  execute(command) {
    return this.sessionRepository.apply(command, { originDeviceId: this.deviceId });
  }

  checkpoint(reason, { expectedSessionRevision, commandKey, nowMs = this.now() }) {
    return this.execute({
      type: 'checkpoint',
      expectedSessionRevision,
      commandKey,
      nowMs,
      payload: { reason }
    });
  }

  checkpointOnHide(input) {
    return this.checkpoint('hide', input);
  }

  checkpointOnUnload(input) {
    return this.checkpoint('unload', input);
  }

  restore(reason, input) {
    try {
      const session = this.sessionRepository.loadActive();
      if (session === null) {
        return { ok: true, session: null, replayed: false };
      }
      if (session.originDeviceId !== this.deviceId) {
        throw createSessionError('Session belongs to another origin device', 'SESSION_DEVICE_MISMATCH');
      }
      if (session.status === 'completed' || session.status === 'aborted') {
        return { ok: true, session, replayed: false };
      }
      const restored = this.checkpoint(reason, input);
      return { ok: true, ...restored };
    } catch (error) {
      return recoveryFailure(error);
    }
  }

  restoreOnStartup(input) {
    return this.restore('startup', input);
  }

  restoreOnShow(input) {
    return this.restore('show', input);
  }
}

function createWorkoutApplicationService(options) {
  return new WorkoutApplicationService(options);
}

module.exports = {
  PAIN_FIELDS,
  SAFETY_ADVICE,
  WorkoutApplicationService,
  buildWorkoutCompletionSummary,
  createWorkoutApplicationService,
  createWorkoutCompletionFact,
  createWorkoutFeedbackDraft,
  normalizeWorkoutFeedback
};
