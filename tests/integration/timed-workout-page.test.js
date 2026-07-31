const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTimedWorkoutRuntime
} = require('../../miniprogram/application/timed-workout-runtime');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785717300000; // 2026-08-03 08:35 Asia/Shanghai

function createHarness({ storage = new StorageDouble(), nowMs = START_AT } = {}) {
  let clock = nowMs;
  let commandSequence = 0;
  const notifications = [];
  const database = createLocalDatabase({ storage, now: () => clock });
  const plans = createDefaultPlans({ now: () => START_AT });
  database.commit((draft) => {
    draft.install = { deviceId: 'device_timed_page', createdAt: START_AT };
    draft.plans.push(...clone(plans));
  });
  const runtime = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_timed_page',
    commandKeyFactory: (type) => `page_${type}_${++commandSequence}`,
    notifyExpired: (occurrenceId) => notifications.push(occurrenceId)
  });
  return {
    database,
    notifications,
    plans,
    runtime,
    storage,
    setNow(value) {
      clock = value;
    }
  };
}

test('timed page runtime renders the confirmed workout facts and revisioned running controls', () => {
  const harness = createHarness();
  const loaded = harness.runtime.load({ planId: harness.plans[0].id });
  assert.equal(loaded.state, 'ready');
  assert.equal(loaded.step.name, '跑步机热身');
  assert.equal(loaded.positionLabel, '动作 1 / 7');
  assert.equal(loaded.elapsedLabel, '00:00');
  assert.equal(loaded.currentClockLabel, '08:35');
  assert.equal(loaded.recommendedEndLabel, '建议 09:10 前结束');
  assert.match(loaded.targetsLabel, /4\.0–4\.5 km\/h/);
  assert.match(loaded.targetsLabel, /坡度 0%/);
  assert.equal(loaded.timerLabel, '05:00');
  assert.equal(loaded.controls.start.disabled, false);
  assert.equal(loaded.controls.pause.disabled, true);

  const running = harness.runtime.start();
  assert.equal(running.state, 'running');
  assert.equal(running.controls.pause.disabled, false);
  assert.equal(running.controls.resume.disabled, true);

  harness.setNow(START_AT + 10_000);
  const paused = harness.runtime.pause();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.timerLabel, '04:50');
  assert.equal(paused.controls.resume.disabled, false);

  const extended = harness.runtime.adjustTimer(30);
  assert.equal(extended.timerLabel, '05:20');
  harness.setNow(START_AT + 20_000);
  const resumed = harness.runtime.resume();
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.sessionRevision, 5);
  assert.deepEqual(
    harness.database.load().activeSession.processedCommands.map(({ type }) => type),
    ['start_session', 'start_step', 'pause', 'adjust_timer', 'resume']
  );
});

test('08:35 start, 08:37 hide and 08:41 show expires only the current step and notifies once', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();

  harness.setNow(START_AT + 2 * 60_000);
  harness.runtime.onHide();
  harness.setNow(START_AT + 6 * 60_000);
  const expired = harness.runtime.onShow();
  assert.equal(expired.state, 'expired-awaiting-confirmation');
  assert.equal(expired.currentStepIndex, 0);
  assert.equal(expired.step.name, '跑步机热身');
  assert.equal(expired.timerLabel, '00:00');
  assert.equal(expired.showNextConfirmation, true);
  assert.equal(expired.controls.next.disabled, false);
  assert.equal(harness.notifications.length, 1);

  harness.setNow(START_AT + 6 * 60_000 + 5_000);
  const repeated = harness.runtime.onShow();
  assert.equal(repeated.currentStepIndex, 0);
  assert.equal(harness.notifications.length, 1);

  harness.setNow(START_AT + 6 * 60_000 + 10_000);
  const next = harness.runtime.confirmNext();
  assert.equal(next.currentStepIndex, 1);
  assert.equal(next.step.name, '跑步机快走');
  assert.equal(next.state, 'running');
  assert.equal(next.timerLabel, '12:00');
});

test('skip, previous, early complete and end workout preserve command revisions and valid states', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();
  harness.setNow(START_AT + 5_000);
  const skipped = harness.runtime.skip();
  assert.equal(skipped.currentStepIndex, 1);
  assert.equal(skipped.state, 'running');

  harness.setNow(START_AT + 10_000);
  const previous = harness.runtime.previous();
  assert.equal(previous.currentStepIndex, 0);
  assert.equal(previous.state, 'ready');
  assert.equal(previous.controls.previous.disabled, true);

  harness.runtime.start();
  harness.setNow(START_AT + 15_000);
  const early = harness.runtime.earlyComplete();
  assert.equal(early.currentStepIndex, 1);
  assert.equal(early.state, 'running');

  harness.setNow(START_AT + 20_000);
  const ended = harness.runtime.endWorkout();
  assert.equal(ended.state, 'aborted');
  assert.equal(ended.controls.end.disabled, true);
  assert.deepEqual(
    harness.database.load().activeSession.processedCommands.map(({ type }) => type),
    [
      'start_session',
      'start_step',
      'skip_step',
      'start_step',
      'previous_step',
      'start_step',
      'early_complete_step',
      'start_step',
      'abort'
    ]
  );
});

