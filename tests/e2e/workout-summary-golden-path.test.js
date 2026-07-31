const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWorkoutSummaryPageDefinition
} = require('../../miniprogram/pages/workout/summary/index');
const {
  createWorkoutPageDefinition
} = require('../../miniprogram/pages/workout/index');
const { clone } = require('../helpers/storage-double');

function mount(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setData(next) { this.data = { ...this.data, ...next }; }
  };
}

function developerWx() {
  return {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } };
    },
    showToast() {}
  };
}

test('golden path renders honest completed and aborted worked samples on the real summary route', () => {
  for (const status of ['completed', 'aborted']) {
    const definition = createWorkoutSummaryPageDefinition({ getWx: developerWx });
    const page = mount(definition);
    page.onLoad({ fixture: 'worked-sample', status });

    assert.equal(page.data.summary.status, status);
    assert.equal(page.data.summary.totalStepCount, 7);
    assert.match(page.data.summary.elapsedLabel, /^\d{2}:\d{2}$/);
    assert.equal(page.data.validationError, null);
    if (status === 'aborted') {
      assert.ok(page.data.summary.completedStepCount < page.data.summary.totalStepCount);
      assert.match(page.data.safetyAdvice, /停止训练/);
    }
  }
});

test('golden path redirects one terminal workout occurrence to summary without duplicate navigation', () => {
  const redirects = [];
  const terminalView = {
    state: 'completed',
    sessionId: 'session_golden_terminal',
    remainingSeconds: null,
    controls: {}
  };
  const runtime = {
    load() { return terminalView; },
    render() { return terminalView; },
    onUnload() { return terminalView; }
  };
  const wxApi = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'release' } };
    },
    redirectTo(options) { redirects.push(options.url); }
  };
  const page = mount(createWorkoutPageDefinition({
    runtimeFactory: () => runtime,
    getWx: () => wxApi,
    setIntervalFn: () => 1,
    clearIntervalFn() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {}
  }));

  page.onLoad({});
  page.syncView(terminalView);
  assert.deepEqual(redirects, [
    '/pages/workout/summary/index?sessionId=session_golden_terminal'
  ]);
});
