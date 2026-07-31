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
  if (!Array.isArray(draft.notifications.terminalOccurrences)) {
    draft.notifications.terminalOccurrences = [];
  }
  return draft.notifications;
}

class TimedWorkoutRuntime {
  constructor({
    database,
    now,
    idFactory,
    commandKeyFactory,
    notifyExpired,
    deviceAdapterFactory
  }) {
    this.database = database;
    this.now = now;
    this.idFactory = idFactory;
    this.commandKeyFactory = commandKeyFactory;
    this.notifyExpired = notifyExpired;
    this.deviceAdapterFactory = deviceAdapterFactory;
    this.deviceAdapter = null;
    this.settings = null;
    this.deviceNotice = null;
    this.deviceNoticePriority = 0;
    this.terminalEffectPromise = null;
    this.notifiedTerminalOccurrences = new Set();
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
    this.settings = snapshot.settings;
    if (typeof this.deviceAdapterFactory === 'function') {
      this.deviceAdapter = this.deviceAdapterFactory({ ...this.settings });
    }
  }

  observeDeviceEffect(effectName, result) {
    if (result && result.supported === false) {
      let notice;
      let priority;
      if (effectName === 'keep-screen') {
        notice = '屏幕常亮暂不可用，训练仍可继续。';
        priority = 2;
      } else if (effectName === 'keep-screen-release') {
        notice = '屏幕常亮关闭失败，自动释放暂不可用，请手动锁屏。';
        priority = 3;
      } else {
        notice = '设备提醒部分不可用，已保留页面视觉提示。';
        priority = 1;
      }
      if (priority >= this.deviceNoticePriority) {
        this.deviceNotice = notice;
        this.deviceNoticePriority = priority;
      }
    }
  }

  runDeviceEffect(effectName, callback) {
    let result;
    try {
      result = callback();
    } catch (error) {
      const failure = { supported: false };
      this.observeDeviceEffect(effectName, failure);
      return Promise.resolve(failure);
    }
    return Promise.resolve(result).then(
      (value) => {
        this.observeDeviceEffect(effectName, value);
        return value;
      },
      () => {
        const failure = { supported: false };
        this.observeDeviceEffect(effectName, failure);
        return failure;
      }
    );
  }

  setKeepScreen(enabled) {
    if (!this.deviceAdapter || typeof this.deviceAdapter.setKeepScreen !== 'function') {
      return Promise.resolve({ supported: true, skipped: true });
    }
    if (enabled && (!this.settings || this.settings.keepScreenOn !== true)) {
      return Promise.resolve({ supported: true, skipped: true });
    }
    return this.runDeviceEffect(
      enabled ? 'keep-screen' : 'keep-screen-release',
      () => this.deviceAdapter.setKeepScreen(enabled)
    );
  }

  trackTerminalEffect(releaseEffect) {
    this.terminalEffectPromise = Promise.resolve(releaseEffect).then((result) => ({
      releaseFailed: Boolean(result && result.supported === false),
      view: this.render()
    }));
  }

  waitForTerminalEffect() {
    return this.terminalEffectPromise || Promise.resolve({
      releaseFailed: false,
      view: this.render()
    });
  }

  hasStartedActivity() {
    if (!this.session || ['completed', 'aborted'].includes(this.session.status)) {
      return false;
    }
    if (this.session.activeSetStartedAt !== null && this.session.activeSetStartedAt !== undefined) {
      return true;
    }
    const activityCommands = new Set([
      'start_step',
      'complete_step',
      'confirm_next',
      'confirm_next_and_start_next',
      'early_complete_step',
      'early_complete_step_and_start_next',
      'skip_step',
      'skip_step_and_start_next',
      'previous_step',
      'start_set',
      'complete_set',
      'add_set',
      'reduce_set'
    ]);
    return this.session.processedCommands.some(({ type }) => activityCommands.has(type));
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
      const keepScreenEffect = this.setKeepScreen(this.hasStartedActivity());
      const view = this.render();
      if (this.session.status === 'completed' || this.session.status === 'aborted') {
        this.trackTerminalEffect(keepScreenEffect);
      }
      return view;
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
    this.notifyIfTerminal();
    return this.deviceNotice ? { ...view, deviceNotice: this.deviceNotice } : view;
  }

