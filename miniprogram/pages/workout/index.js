const {
  createDeveloperTimedWorkoutRuntime,
  createTimedWorkoutRuntime
} = require('../../application/timed-workout-runtime');
const {
  createWechatDeviceAdapter
} = require('../../services/wechat-device-adapter');

function developerFixturesEnabled(wxApi) {
  if (!wxApi || typeof wxApi.getAccountInfoSync !== 'function') {
    return false;
  }
  try {
    const accountInfo = wxApi.getAccountInfoSync();
    return Boolean(
      accountInfo &&
      accountInfo.miniProgram &&
      accountInfo.miniProgram.envVersion === 'develop'
    );
  } catch (error) {
    return false;
  }
}

function progressionIntent(event, view) {
  const dataset = event && event.currentTarget && event.currentTarget.dataset
    ? event.currentTarget.dataset
    : {};
  const sessionRevision = Number(dataset.sessionRevision);
  return {
    stepId: typeof dataset.stepId === 'string' && dataset.stepId.length > 0
      ? dataset.stepId
      : view.step.id,
    sessionRevision: Number.isSafeInteger(sessionRevision) && sessionRevision > 0
      ? sessionRevision
      : view.sessionRevision
  };
}

function strengthSetIntent(event, view) {
  const dataset = event && event.currentTarget && event.currentTarget.dataset
    ? event.currentTarget.dataset
    : {};
  const setNumber = Number(dataset.setNumber);
  return {
    ...progressionIntent(event, view),
    setNumber: Number.isSafeInteger(setNumber) && setNumber > 0
      ? setNumber
      : view.strength.currentSet
  };
}

