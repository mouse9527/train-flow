const assert = require('node:assert/strict');
const test = require('node:test');

const PAGE_PATH = require.resolve('../../miniprogram/pages/workout/index');

function loadPageDefinition(wxApi) {
  delete require.cache[PAGE_PATH];
  const originalPage = global.Page;
  let definition = null;
  global.wx = wxApi;
  global.Page = (candidate) => {
    definition = candidate;
  };
  try {
    require(PAGE_PATH);
  } finally {
    if (originalPage === undefined) delete global.Page;
    else global.Page = originalPage;
  }
  assert.ok(definition, 'workout page must register through Page()');
  return definition;
}

function instantiate(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      this.data = { ...this.data, ...next };
    }
  };
}

test('golden path: developer worked sample runs, pauses, resumes and recovers without personal storage writes', () => {
  const storageWrites = [];
  const wxApi = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } };
    },
    getStorageSync() { return undefined; },
    getStorageInfoSync() { return { keys: [] }; },
    setStorageSync(key) { storageWrites.push(key); },
    removeStorageSync(key) { storageWrites.push(key); },
    setKeepScreenOn() {},
    vibrateLong({ success }) { success(); },
    showToast({ success }) { success(); },
    showModal({ success }) { success({ confirm: true, cancel: false }); }
  };
  const page = instantiate(loadPageDefinition(wxApi));
  page.onLoad({ fixture: 'worked-sample', state: 'running' });
  assert.equal(page.data.view.state, 'running');
  assert.equal(page.data.view.step.name, '跑步机热身');
  assert.equal(page.data.view.positionLabel, '动作 1 / 7');

  page.onPause();
  assert.equal(page.data.view.state, 'paused');
  page.onAdd30();
  assert.equal(page.data.view.remainingSeconds > 300, true);
  page.onResume();
  assert.equal(page.data.view.state, 'running');
  page.onHide();
  page.onShow();
  assert.equal(page.data.view.currentStepIndex, 0);
  page.onUnload();
  assert.deepEqual(storageWrites, []);
  delete global.wx;
});

test('golden path: expired worked sample remains on the current step until explicit confirmation', () => {
  let vibrationCount = 0;
  const wxApi = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } };
    },
    setKeepScreenOn() {},
    vibrateLong({ success }) { vibrationCount += 1; success(); },
    showToast({ success }) { success(); },
    showModal({ success }) { success({ confirm: true, cancel: false }); }
  };
  const page = instantiate(loadPageDefinition(wxApi));
  page.onLoad({ fixture: 'worked-sample', state: 'expired' });
  assert.equal(page.data.view.state, 'expired-awaiting-confirmation');
  assert.equal(page.data.view.currentStepIndex, 0);
  assert.equal(page.data.view.step.name, '跑步机热身');
  assert.equal(page.data.view.showNextConfirmation, true);
  assert.equal(vibrationCount, 1);

  page.onNext();
  assert.equal(page.data.view.currentStepIndex, 1);
  assert.equal(page.data.view.step.name, '跑步机快走');
  assert.equal(page.data.view.state, 'running');
  page.onUnload();
  delete global.wx;
});