test('unload and a new runtime restore the same timer while corruption stays recoverable', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();
  harness.setNow(START_AT + 15_000);
  harness.runtime.onUnload();

  harness.setNow(START_AT + 30_000);
  const restarted = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage: harness.storage, now: () => START_AT + 30_000 }),
    now: () => START_AT + 30_000,
    idFactory: () => 'must_not_replace_session',
    commandKeyFactory: (type) => `restart_${type}`,
    notifyExpired() {}
  });
  const restored = restarted.load({});
  assert.equal(restored.currentStepIndex, 0);
  assert.equal(restored.state, 'running');
  assert.equal(restored.timerLabel, '04:30');
  assert.equal(restored.sessionId, 'session_timed_page');

  const corrupt = createTimedWorkoutRuntime({
    database: {
      load() {
        throw new Error('Unable to read a valid AppDatabase snapshot: checksum mismatch');
      },
      commit() {
        throw new Error('corrupt storage must not be overwritten');
      }
    },
    now: () => START_AT,
    idFactory: () => 'unused',
    commandKeyFactory: () => 'unused',
    notifyExpired() {}
  });
  const recovery = corrupt.load({ planId: harness.plans[0].id });
  assert.equal(recovery.state, 'recovery-error');
  assert.equal(recovery.recoveryError.recoverable, true);
  assert.match(recovery.recoveryError.message, /checksum|snapshot/i);
});

function pageView(overrides = {}) {
  const enabled = { disabled: false };
  return {
    state: 'running',
    remainingSeconds: 120,
    deadlineReached: false,
    controls: {
      start: enabled,
      pause: enabled,
      resume: enabled,
      previous: enabled,
      next: enabled,
      skip: enabled,
      earlyComplete: enabled,
      subtract30: enabled,
      add30: enabled,
      end: enabled
    },
    ...overrides
  };
}

function createPageHarness({ confirm = true } = {}) {
  const calls = [];
  const runtime = {};
  for (const method of [
    'load', 'render', 'start', 'pause', 'resume', 'previous', 'confirmNext',
    'skip', 'earlyComplete', 'adjustTimer', 'endWorkout', 'onHide', 'onShow',
    'onUnload', 'materializeDeadline'
  ]) {
    runtime[method] = (...args) => {
      calls.push([method, ...args]);
      return pageView();
    };
  }
  const intervalCallbacks = [];
  const timeoutCallbacks = [];
  const modalTitles = [];
  const wxApi = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } };
    },
    showModal(options) {
      modalTitles.push(options.title);
      options.success({ confirm, cancel: !confirm });
    },
    showToast() {},
    vibrateLong() {},
    setKeepScreenOn() {}
  };
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const definition = createWorkoutPageDefinition({
    runtimeFactory: () => runtime,
    fixtureRuntimeFactory: () => runtime,
    getWx: () => wxApi,
    setIntervalFn(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    clearIntervalFn() {},
    setTimeoutFn(callback) {
      timeoutCallbacks.push(callback);
      return timeoutCallbacks.length;
    },
    clearTimeoutFn() {}
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) {
      this.data = { ...this.data, ...next };
    }
  };
  return { calls, intervalCallbacks, modalTitles, page, timeoutCallbacks };
}

test('page lifecycle delegates to the runtime while interval refresh never mutates Session state', () => {
  const harness = createPageHarness();
  harness.page.onLoad({ fixture: 'worked-sample', state: 'running', planId: 'ignored' });
  assert.deepEqual(harness.calls[0], ['load', { planId: undefined }]);
  assert.equal(harness.intervalCallbacks.length, 1);
  assert.equal(harness.timeoutCallbacks.length, 1);

  harness.intervalCallbacks[0]();
  assert.equal(harness.calls.at(-1)[0], 'render');
  assert.equal(harness.calls.some(([method]) => method === 'materializeDeadline'), false);

  harness.timeoutCallbacks[0]();
  assert.equal(harness.calls.at(-1)[0], 'materializeDeadline');
  const timeoutCountBeforeHide = harness.timeoutCallbacks.length;
  harness.page.onHide();
  assert.equal(harness.timeoutCallbacks.length, timeoutCountBeforeHide);
  harness.page.onShow();
  harness.page.onUnload();
  assert.deepEqual(
    harness.calls.slice(-3).map(([method]) => method),
    ['onHide', 'onShow', 'onUnload']
  );
});

test('destructive and irreversible page controls require explicit confirmation', () => {
  const confirmed = createPageHarness({ confirm: true });
  confirmed.page.onLoad({});
  confirmed.page.onSkip();
  confirmed.page.onEarlyComplete();
  confirmed.page.onEndWorkout();
  assert.deepEqual(confirmed.modalTitles, ['跳过这个动作？', '提前完成这个动作？', '结束本次训练？']);
  assert.equal(confirmed.calls.filter(([method]) => method === 'skip').length, 1);
  assert.equal(confirmed.calls.filter(([method]) => method === 'earlyComplete').length, 1);
  assert.equal(confirmed.calls.filter(([method]) => method === 'endWorkout').length, 1);

  const cancelled = createPageHarness({ confirm: false });
  cancelled.page.onLoad({});
  cancelled.page.onEndWorkout();
  assert.equal(cancelled.calls.some(([method]) => method === 'endWorkout'), false);
});

test('workout page declares native timer components, large timer states and thumb-safe controls', () => {
  const root = path.resolve(__dirname, '../..');
  const pageJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/pages/workout/index.json'), 'utf8'));
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/workout/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/workout/index.wxss'), 'utf8');
  assert.deepEqual(pageJson.usingComponents, {
    'timer-display': '/components/timer-display/index'
  });
  for (const copy of ['进入下一步', '提前完成', '+30 秒', '-30 秒', '结束训练']) {
    assert.match(wxml, new RegExp(copy.replace('+', '\\+')));
  }
  assert.match(wxml, /expired-awaiting-confirmation/);
  assert.match(wxss, /padding-bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/);
  assert.match(wxss, /min-height:\s*96rpx/);

  const timerJson = JSON.parse(fs.readFileSync(
    path.join(root, 'miniprogram/components/timer-display/index.json'),
    'utf8'
  ));
  assert.equal(timerJson.component, true);
  assert.equal(timerJson.usingComponents['progress-ring'], '/components/progress-ring/index');
});
