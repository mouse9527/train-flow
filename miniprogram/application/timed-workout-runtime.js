const { createPlanApplicationService } = require('./plan-application-service');
const { buildTimedWorkoutView } = require('./timed-workout-view');
const { createWorkoutApplicationService } = require('./workout-application-service');
const { createSessionRepository } = require('../domain/execution/session-repository');
const { createPlanRepository } = require('../domain/planning/plan-repository');
const { createLocalDatabase } = require('../services/local-database');

function defaultId(prefix, nowMs) {
  return `${prefix}_${nowMs}_${Math.random().toString(36).slice(2, 10)}`;
}

function recoveryView(error) {
  return {
    state: 'recovery-error',
    recoveryError: {
      recoverable: true,
      message: error instanceof Error ? error.message : '训练恢复失败，请重试'
    }
  };
}

class TimedWorkoutRuntime {
  constructor({
    database,
    now,
    idFactory,
    commandKeyFactory,
    notifyExpired
  }) {
    this.database = database;
    this.now = now;
    this.idFactory = idFactory;
    this.commandKeyFactory = commandKeyFactory;
    this.notifyExpired = notifyExpired;
    this.notifiedOccurrences = new Set();
    this.service = null;
    this.session = null;
    this.lastError = null;
  }

  ensureService() {
    if (this.service) {
      return;
    }
    let snapshot = this.database.load();
    if (snapshot.install === null) {
      const createdAt = this.now();
      snapshot = this.database.commit((draft) => {
        if (draft.install === null) {
          draft.install = {
            deviceId: defaultId('device', createdAt),
            createdAt
          };
        }
      }, snapshot.localRevision);
    }
    const planRepository = createPlanRepository({ database: this.database, now: this.now });
    createPlanApplicationService({ repository: planRepository }).initializeDefaultPlans();
    const sessionRepository = createSessionRepository({ database: this.database });
    this.service = createWorkoutApplicationService({
      planRepository,
      sessionRepository,
      deviceId: snapshot.install.deviceId,
      idFactory: this.idFactory,
      now: this.now
    });
  }

  load({ planId } = {}) {
    try {
      this.ensureService();
      const active = this.database.load().activeSession;
      if (active && active.status !== 'completed' && active.status !== 'aborted') {
        const restored = this.service.restoreOnStartup({
          expectedSessionRevision: active.sessionRevision,
          commandKey: this.commandKeyFactory('startup'),
          nowMs: this.now()
        });
        if (!restored.ok) {
          throw new Error(restored.error.message);
        }
        this.session = restored.session;
      } else if (planId) {
        this.session = this.service.startSession({
          planId,
          commandKey: this.commandKeyFactory('start_session'),
          nowMs: this.now()
        });
      } else if (active) {
        this.session = active;
      } else {
        throw new Error('没有可恢复的训练，请从今日训练重新开始');
      }
      return this.render();
    } catch (error) {
      this.lastError = error;
      return recoveryView(error);
    }
  }

  render() {
    if (this.lastError) {
      return recoveryView(this.lastError);
    }
    const view = buildTimedWorkoutView(this.session, { nowMs: this.now() });
    this.notifyIfExpired();
    return view;
  }

  notifyIfExpired() {
    const occurrenceId = this.session && this.session.timer &&
      this.session.timer.status === 'expired'
      ? this.session.timer.expirationOccurrenceId
      : null;
    if (!occurrenceId || this.notifiedOccurrences.has(occurrenceId)) {
      return;
    }
    this.notifiedOccurrences.add(occurrenceId);
    this.notifyExpired(occurrenceId);
  }

  execute(type, payload = {}) {
    const applied = this.service.execute({
      type,
      expectedSessionRevision: this.session.sessionRevision,
      commandKey: this.commandKeyFactory(type),
      nowMs: this.now(),
      payload
    });
    this.session = applied.session;
    return this.render();
  }

  currentStep() {
    return this.session.planSnapshot.steps[this.session.currentStepIndex] || null;
  }

  start() {
    return this.execute('start_step', { stepId: this.currentStep().id });
  }

  pause() {
    return this.execute('pause', { reason: 'user' });
  }

  resume() {
    return this.execute('resume', { reason: 'user' });
  }

  adjustTimer(deltaSeconds) {
    return this.execute('adjust_timer', { deltaSeconds });
  }

  previous() {
    return this.execute('previous_step');
  }

  autoStartNext(view) {
    if (view.state !== 'ready' || !this.currentStep()) {
      return view;
    }
    if (!['timed', 'interval'].includes(this.currentStep().kind)) {
      return view;
    }
    return this.start();
  }

  skip() {
    const view = this.execute('skip_step', { stepId: this.currentStep().id });
    return this.autoStartNext(view);
  }

  earlyComplete() {
    const view = this.execute('early_complete_step', { stepId: this.currentStep().id });
    return this.autoStartNext(view);
  }

  confirmNext() {
    const view = this.execute('complete_step', { stepId: this.currentStep().id });
    return this.autoStartNext(view);
  }

  endWorkout() {
    return this.execute('abort', { reason: 'user-ended-workout' });
  }

  checkpoint(methodName, reason) {
    if (!this.session || ['completed', 'aborted'].includes(this.session.status)) {
      return this.render();
    }
    const result = this.service[methodName]({
      expectedSessionRevision: this.session.sessionRevision,
      commandKey: this.commandKeyFactory(reason),
      nowMs: this.now()
    });
    if (result.ok === false) {
      this.lastError = new Error(result.error.message);
      return this.render();
    }
    this.session = result.session;
    return this.render();
  }

  onHide() {
    return this.checkpoint('checkpointOnHide', 'hide');
  }

  onShow() {
    return this.checkpoint('restoreOnShow', 'show');
  }

  onUnload() {
    return this.checkpoint('checkpointOnUnload', 'unload');
  }
}

function createTimedWorkoutRuntime({
  database = createLocalDatabase(),
  now = Date.now,
  idFactory = () => defaultId('session', now()),
  commandKeyFactory = (type) => defaultId(type, now()),
  notifyExpired = () => {}
} = {}) {
  return new TimedWorkoutRuntime({
    database,
    now,
    idFactory,
    commandKeyFactory,
    notifyExpired
  });
}

module.exports = {
  TimedWorkoutRuntime,
  createTimedWorkoutRuntime
};
