const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');

const ROOT = path.join(__dirname, '..', '..');

function createPageHarness(t) {
  const pageModulePath = require.resolve('../../miniprogram/pages/plan/edit/index');
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
    navigateBack() {
      navigations.push('back');
    }
  };
  global.Page = (pageDefinition) => {
    definition = pageDefinition;
  };
  require(pageModulePath);
  assert.ok(definition, 'plan edit page must register through Page()');
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

function event({ value, dataset = {} }) {
  return { detail: { value }, currentTarget: { dataset } };
}

test('editor loads a detached plan with future-session notice and kind-specific view state', (t) => {
  const { page } = createPageHarness(t);
  page.onLoad({ planId: 'plan_20260803_builtin' });

  assert.equal(page.data.draft.trainingDate, '2026-08-03');
  assert.equal(page.data.expectedRevision, 1);
  assert.match(page.data.futureStartNotice, /进行中的训练不变|下次开始/);
  assert.equal(page.data.stepViews[0].showDuration, true);
  assert.equal(page.data.stepViews[0].showSets, false);
  assert.equal(page.data.stepViews[3].showDuration, false);
  assert.equal(page.data.stepViews[3].showSets, true);
  assert.equal(page.data.stepViews[3].showReps, true);
  assert.equal(page.data.stepViews[3].showRest, true);
});

test('editor releases its application session on unload and cannot persist afterward', (t) => {
  const { page, database } = createPageHarness(t);
  page.onLoad({ planId: 'plan_20260803_builtin' });
  const before = database.load();

  page.onUnload();
  page.onPlanTextInput(event({ value: '关闭后修改', dataset: { field: 'title' } }));
  page.onSave();

  assert.equal(page.data.saveState, 'error');
  assert.deepEqual(database.load(), before);
});

test('editor changes fields, adds/deletes/reorders steps and surfaces validation without a partial save', (t) => {
  const { page, database } = createPageHarness(t);
  page.onLoad({ planId: 'plan_20260803_builtin' });
  const before = database.load();
  const firstId = page.data.draft.steps[0].id;
  const secondId = page.data.draft.steps[1].id;

  page.onMoveStep({ currentTarget: { dataset: { stepId: firstId, direction: 'down' } } });
  assert.equal(page.data.draft.steps[0].id, secondId);
  page.onAddKindChange(event({ value: 1 }));
  page.onAddStep();
  const added = page.data.draft.steps.at(-1);
  assert.equal(added.kind, 'strength');
  page.onDeleteStep({ currentTarget: { dataset: { stepId: added.id } } });
  assert.equal(page.data.draft.steps.some(({ id }) => id === added.id), false);

  page.onPlanTextInput(event({ value: '   ', dataset: { field: 'title' } }));
  page.onStepNumberInput(event({
    value: '0',
    dataset: { stepId: firstId, field: 'durationSeconds' }
  }));
  page.onSave();

  assert.equal(page.data.saveState, 'error');
  assert.match(page.data.errorSummary, /请检查/);
  assert.match(page.data.planErrors.title, /必填/);
  assert.ok(page.data.stepViews.some(({ errors }) => errors.durationSeconds));
  assert.deepEqual(database.load(), before);
});

test('editor saves nested targets and supports empty-date creation', (t) => {
  const { page, database } = createPageHarness(t);
  page.onLoad({ trainingDate: '2026-08-10' });
  const stepId = page.data.draft.steps[0].id;
  page.onPlanTextInput(event({ value: '新增训练日', dataset: { field: 'title' } }));
  page.onStepNumberInput(event({
    value: '4.5',
    dataset: { stepId, target: 'speedKph', bound: 'min' }
  }));
  page.onStepNumberInput(event({
    value: '5.5',
    dataset: { stepId, target: 'speedKph', bound: 'max' }
  }));
  page.onSave();

  assert.equal(page.data.saveState, 'saved');
  assert.equal(database.load().plans.find(({ trainingDate, status }) => (
    trainingDate === '2026-08-10' && status !== 'deleted'
  )).title, '新增训练日');
});

test('copy-date requires visible confirmation for an existing plan and double confirmation stays single-write', (t) => {
  const { page, database } = createPageHarness(t);
  page.onLoad({ planId: 'plan_20260803_builtin' });
  page.onCopyDateChange(event({ value: '2026-08-04' }));
  const beforeRevision = database.load().localRevision;

  page.onCopyPlan();
  assert.equal(page.data.copyConfirmation.visible, true);
  assert.equal(page.data.copyConfirmation.targetPlanId, 'plan_20260804_builtin');
  assert.equal(page.data.copyConfirmation.targetRevision, 1);
  assert.equal(typeof page.data.copyConfirmation.copyIntentId, 'string');
  assert.ok(page.data.copyConfirmation.copyIntentId.length > 0);
  assert.match(page.data.copyConfirmation.message, /已有计划|替换/);
  assert.equal(database.load().localRevision, beforeRevision);

  page.onConfirmCopy();
  page.onConfirmCopy();
  const activeTargets = database.load().plans.filter(
    ({ trainingDate, status }) => trainingDate === '2026-08-04' && status !== 'deleted'
  );
  assert.equal(page.data.copyState, 'copied');
  assert.equal(activeTargets.length, 1);
  assert.equal(database.load().localRevision, beforeRevision + 1);
});

test('editor markup exposes reorder, delete, kind fields, alternatives, error and copy confirmation controls', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/plan/edit/index.wxml'), 'utf8');

  assert.ok(app.pages.includes('pages/plan/edit/index'));
  assert.match(wxml, /bindtap="onMoveStep"/);
  assert.match(wxml, /data-direction="up"/);
  assert.match(wxml, /data-direction="down"/);
  assert.match(wxml, /bindtap="onDeleteStep"/);
  assert.match(wxml, /showDuration/);
  assert.match(wxml, /showSets/);
  assert.match(wxml, /showReps/);
  assert.match(wxml, /showRest/);
  assert.match(wxml, /speedKph/);
  assert.match(wxml, /inclinePercent/);
  assert.match(wxml, /resistance/);
  assert.match(wxml, /alternatives/);
  assert.match(wxml, /errorSummary/);
  assert.match(wxml, /copyConfirmation\.visible/);
  assert.match(wxml, /bindtap="onConfirmCopy"/);
});
