const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');

const ROOT = path.join(__dirname, '..', '..');
const FIXED_NOW = 1785717300000;

function canonicalPageRecord({ id, status, stepResults = [], pain = {} }) {
  return {
    schemaVersion: 1,
    id,
    sourceSessionId: `session_${id}`,
    trainingDate: '2026-08-03',
    startedAt: FIXED_NOW,
    endedAt: FIXED_NOW + 1_000,
    elapsedActiveSeconds: 1,
    status,
    planSnapshot: { timezone: 'Asia/Shanghai' },
    stepResults,
    feedback: {
      rpe: 5,
      weightBeforeKg: null,
      pain,
      note: ''
    },
    createdAt: FIXED_NOW + 1_000,
    updatedAt: FIXED_NOW + 1_000,
    revision: 1
  };
}

function createPageHarness(t) {
  const pageModulePath = require.resolve('../../miniprogram/pages/plan/index');
  delete require.cache[pageModulePath];

  const values = new Map();
  const navigations = [];
  const originalPage = global.Page;
  const originalWx = global.wx;
  let definition = null;

  global.wx = {
    getStorageSync(key) {
      return values.has(key) ? structuredClone(values.get(key)) : undefined;
    },
    getStorageInfoSync() {
      return { keys: [...values.keys()] };
    },
    setStorageSync(key, value) {
      values.set(key, structuredClone(value));
    },
    removeStorageSync(key) {
      values.delete(key);
    },
    navigateTo({ url }) {
      navigations.push(url);
    }
  };
  global.Page = (pageDefinition) => {
    definition = pageDefinition;
  };

  require(pageModulePath);
  assert.ok(definition, 'plan page must register through Page()');

  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch) {
      this.data = { ...this.data, ...structuredClone(patch) };
    }
  };

  t.after(() => {
    delete require.cache[pageModulePath];
    if (originalPage === undefined) delete global.Page;
    else global.Page = originalPage;
    if (originalWx === undefined) delete global.wx;
    else global.wx = originalWx;
  });

  return {
    page,
    navigations,
    database: createLocalDatabase({ now: () => 1785717300000 })
  };
}

test('plan page loads the confirmed seven-day week through the application service', (t) => {
  const source = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/plan/index.js'), 'utf8');
  assert.match(source, /plan-application-service/);
  assert.match(source, /local-record-summary-provider/);
  assert.doesNotMatch(source, /pages\/today|today-application|wx\.getStorageSync|wx\.setStorageSync/);

  const { page, database } = createPageHarness(t);
  database.commit((draft) => {
    draft.records.push(
      canonicalPageRecord({ id: 'record_page_completed', status: 'completed' }),
      canonicalPageRecord({
        id: 'record_page_aborted_skipped',
        status: 'aborted',
        stepResults: [{ stepId: 'step_page_skipped', status: 'skipped' }]
      }),
      canonicalPageRecord({
        id: 'record_page_incomplete_pain',
        status: 'incomplete',
        pain: { knee: true, lowerBack: false, dizziness: false }
      })
    );
  });
  page.onLoad({});

  assert.equal(page.data.week.weekStart, '2026-08-03');
  assert.equal(page.data.week.weekEnd, '2026-08-09');
  assert.equal(page.data.week.days.length, 7);
  assert.equal(page.data.week.days[0].weekday, '周一');
  assert.equal(page.data.week.days[6].weekday, '周日');
  assert.equal(page.data.week.selectedDay.trainingDate, '2026-08-03');
  assert.equal(page.data.week.days[0].completionLabel, '已完成');
  assert.equal(page.data.week.days[0].skippedLabel, '有跳过');
  assert.equal(page.data.week.days[0].discomfortLabel, '有不适');
});

test('plan page navigates to an empty adjacent week without cloning the initial plan', (t) => {
  const { page } = createPageHarness(t);
  page.onLoad({});

  page.onNextWeek();
  assert.equal(page.data.week.weekStart, '2026-08-10');
  assert.equal(page.data.week.isEmpty, true);
  assert.equal(page.data.week.days.length, 0);
  assert.equal(page.data.week.emptyMessage, '这一周还没有训练计划');
  assert.equal(page.data.week.emptyGuidance, '可使用上方按钮切换到有训练安排的周');

  page.onPreviousWeek();
  assert.equal(page.data.week.weekStart, '2026-08-03');
  assert.equal(page.data.week.days.length, 7);
});

test('plan page selects any day and exposes ordered kind-specific detail', (t) => {
  const { page } = createPageHarness(t);
  page.onLoad({});
  page.onSelectDay({ currentTarget: { dataset: { date: '2026-08-06' } } });

  const selected = page.data.week.selectedDay;
  assert.equal(selected.trainingDate, '2026-08-06');
  assert.equal(selected.title, '划船入门与基础力量');
  assert.deepEqual(selected.steps.map(({ order }) => order), [10, 20, 30, 40, 50, 60, 70]);
  assert.ok(selected.steps.some(({ kind }) => kind === 'interval'));
  assert.ok(selected.steps.some(({ metrics }) => metrics.some(({ label }) => label === '组间休息')));
  assert.ok(selected.steps.some(({ targets }) => targets.some(({ label }) => label === '阻力')));
  assert.ok(selected.safetyNotices.length > 0);
});

test('Sunday renders rest guidance and cannot launch a workout', (t) => {
  const { page, navigations } = createPageHarness(t);
  page.onLoad({});
  page.onSelectDay({ currentTarget: { dataset: { date: '2026-08-09' } } });

  assert.equal(page.data.week.selectedDay.isRestDay, true);
  assert.equal(page.data.week.selectedDay.totalDurationLabel, null);
  assert.equal(page.data.week.selectedDay.canStartWorkout, false);
  assert.match(page.data.week.selectedDay.restGuidance, /不补练|恢复|正常生活/);
  page.onStartWorkout();
  assert.deepEqual(navigations, []);
});

test('plan WXML binds week navigation, seven-day selection, statuses, detail and conditional start action', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/plan/index.wxml'), 'utf8');
  const dayLoopTag = wxml.match(/<view\b(?=[^>]*wx:for="\{\{week\.days\}\}")[^>]*>/s);

  assert.match(wxml, /bindtap="onPreviousWeek"/);
  assert.match(wxml, /bindtap="onNextWeek"/);
  assert.ok(dayLoopTag, 'week day loop must be declared on one view tag');
  assert.match(dayLoopTag[0], /wx:for-item="day"/);
  assert.match(dayLoopTag[0], /data-date="\{\{day\.trainingDate\}\}"/);
  assert.match(dayLoopTag[0], /bindtap="onSelectDay"/);
  assert.match(wxml, /completionLabel/);
  assert.match(wxml, /skippedLabel/);
  assert.match(wxml, /discomfortLabel/);
  assert.match(wxml, /selectedDay\.steps/);
  assert.match(wxml, /step\.metrics/);
  assert.match(wxml, /step\.targets/);
  assert.match(wxml, /safetyNotices/);
  assert.match(wxml, /wx:if="\{\{week\.selectedDay\.canStartWorkout\}\}"[^>]*bindtap="onStartWorkout"/);
  assert.match(wxml, /\{\{week\.emptyMessage\}\}/);
  assert.match(wxml, /\{\{week\.emptyGuidance\}\}/);
  assert.doesNotMatch(wxml, /返回上一周/);
});