  notifyIfTerminal() {
    if (
      !this.session ||
      !['completed', 'aborted'].includes(this.session.status) ||
      !this.deviceAdapter ||
      typeof this.deviceAdapter.notify !== 'function'
    ) {
      return;
    }
    const occurrenceId = JSON.stringify([
      'workout-session-terminal',
      this.session.id,
      this.session.status,
      this.session.endedAt
    ]);
    if (this.notifiedTerminalOccurrences.has(occurrenceId)) {
      return;
    }
    const snapshot = this.database.load();
    const persistedOccurrences = snapshot.notifications &&
      Array.isArray(snapshot.notifications.terminalOccurrences)
      ? snapshot.notifications.terminalOccurrences
      : [];
    if (persistedOccurrences.includes(occurrenceId)) {
      this.notifiedTerminalOccurrences.add(occurrenceId);
      return;
    }
    try {
      this.database.commit((draft) => {
        const notifications = ensureNotificationState(draft);
        if (!notifications.terminalOccurrences.includes(occurrenceId)) {
          notifications.terminalOccurrences.push(occurrenceId);
        }
      }, snapshot.localRevision);
    } catch (error) {
      return;
    }
    this.notifiedTerminalOccurrences.add(occurrenceId);
    const completed = this.session.status === 'completed';
    this.runDeviceEffect('notification', () => this.deviceAdapter.notify({
      occurrenceId,
      kind: completed ? 'session-completed' : 'session-aborted',
      visualMessage: completed ? '训练完成' : '训练已结束',
      voiceText: completed ? '训练完成，请填写身体反馈' : '训练已结束，请填写身体反馈'
    }));
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
        if (typeof this.notifyExpired === 'function') {
          deliveryResult = this.notifyExpired(occurrenceId);
        } else if (this.deviceAdapter && typeof this.deviceAdapter.notify === 'function') {
          deliveryResult = this.deviceAdapter.notify({
            occurrenceId,
            kind: this.session.timer.mode === 'rest' ? 'rest-expired' : 'timer-expired',
            visualMessage: this.session.timer.mode === 'rest'
              ? '休息结束，请确认下一组'
              : '计时结束，请确认下一步',
            voiceText: this.session.timer.mode === 'rest' ? '休息结束' : '计时结束'
          });
        }
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

  execute(type, payload = {}, { expectedSessionRevision = this.session.sessionRevision } = {}) {
    const applied = this.service.execute({
      type,
      expectedSessionRevision,
      commandKey: this.commandKeyFactory(type),
      nowMs: this.now(),
      payload
    });
    this.session = applied.session;
    let terminalReleaseEffect = null;
    if (this.session.status === 'completed' || this.session.status === 'aborted') {
      terminalReleaseEffect = this.setKeepScreen(false);
    } else {
      this.setKeepScreen(this.hasStartedActivity());
    }
    const view = this.render();
    if (terminalReleaseEffect) {
      this.trackTerminalEffect(terminalReleaseEffect);
    }
    return view;
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

  completeSet({ reps, weightKg, loadKg }, intent = {}) {
    const actualWeight = weightKg === undefined ? loadKg : weightKg;
    const currentStep = this.currentStep();
    return this.execute('complete_set', {
      stepId: intent.stepId === undefined ? currentStep.id : intent.stepId,
      setNumber: intent.setNumber === undefined ? this.session.currentSet : intent.setNumber,
      reps,
      weightKg: actualWeight
    }, {
      expectedSessionRevision: intent.sessionRevision === undefined
        ? this.session.sessionRevision
        : intent.sessionRevision
    });
  }

  addSet() {
    return this.execute('add_set', { stepId: this.currentStep().id });
  }

  reduceSet() {
    return this.execute('reduce_set', { stepId: this.currentStep().id });
  }

  completeManual(intent = {}) {
    const currentStep = this.currentStep();
    return this.execute('complete_step', {
      stepId: intent.stepId || currentStep.id
    }, {
      expectedSessionRevision: intent.sessionRevision || this.session.sessionRevision
    });
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
    try {
      return this.checkpoint('checkpointOnHide', 'hide');
    } finally {
      this.setKeepScreen(false);
    }
  }

  onShow() {
    const view = this.checkpoint('restoreOnShow', 'show');
    this.setKeepScreen(this.hasStartedActivity());
    return view;
  }

  onUnload() {
    try {
      return this.checkpoint('checkpointOnUnload', 'unload');
    } finally {
      this.setKeepScreen(false);
    }
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
  notifyExpired,
  deviceAdapterFactory
} = {}) {
  return new TimedWorkoutRuntime({
    database,
    now,
    idFactory,
    commandKeyFactory,
    notifyExpired,
    deviceAdapterFactory
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

function createDeveloperTimedWorkoutRuntime({
  mode = 'timed',
  state = mode === 'strength' ? 'active' : 'running',
  notifyExpired,
  deviceAdapterFactory
} = {}) {
  const sampleStartAt = 1785717300000;
  let fixedNow = sampleStartAt;
  const useLiveClock = mode === 'timed' && state === 'running';
  const now = () => useLiveClock ? Date.now() : fixedNow;
  let sequence = 0;
  const database = createLocalDatabase({ storage: createMemoryStorage(), now });
  const plans = createDefaultPlans({ now: () => sampleStartAt });
  const plan = mode === 'strength'
    ? plans.find(({ steps }) => steps.some(({ kind }) => kind === 'strength'))
    : plans[0];
  const runtime = createTimedWorkoutRuntime({
    database,
    now,
    idFactory: () => 'session_worked_sample',
    commandKeyFactory: (type) => `worked_sample_${type}_${++sequence}`,
    notifyExpired,
    deviceAdapterFactory
  });
  const load = runtime.load.bind(runtime);
  load({ planId: plan.id });
  if (mode === 'strength') {
    while (runtime.currentStep() && runtime.currentStep().kind !== 'strength') {
      runtime.skip();
    }
    if (state === 'rest' || state === 'expired') {
      const view = runtime.render();
      runtime.completeSet({ reps: view.strength.targetReps, weightKg: null });
    }
    if (state === 'expired') {
      fixedNow = runtime.session.timer.expectedEndAt;
      runtime.onShow();
    }
  } else {
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
  }
  runtime.load = () => runtime.render();
  return runtime;
}

module.exports = {
  TimedWorkoutRuntime,
  createDeveloperTimedWorkoutRuntime,
  createTimedWorkoutRuntime
};