function createWorkoutPageDefinition({
  runtimeFactory = createTimedWorkoutRuntime,
  fixtureRuntimeFactory = createDeveloperTimedWorkoutRuntime,
  getWx = () => wx,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  return {
    data: {
      view: null,
      busy: false,
      actualReps: '',
      actualLoad: '',
      releaseFailureActionVisible: false
    },

    onLoad(query = {}) {
      this.isVisible = true;
      this.pageUnloaded = false;
      this.summaryNavigationStarted = false;
      this.summaryNavigationPending = false;
      this.releaseFailureModalStarted = false;
      const wxApi = getWx();
      const useFixture = developerFixturesEnabled(wxApi) && (
        query.fixture === 'worked-sample' || query.mode === 'strength'
      );
      const runtimeOptions = {
        deviceAdapterFactory: (settings) => createWechatDeviceAdapter({ wxApi, settings })
      };
      this.runtime = useFixture
        ? fixtureRuntimeFactory({
          mode: query.mode === 'strength' ? 'strength' : 'timed',
          state: query.state || (query.mode === 'strength' ? 'active' : 'running'),
          ...runtimeOptions
        })
        : runtimeFactory(runtimeOptions);
      this.syncView(this.runtime.load({ planId: useFixture ? undefined : query.planId }));
      this.startRefreshLoop();
    },

    onShow() {
      if (!this.runtime) {
        return;
      }
      this.isVisible = true;
      this.syncView(this.runtime.onShow());
      this.startRefreshLoop();
    },

    onHide() {
      this.isVisible = false;
      this.stopRefreshLoop();
      if (this.runtime) {
        this.syncView(this.runtime.onHide());
      }
    },

    onUnload() {
      this.isVisible = false;
      this.pageUnloaded = true;
      this.pendingConfirmation = null;
      this.summaryNavigationPending = false;
      this.stopRefreshLoop();
      const runtime = this.runtime;
      try {
        if (runtime) {
          this.syncView(runtime.onUnload());
        }
      } finally {
        if (runtime && typeof runtime.destroy === 'function') {
          runtime.destroy();
        }
        if (this.runtime === runtime) {
          this.runtime = null;
        }
      }
    },

    syncView(view) {
      const inputKey = view && view.strength
        ? `${view.sessionId}:${view.step.id}:${view.strength.currentSet}`
        : null;
      const nextData = { view, busy: false };
      if (inputKey !== this.strengthInputKey) {
        this.strengthInputKey = inputKey;
        nextData.actualReps = view && view.strength
          ? String(view.strength.actualReps)
          : '';
        nextData.actualLoad = view && view.strength && view.strength.actualWeightKg !== null
          ? String(view.strength.actualWeightKg)
          : '';
      }
      this.setData(nextData);
      if (
        view &&
        (view.state === 'completed' || view.state === 'aborted')
      ) {
        this.waitForTerminalEffectThenNavigate(view);
      }
      if (this.isVisible) {
        this.scheduleDeadline(view);
      }
    },

    waitForTerminalEffectThenNavigate(view) {
      if (
        this.pageUnloaded ||
        this.summaryNavigationStarted ||
        this.summaryNavigationPending ||
        this.data.releaseFailureActionVisible
      ) {
        return;
      }
      const runtime = this.runtime;
      this.summaryNavigationPending = true;
      this.stopRefreshLoop();
      const pending = runtime && typeof runtime.waitForTerminalEffect === 'function'
        ? runtime.waitForTerminalEffect()
        : Promise.resolve({ releaseFailed: false, view });
      Promise.resolve(pending).then(
        (outcome) => {
          if (this.pageUnloaded || this.runtime !== runtime || this.summaryNavigationStarted) {
            return;
          }
          this.summaryNavigationPending = false;
          const finalView = outcome && outcome.view ? outcome.view : view;
          this.setData({ view: finalView, busy: false });
          if (outcome && outcome.releaseFailed) {
            this.showReleaseFailureThenNavigate(finalView);
          } else {
            this.redirectToSummary(finalView);
          }
        },
        () => {
          if (this.pageUnloaded || this.runtime !== runtime || this.summaryNavigationStarted) {
            return;
          }
          this.summaryNavigationPending = false;
          this.showReleaseFailureThenNavigate({
            ...view,
            deviceNotice: '屏幕常亮关闭失败，自动释放暂不可用，请手动锁屏。'
          });
        }
      );
    },

    showReleaseFailureThenNavigate(view) {
      if (this.pageUnloaded || this.releaseFailureModalStarted) {
        return;
      }
      this.releaseFailureModalStarted = true;
      let settled = false;
      const proceed = () => {
        if (settled) return;
        settled = true;
        this.redirectToSummary(view);
      };
      const showFallbackAction = () => {
        if (settled || this.pageUnloaded) return;
        settled = true;
        this.setData({
          view,
          busy: false,
          releaseFailureActionVisible: true
        });
      };
      const wxApi = getWx();
      if (typeof wxApi.showModal !== 'function') {
        showFallbackAction();
        return;
      }
      try {
        wxApi.showModal({
          title: '屏幕常亮关闭失败',
          content: view.deviceNotice || '自动释放暂不可用，请手动锁屏后查看训练总结。',
          showCancel: false,
          confirmText: '查看总结',
          success: ({ confirm }) => {
            if (confirm === true) {
              proceed();
            } else {
              showFallbackAction();
            }
          },
          fail: showFallbackAction,
          complete: () => {
            if (!settled) {
              showFallbackAction();
            }
          }
        });
      } catch (error) {
        showFallbackAction();
      }
    },

    onViewSummary() {
      const view = this.data.view;
      if (
        !this.data.releaseFailureActionVisible ||
        !view ||
        !['completed', 'aborted'].includes(view.state)
      ) {
        return;
      }
      this.redirectToSummary(view);
    },

    redirectToSummary(view) {
      if (this.pageUnloaded || this.summaryNavigationStarted) {
        return;
      }
      const wxApi = getWx();
      if (typeof wxApi.redirectTo !== 'function') {
        return;
      }
      this.summaryNavigationStarted = true;
      this.summaryNavigationPending = false;
      this.stopRefreshLoop();
      wxApi.redirectTo({
        url: `/pages/workout/summary/index?sessionId=${encodeURIComponent(view.sessionId)}`,
        fail: () => {
          if (!this.pageUnloaded) {
            this.summaryNavigationStarted = false;
          }
        }
      });
    },

    startRefreshLoop() {
      if (this.refreshTimer) {
        return;
      }
      this.refreshTimer = setIntervalFn(() => {
        if (this.runtime) {
          this.syncView(this.runtime.render());
        }
      }, 1_000);
    },

    stopRefreshLoop() {
      if (this.refreshTimer) {
        clearIntervalFn(this.refreshTimer);
        this.refreshTimer = null;
      }
      if (this.deadlineTimer) {
        clearTimeoutFn(this.deadlineTimer);
        this.deadlineTimer = null;
      }
    },

    scheduleDeadline(view) {
      if (this.deadlineTimer) {
        clearTimeoutFn(this.deadlineTimer);
        this.deadlineTimer = null;
      }
      if (!view || view.state !== 'running' || !Number.isFinite(view.remainingSeconds)) {
        return;
      }
      this.deadlineTimer = setTimeoutFn(() => {
        this.deadlineTimer = null;
        if (this.runtime) {
          this.syncView(this.runtime.materializeDeadline());
        }
      }, Math.max(0, view.remainingSeconds * 1_000 + 30));
    },

    invoke(controlName, method, ...args) {
      const control = this.data.view && this.data.view.controls && this.data.view.controls[controlName];
      if (this.data.busy || !control || control.disabled) {
        return;
      }
      this.setData({ busy: true });
      try {
        this.syncView(this.runtime[method](...args));
      } catch (error) {
        this.setData({ busy: false });
        const wxApi = getWx();
        if (typeof wxApi.showToast === 'function') {
          wxApi.showToast({ title: error.message || '操作失败，请重试', icon: 'none' });
        }
      }
    },

    confirm({ title, content, confirmText = '确认', controlName, method }) {
      const control = this.data.view && this.data.view.controls && this.data.view.controls[controlName];
      if (!control || control.disabled || this.pendingConfirmation) {
        return;
      }
      const intent = { controlName, method };
      this.pendingConfirmation = intent;
      const settle = (confirmed) => {
        if (this.pendingConfirmation !== intent) {
          return;
        }
        this.pendingConfirmation = null;
        if (confirmed) {
          this.invoke(controlName, method);
        }
      };
      try {
        getWx().showModal({
          title,
          content,
          confirmText,
          cancelText: '取消',
          success: ({ confirm }) => settle(confirm === true),
          fail: () => settle(false),
          complete: () => {
            if (this.pendingConfirmation === intent) {
              settle(false);
            }
          }
        });
      } catch (error) {
        settle(false);
        throw error;
      }
    },

    onStart() { this.invoke('start', 'start'); },
    onPause() { this.invoke('pause', 'pause'); },
    onResume() { this.invoke('resume', 'resume'); },
    onConfirmClockAnomaly() {
      this.invoke('confirmClock', 'confirmClockAnomaly');
    },
    onPrevious() { this.invoke('previous', 'previous'); },
    onNext() { this.invoke('next', 'confirmNext'); },
    onStartSet() { this.invoke('startSet', 'startSet'); },
    onActualRepsInput({ detail }) { this.setData({ actualReps: detail.value }); },
    onActualWeightInput({ detail }) { this.setData({ actualLoad: detail.value }); },
    onCompleteSet(event) {
      this.invoke('completeSet', 'completeSet', {
        reps: Number(this.data.actualReps),
        loadKg: this.data.actualLoad === '' ? null : Number(this.data.actualLoad)
      }, strengthSetIntent(event, this.data.view));
    },
    onAddSet() { this.invoke('addSet', 'addSet'); },
    onReduceSet() { this.invoke('reduceSet', 'reduceSet'); },
    onCompleteManual(event) {
      this.invoke(
        'complete',
        'completeManual',
        progressionIntent(event, this.data.view)
      );
    },
    onSubtract30() { this.invoke('subtract30', 'adjustTimer', -30); },
    onAdd30() { this.invoke('add30', 'adjustTimer', 30); },

    onSkip() {
      this.confirm({
        title: '跳过这个动作？',
        content: '该动作会记录为已跳过，并进入下一个动作。',
        confirmText: '确认跳过',
        controlName: 'skip',
        method: 'skip'
      });
    },

    onEarlyComplete() {
      this.confirm({
        title: '提前完成这个动作？',
        content: '剩余时间不会自动补做，确认后将进入下一个动作。',
        confirmText: '确认完成',
        controlName: 'earlyComplete',
        method: 'earlyComplete'
      });
    },

    onEndWorkout() {
      this.confirm({
        title: '结束本次训练？',
        content: '本次训练会提前结束，当前计时与未完成动作不会继续。',
        confirmText: '结束训练',
        controlName: 'end',
        method: 'endWorkout'
      });
    }
  };
}

const definition = createWorkoutPageDefinition();
if (typeof Page === 'function') {
  Page(definition);
}

module.exports = {
  createWorkoutPageDefinition,
  developerFixturesEnabled
};
