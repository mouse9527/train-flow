const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createDeveloperStatisticsApplicationService,
  createStatisticsApplicationService
} = require('../../miniprogram/application/statistics-application-service');
const {
  createStatsPageDefinition,
  developerFixturesEnabled
} = require('../../miniprogram/pages/stats/index');

const ROOT = path.join(__dirname, '..', '..');

function clone(value) {
  return structuredClone(value);
}

function mount(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setData(patch) {
      this.data = { ...this.data, ...clone(patch) };
    }
  };
}

function projectionFixture() {
  return {
    schemaVersion: 1,
    range: { startDate: '2026-08-03', endDate: '2026-08-09' },
    builtAt: 1786032000000,
    summary: {
      completedCount: 2,
      plannedCount: 3,
      completionRate: 2 / 3,
      totalActiveSeconds: 3000,
      treadmillSeconds: 600,
      treadmillEstimated: true,
      rowingSeconds: 420,
      rowingEstimated: false,
      strengthCount: 2,
      streakDays: 2
    },
    latestStrength: {
      chest: { valueKg: 12, trainingDate: '2026-08-03' },
      back: null
    },
    latestBodyWeight: { valueKg: 80.5, trainingDate: '2026-08-03' },
    recent: {
      duration: [
        { trainingDate: '2026-08-03', value: 1800 },
        { trainingDate: '2026-08-05', value: 1200 }
      ],
      rpe: [
        { trainingDate: '2026-08-03', value: 7 },
        { trainingDate: '2026-08-05', value: null }
      ],
      weight: [
        { trainingDate: '2026-08-03', value: 80.5 },
        { trainingDate: '2026-08-05', value: null }
      ]
    }
  };
}

test('statistics application maps seconds and nullable facts into honest labels and CSS trend points', () => {
  const calls = [];
  const service = {
    getProjection(range) {
      calls.push(clone(range));
      return projectionFixture();
    }
  };
  const application = createStatisticsApplicationService({ service });

  const view = application.getView('2026-08-05');

  assert.deepEqual(calls, [{ startDate: '2026-08-03', endDate: '2026-08-09' }]);
  assert.equal(view.week.rangeLabel, '08月03日 - 08月09日');
  assert.equal(view.week.completionRateLabel, '67%');
  assert.equal(view.week.completionCountLabel, '2 / 3 次');
  assert.equal(view.metrics.activeMinutes.valueLabel, '50');
  assert.equal(view.metrics.treadmillMinutes.valueLabel, '约 10');
  assert.equal(view.metrics.rowingMinutes.valueLabel, '7');
  assert.equal(view.metrics.strengthCount.valueLabel, '2');
  assert.equal(view.metrics.streak.valueLabel, '2');
  assert.deepEqual(view.latestStrength.chest, {
    valueLabel: '12 kg',
    dateLabel: '08月03日'
  });
  assert.deepEqual(view.latestStrength.back, {
    valueLabel: '未记录',
    dateLabel: ''
  });
  assert.equal(view.latestBodyWeight.valueLabel, '80.5 kg');
  assert.deepEqual(
    view.trends.find(({ key }) => key === 'rpe').points.map(({ valueLabel, known }) => ({
      valueLabel,
      known
    })),
    [{ valueLabel: '7', known: true }, { valueLabel: '未记录', known: false }]
  );
  assert.equal(view.emptyState, null);
});

test('zero planned workouts render an explicit empty state and never display a misleading 0%', () => {
  const application = createStatisticsApplicationService({
    service: {
      getProjection() {
        const projection = projectionFixture();
        projection.summary.plannedCount = 0;
        projection.summary.completedCount = 0;
        projection.summary.completionRate = null;
        projection.recent = { duration: [], rpe: [], weight: [] };
        projection.latestStrength = { chest: null, back: null };
        projection.latestBodyWeight = null;
        return projection;
      }
    }
  });

  const view = application.getView('2026-08-09');

  assert.equal(view.week.completionRateLabel, '—');
  assert.match(view.emptyState.title, /本周还没有训练安排/);
  assert.match(view.emptyState.guidance, /完成率/);
  assert.equal(JSON.stringify(view).includes('0%'), false);
});

