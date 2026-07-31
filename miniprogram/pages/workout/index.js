const {
  createDeveloperTimedWorkoutRuntime,
  createTimedWorkoutRuntime
} = require('../../application/timed-workout-runtime');

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

function callWxApi(wxApi, methodName, options = {}) {
  if (typeof wxApi[methodName] !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    try {
      wxApi[methodName]({
        ...options,
        success: resolve,
        fail(error) {
          reject(error instanceof Error ? error : new Error(
            error && error.errMsg ? error.errMsg : `${methodName} failed`
          ));
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function notifyWorkoutExpired(wxApi) {
  await callWxApi(wxApi, 'vibrateLong');
  await callWxApi(wxApi, 'showToast', {
    title: '计时结束，请确认下一步',
    icon: 'none'
  });
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
      actualLoad: ''
    },

    onLoad(query = {}) {
      this.isVisible = true;
      const wxApi = getWx();
      const useFixture = developerFixturesEnabled(wxApi) && query.fixture === 'worked-sample';
      const runtimeOptions = {
        notifyExpired: () => notifyWorkoutExpired(wxApi)
      };
      this.runtime = useFixture
        ? fixtureRuntimeFactory({ state: query.state || 'running', ...runtimeOptions })
        : runtimeFactory(runtimeOptions);
      if (typeof wxApi.setKeepScreenOn === 'function') {
        wxApi.setKeepScreenOn({ keepScreenOn: true });
      }
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
      this.stopRefreshLoop();
      if (this.runtime) {
        this.syncView(this.runtime.onUnload());
      }
      const wxApi = getWx();
      if (typeof wxApi.setKeepScreenOn === 'function') {
        wxApi.setKeepScreenOn({ keepScreenOn: false });
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
      if (this.isVisible) {
        this.scheduleDeadline(view);
      }
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
    onCompleteSet() {
      this.invoke('completeSet', 'completeSet', {
        reps: Number(this.data.actualReps),
        loadKg: this.data.actualLoad === '' ? null : Number(this.data.actualLoad)
      });
    },
    onAddSet() { this.invoke('addSet', 'addSet'); },
    onReduceSet() { this.invoke('reduceSet', 'reduceSet'); },
    onCompleteManual() { this.invoke('complete', 'completeManual'); },
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
