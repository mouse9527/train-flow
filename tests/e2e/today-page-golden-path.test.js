const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTodayPage() {
  const pagePath = require.resolve('../../miniprogram/pages/today/index');
  delete require.cache[pagePath];
  let definition = null;
  const originalPage = global.Page;
  global.Page = (candidate) => {
    definition = candidate;
  };
  try {
    require(pagePath);
  } finally {
    if (originalPage === undefined) {
      delete global.Page;
    } else {
      global.Page = originalPage;
    }
  }
  assert.ok(definition, 'today page must register through Page()');
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) {
      this.data = { ...this.data, ...patch };
    }
  };
}

function withWxDouble(callback) {
  const calls = [];
  const values = new Map();
  const originalWx = global.wx;
  global.wx = {
    getStorageSync(key) {
      return values.has(key) ? values.get(key) : '';
    },
    getStorageInfoSync() {
      return { keys: [...values.keys()] };
    },
    setStorageSync(key, value) {
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
    removeStorageSync(key) {
      values.delete(key);
    },
    navigateTo(options) {
      calls.push(['navigateTo', options.url]);
    },
    switchTab(options) {
      calls.push(['switchTab', options.url]);
    }
  };
  try {
    callback(calls);
  } finally {
    if (originalWx === undefined) {
      delete global.wx;
    } else {
      global.wx = originalWx;
    }
  }
}

test('Today page renders repository-backed scheduled, completed, rest and empty fixtures', () => {
  const scheduled = loadTodayPage();
  scheduled.onLoad({ date: '2026-08-03' });
  assert.equal(scheduled.data.view.state, 'scheduled');
  assert.equal(scheduled.data.view.primaryAction.id, 'start');
  assert.ok(scheduled.data.view.steps.length > 1);

  const completed = loadTodayPage();
  completed.onLoad({ date: '2026-08-03', fixture: 'completed' });
  assert.equal(completed.data.view.state, 'completed');
  assert.equal(completed.data.view.weekSummary.completionRate, 17);
  assert.equal(completed.data.view.completedSessionSummary.durationLabel, '34 分钟');

  const rest = loadTodayPage();
  rest.onLoad({ date: '2026-08-09' });
  assert.equal(rest.data.view.state, 'rest');
  assert.equal(rest.data.view.primaryAction, null);

  const empty = loadTodayPage();
  empty.onLoad({ date: '2026-08-10' });
  assert.equal(empty.data.view.state, 'empty');
  assert.equal(empty.data.view.steps.length, 0);
});

test('Today page routes only the primary action supplied by TodayPlanView', () => {
  withWxDouble((calls) => {
    const scheduled = loadTodayPage();
    scheduled.onLoad({ date: '2026-08-03' });
    scheduled.onPrimaryAction();

    const active = loadTodayPage();
    active.onLoad({ date: '2026-08-03', fixture: 'active' });
    active.onPrimaryAction();

    const completed = loadTodayPage();
    completed.onLoad({ date: '2026-08-03', fixture: 'completed' });
    completed.onPrimaryAction();

    const rest = loadTodayPage();
    rest.onLoad({ date: '2026-08-09' });
    rest.onPrimaryAction();

    assert.deepEqual(calls, [
      ['navigateTo', '/pages/workout/index?planId=plan_20260803_builtin'],
      ['navigateTo', '/pages/workout/index?sessionId=session_today_fixture'],
      ['switchTab', '/pages/record/index']
    ]);
  });
});

test('Today page keeps business and storage logic outside page.js', () => {
  const source = read('miniprogram/pages/today/index.js');

  assert.match(source, /application\/today-plan-runtime/);
  assert.doesNotMatch(source, /wx\.(?:get|set|remove)StorageSync/);
  assert.doesNotMatch(source, /completionRate|findByDate|activeSession/);
});

test('Today page declares workout and safety components with all visible states', () => {
  const pageJson = JSON.parse(read('miniprogram/pages/today/index.json'));
  const wxml = read('miniprogram/pages/today/index.wxml');

  assert.deepEqual(pageJson.usingComponents, {
    'workout-card': '/components/workout-card/index',
    'safety-notice': '/components/safety-notice/index'
  });
  assert.match(wxml, /<workout-card/);
  assert.match(wxml, /<safety-notice/);
  assert.match(wxml, /view\.state === 'empty'/);
  assert.match(wxml, /view\.state === 'completed'/);
  assert.match(wxml, /view\.steps/);
  assert.match(wxml, /bindtap="onPrimaryAction"/);
});

test('Today primary action is thumb-reachable and reserves Android safe-area space', () => {
  const appStyles = read('miniprogram/app.wxss');
  const pageStyles = read('miniprogram/pages/today/index.wxss');

  assert.match(appStyles, /--safe-area-bottom:\s*env\(safe-area-inset-bottom\)/);
  assert.match(pageStyles, /\.today-action-dock[\s\S]*position:\s*fixed/);
  assert.match(pageStyles, /bottom:\s*0/);
  assert.match(pageStyles, /env\(safe-area-inset-bottom\)/);
  assert.match(pageStyles, /min-height:\s*96rpx/);
  assert.match(pageStyles, /padding-bottom:\s*calc\(/);
});

test('developer fixtures are anonymous, date-selectable read models and never persist test state', () => {
  const runtimeSource = read('miniprogram/application/today-plan-runtime.js');

  assert.match(runtimeSource, /selectedDate/);
  assert.match(runtimeSource, /fixture === 'completed'/);
  assert.match(runtimeSource, /fixture === 'active'/);
  assert.doesNotMatch(runtimeSource, /database\.commit|setStorageSync/);
  assert.doesNotMatch(runtimeSource, /realName|openId|weightKg|heartRate|medicalHistory/);
});