test('stats page only enables fixed developer fixtures in develop and refreshes production on later shows', () => {
  const productionCalls = [];
  const production = { getView: (date) => (productionCalls.push(date), { source: 'production' }) };
  const fixtureCalls = [];
  const fixture = { getView: (date) => (fixtureCalls.push(date), { source: 'fixture' }) };
  const releaseWx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }) };
  const developWx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }) };

  assert.equal(developerFixturesEnabled(releaseWx), false);
  assert.equal(developerFixturesEnabled(developWx), true);

  const releasePage = mount(createStatsPageDefinition({
    applicationFactory: () => production,
    fixtureApplicationFactory: () => fixture,
    getWx: () => releaseWx,
    currentDate: () => '2026-08-05'
  }));
  releasePage.onLoad({ fixture: 'worked-sample', state: 'populated', date: '1999-01-01' });
  assert.equal(releasePage.data.view.source, 'production');
  assert.deepEqual(productionCalls, ['2026-08-05']);
  releasePage.onShow();
  assert.deepEqual(productionCalls, ['2026-08-05']);
  releasePage.onShow();
  assert.deepEqual(productionCalls, ['2026-08-05', '2026-08-05']);

  const developPage = mount(createStatsPageDefinition({
    applicationFactory: () => production,
    fixtureApplicationFactory(state) {
      fixtureCalls.push(state);
      return fixture;
    },
    getWx: () => developWx,
    currentDate: () => '2026-08-05'
  }));
  developPage.onLoad({ fixture: 'worked-sample', state: 'empty', date: '2026-08-09' });
  assert.equal(developPage.data.view.source, 'fixture');
  assert.deepEqual(fixtureCalls, ['empty', '2026-08-09']);

  const blockedPage = mount(createStatsPageDefinition({
    applicationFactory: () => production,
    fixtureApplicationFactory: () => fixture,
    getWx: () => developWx,
    currentDate: () => '2026-08-05'
  }));
  blockedPage.onLoad({ fixture: 'arbitrary', state: 'populated', date: '1999-01-01' });
  assert.equal(blockedPage.data.view.source, 'production');
});

test('developer fixture application exposes populated and empty real views without personal data', () => {
  const populated = createDeveloperStatisticsApplicationService('populated').getView('2026-08-05');
  const empty = createDeveloperStatisticsApplicationService('empty').getView('2026-08-09');

  assert.equal(populated.emptyState, null);
  assert.equal(populated.week.completionRateLabel, '67%');
  assert.match(populated.metrics.treadmillMinutes.valueLabel, /10/);
  assert.match(empty.emptyState.title, /没有训练安排/);
  assert.doesNotMatch(JSON.stringify({ populated, empty }), /openId|AppSecret|真实姓名|手机号/);
});

test('stats deliverable uses CSS-only lightweight charts with labels, units and non-diagnostic copy', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/stats/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/stats/index.wxss'), 'utf8');
  const recordWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/record/index.wxml'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(wxml, /完成率/);
  assert.match(wxml, /跑步机/);
  assert.match(wxml, /划船/);
  assert.match(wxml, /最近趋势/);
  assert.match(wxml, /仅用于回顾训练记录，不用于诊断/);
  assert.match(wxml, /style="height: \{\{point\.barPercent\}\}%"/);
  assert.match(wxss, /\.trend-bar__fill/);
  assert.doesNotMatch(wxml, /<canvas/i);
  assert.match(recordWxml, /url="\/pages\/stats\/index"/);
  assert.match(readme, /pages\/stats\/index\?fixture=worked-sample&state=populated/);
  assert.match(readme, /state=empty/);
  assert.deepEqual(packageJson.dependencies || {}, {});
});
