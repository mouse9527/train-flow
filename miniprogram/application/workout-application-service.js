const { createSessionError } = require('../domain/execution/workout-session');

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

module.exports = { WorkoutApplicationService, createWorkoutApplicationService };
