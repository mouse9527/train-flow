const { createPlanApplicationService } = require('./plan-application-service');
const { buildTimedWorkoutView } = require('./timed-workout-view');
const { createWorkoutApplicationService } = require('./workout-application-service');
const { createSessionRepository } = require('../domain/execution/session-repository');
const { createPlanRepository } = require('../domain/planning/plan-repository');
const { createLocalDatabase } = require('../services/local-database');
const { createDefaultPlans } = require('../domain/planning/default-plan-factory');

const activeExpirationDeliveries = new Set();

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

function ensureNotificationState(draft) {
  if (!draft.notifications) {
    draft.notifications = {};
  }
  if (!Array.isArray(draft.notifications.expiredOccurrences)) {
    draft.notifications.expiredOccurrences = [];
  }
  if (!Array.isArray(draft.notifications.pendingExpiredOccurrences)) {
    draft.notifications.pendingExpiredOccurrences = [];
  }
  if (!Array.isArray(draft.notifications.attemptedExpiredOccurrences)) {
    draft.notifications.attemptedExpiredOccurrences = [];
  }
  return draft.notifications;
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
    const snapshot = this.database.load();
    const persistedOccurrences = snapshot.notifications
      ? snapshot.notifications.expiredOccurrences
      : [];
    if (persistedOccurrences.includes(occurrenceId)) {
      this.notifiedOccurrences.add(occurrenceId);
      return;
    }
    const attemptedOccurrences = snapshot.notifications &&
      Array.isArray(snapshot.notifications.attemptedExpiredOccurrences)
      ? snapshot.notifications.attemptedExpiredOccurrences
      : [];
    if (activeExpirationDeliveries.has(occurrenceId)) {
      return;
    }
    if (attemptedOccurrences.includes(occurrenceId)) {
      this.notifiedOccurrences.add(occurrenceId);
      return;
    }
    activeExpirationDeliveries.add(occurrenceId);

    let claimedSnapshot = snapshot;
    let asynchronousDelivery = false;
    try {
      const pendingOccurrences = snapshot.notifications &&
        Array.isArray(snapshot.notifications.pendingExpiredOccurrences)
        ? snapshot.notifications.pendingExpiredOccurrences
        : [];
      if (!pendingOccurrences.includes(occurrenceId)) {
        try {
          claimedSnapshot = this.database.commit((draft) => {
            const notifications = ensureNotificationState(draft);
            if (!notifications.pendingExpiredOccurrences.includes(occurrenceId)) {
              notifications.pendingExpiredOccurrences.push(occurrenceId);
            }
          }, snapshot.localRevision);
        } catch (error) {
          return;
        }
      }

      try {
        this.database.commit((draft) => {
          const notifications = ensureNotificationState(draft);
          notifications.pendingExpiredOccurrences =
            notifications.pendingExpiredOccurrences.filter(
              (pendingOccurrenceId) => pendingOccurrenceId !== occurrenceId
            );
          if (!notifications.attemptedExpiredOccurrences.includes(occurrenceId)) {
            notifications.attemptedExpiredOccurrences.push(occurrenceId);
          }
        }, claimedSnapshot.localRevision);
      } catch (error) {
        return;
      }

      let deliveryResult;
      try {
        deliveryResult = this.notifyExpired(occurrenceId);
      } catch (error) {
        this.requeueFailedNotification(occurrenceId);
        return;
      }

      if (deliveryResult && typeof deliveryResult.then === 'function') {
        asynchronousDelivery = true;
        Promise.resolve(deliveryResult)
          .then(
            () => this.recordDeliveredNotification(occurrenceId),
            () => this.requeueFailedNotification(occurrenceId)
          )
          .finally(() => activeExpirationDeliveries.delete(occurrenceId));
        return;
      }

      this.recordDeliveredNotification(occurrenceId);
    } finally {
      if (!asynchronousDelivery) {
        activeExpirationDeliveries.delete(occurrenceId);
      }
    }
  }

  recordDeliveredNotification(occurrenceId) {
    this.notifiedOccurrences.add(occurrenceId);
    try {
      const deliverySnapshot = this.database.load();
      this.database.commit((draft) => {
        const notifications = ensureNotificationState(draft);
        notifications.pendingExpiredOccurrences =
          notifications.pendingExpiredOccurrences.filter(
            (pendingOccurrenceId) => pendingOccurrenceId !== occurrenceId
          );
        notifications.attemptedExpiredOccurrences =
          notifications.attemptedExpiredOccurrences.filter(
            (attemptedOccurrenceId) => attemptedOccurrenceId !== occurrenceId
          );
        if (!notifications.expiredOccurrences.includes(occurrenceId)) {
          notifications.expiredOccurrences.push(occurrenceId);
        }
      }, deliverySnapshot.localRevision);
    } catch (error) {
      // A durable attempted marker is intentionally terminal after external success.
    }
  }

  requeueFailedNotification(occurrenceId) {
    try {
      const failureSnapshot = this.database.load();
      const persistedOccurrences = failureSnapshot.notifications
        ? failureSnapshot.notifications.expiredOccurrences
        : [];
      if (persistedOccurrences.includes(occurrenceId)) {
        this.notifiedOccurrences.add(occurrenceId);
        return;
      }
      this.database.commit((draft) => {
        const notifications = ensureNotificationState(draft);
        notifications.attemptedExpiredOccurrences =
          notifications.attemptedExpiredOccurrences.filter(
            (attemptedOccurrenceId) => attemptedOccurrenceId !== occurrenceId
          );
        if (!notifications.pendingExpiredOccurrences.includes(occurrenceId)) {
          notifications.pendingExpiredOccurrences.push(occurrenceId);
        }
      }, failureSnapshot.localRevision);
    } catch (error) {
      // Without a confirmed retry marker, retain attempted state to prevent duplicates.
    }
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

  confirmClockAnomaly() {
    return this.execute('confirm_clock_anomaly', { reason: 'clock-confirmed' });
  }

  adjustTimer(deltaSeconds) {
    return this.execute('adjust_timer', { deltaSeconds });
  }

  previous() {
    return this.execute('previous_step');
  }

  skip() {
    return this.execute('skip_step_and_start_next', { stepId: this.currentStep().id });
  }

  earlyComplete() {
    return this.execute('early_complete_step_and_start_next', {
      stepId: this.currentStep().id
    });
  }

  confirmNext() {
    return this.execute('confirm_next_and_start_next', { stepId: this.currentStep().id });
  }

  startSet() {
    return this.execute('start_set', {
      stepId: this.currentStep().id,
      setNumber: this.session.currentSet
    });
  }

  completeSet({ reps, weightKg, loadKg }) {
    const actualWeight = weightKg === undefined ? loadKg : weightKg;
    return this.execute('complete_set', {
      stepId: this.currentStep().id,
      setNumber: this.session.currentSet,
      reps,
      weightKg: actualWeight
    });
  }

  addSet() {
    return this.execute('add_set', { stepId: this.currentStep().id });
  }

  reduceSet() {
    return this.execute('reduce_set', { stepId: this.currentStep().id });
  }

  completeManual() {
    return this.execute('complete_step', { stepId: this.currentStep().id });
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

  materializeDeadline() {
    if (!this.session || ['completed', 'aborted'].includes(this.session.status)) {
      return this.render();
    }
    const result = this.service.checkpoint('manual', {
      expectedSessionRevision: this.session.sessionRevision,
      commandKey: this.commandKeyFactory('manual'),
      nowMs: this.now()
    });
    this.session = result.session;
    return this.render();
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

function createMemoryStorage() {
  const values = new Map();
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return {
    getStorageSync(key) {
      return clone(values.get(key));
    },
    setStorageSync(key, value) {
      values.set(key, clone(value));
    },
    removeStorageSync(key) {
      values.delete(key);
    }
  };
}

function createDeveloperTimedWorkoutRuntime({ state = 'running', notifyExpired = () => {} } = {}) {
  const sampleStartAt = 1785717300000;
  let fixedNow = sampleStartAt;
  const useLiveClock = state === 'running';
  const now = () => useLiveClock ? Date.now() : fixedNow;
  let sequence = 0;
  const database = createLocalDatabase({ storage: createMemoryStorage(), now });
  const planId = createDefaultPlans({ now: () => sampleStartAt })[0].id;
  const runtime = createTimedWorkoutRuntime({
    database,
    now,
    idFactory: () => 'session_worked_sample',
    commandKeyFactory: (type) => `worked_sample_${type}_${++sequence}`,
    notifyExpired
  });
  const load = runtime.load.bind(runtime);
  load({ planId });
  runtime.start();
  if (state === 'paused') {
    fixedNow += 90_000;
    runtime.pause();
  } else if (state === 'expired') {
    fixedNow += 2 * 60_000;
    runtime.onHide();
    fixedNow += 4 * 60_000;
    runtime.onShow();
  }
  runtime.load = () => runtime.render();
  return runtime;
}

module.exports = {
  TimedWorkoutRuntime,
  createDeveloperTimedWorkoutRuntime,
  createTimedWorkoutRuntime
};
