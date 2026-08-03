const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRecordPageDefinition,
  developerFixturesEnabled
} = require('../../miniprogram/pages/record/index');

const ROOT = path.join(__dirname, '..', '..');

function clone(value) {
  return structuredClone(value);
}

function assignDataPath(target, pathExpression, value) {
  const parts = pathExpression
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current = current[part];
  }
  current[parts.at(-1)] = clone(value);
}

function mount(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setDataCalls: [],
    setData(patch) {
      this.setDataCalls.push(clone(patch));
      for (const [pathExpression, value] of Object.entries(patch)) {
        if (pathExpression.includes('.') || pathExpression.includes('[')) {
          assignDataPath(this.data, pathExpression, value);
        } else {
          this.data[pathExpression] = clone(value);
        }
      }
    }
  };
}

function viewFixture() {
  return {
    filters: { trainingDate: null, kind: null },
    kindOptions: [
      { value: null, label: '全部类型' },
      { value: 'manual', label: '次数' },
      { value: 'timed', label: '计时' },
      { value: 'interval', label: '间歇' },
      { value: 'strength', label: '力量' }
    ],
    records: [{
      id: 'record_page_fixture',
      trainingDate: '2026-08-03',
      title: '全身基础训练',
      statusLabel: '已中止',
      progressLabel: '1 完成 · 1 跳过 · 1 未执行',
      durationLabel: '15:25',
      kindLabel: '次数 / 计时 / 力量',
      hasPain: true,
      selected: true
    }],
    selectedRecord: {
      id: 'record_page_fixture',
      revision: 4,
      trainingDate: '2026-08-03',
      title: '全身基础训练',
      statusLabel: '已中止',
      durationLabel: '15:25',
      feedback: {
        rpe: 7,
        weightBeforeKg: 81.5,
        pain: { knee: true, lowerBack: false, ankleOrToe: false, dizziness: false },
        note: '匿名展示备注'
      },
      steps: [
        { stepId: 'step_manual', name: '深蹲', kind: 'manual', kindLabel: '次数', status: 'completed', statusLabel: '已完成', actualLabel: '12 次', editable: true, actualReps: 12, sets: [] },
        { stepId: 'step_timed', name: '平板支撑', kind: 'timed', kindLabel: '计时', status: 'skipped', statusLabel: '已跳过', actualLabel: '未记录', editable: false, actualDurationSeconds: null, sets: [] },
        { stepId: 'step_strength', name: '哑铃划船', kind: 'strength', kindLabel: '力量', status: 'unknown', statusLabel: '未执行', actualLabel: '未记录', editable: false, sets: [] }
      ]
    },
    emptyState: null
  };
}

function applicationDouble() {
  const calls = { getView: [], correctRecord: [], deleteRecord: [] };
  let view = viewFixture();
  return {
    calls,
    getView(input) {
      calls.getView.push(clone(input));
      view = clone(view);
      view.filters = { trainingDate: input.trainingDate, kind: input.kind };
      view.records = view.records.map((record) => ({
        ...record,
        selected: record.id === (input.selectedRecordId || record.id)
      }));
      return clone(view);
    },
    createEditDraft(record) {
      return {
        steps: clone(record.steps),
        feedback: clone(record.feedback)
      };
    },
    correctRecord(input) {
      calls.correctRecord.push(clone(input));
      view.selectedRecord = {
        ...view.selectedRecord,
        revision: view.selectedRecord.revision + 1,
        feedback: clone(input.draft.feedback)
      };
      return clone(view.selectedRecord);
    },
    deleteRecord(input) {
      calls.deleteRecord.push(clone(input));
      view = {
        ...view,
        records: [],
        selectedRecord: null,
        emptyState: { title: '还没有训练记录', guidance: '完成一次训练后会显示在这里' }
      };
      return { deletedAt: input.nowMs };
    }
  };
}

function wxDouble(envVersion = 'release') {
  const toasts = [];
  return {
    toasts,
    getAccountInfoSync() {
      return { miniProgram: { envVersion } };
    },
    showToast(options) {
      toasts.push(clone(options));
    }
  };
}

test('record page loads list/detail, applies date and kind filters, and preserves selected record on show', () => {
  const application = applicationDouble();
  const page = mount(createRecordPageDefinition({
    applicationFactory: () => application,
    getWx: () => wxDouble('release'),
    now: () => 1785719400000,
    commandKeyFactory: () => 'page-command'
  }));

  page.onLoad({ recordId: 'record_page_fixture' });
  assert.equal(page.data.view.records.length, 1);
  assert.equal(page.data.view.selectedRecord.steps[1].statusLabel, '已跳过');
  assert.equal(page.data.view.selectedRecord.steps[2].statusLabel, '未执行');
  assert.equal(application.calls.getView.length, 1);
  page.onShow();
  assert.equal(
    application.calls.getView.length,
    1,
    'the initial onShow after onLoad must not repeat the first full record query'
  );

  page.onDateFilterChange({ detail: { value: '2026-08-03' } });
  page.onKindFilterChange({ detail: { value: 1 } });
  assert.equal(page.data.view.filters.trainingDate, '2026-08-03');
  assert.equal(page.data.view.filters.kind, 'manual');

  page.onSelectRecord({ currentTarget: { dataset: { recordId: 'record_page_fixture' } } });
  page.onShow();
  assert.equal(application.calls.getView.length, 5);
  assert.equal(application.calls.getView.at(-1).selectedRecordId, 'record_page_fixture');
});

test('record page consumes a pending cross-tab record selection on first load and later onShow', () => {
  const application = applicationDouble();
  const pendingSelections = ['record_from_today_first', 'record_from_today_later'];
  const page = mount(createRecordPageDefinition({
    applicationFactory: () => application,
    getWx: () => wxDouble('release'),
    consumePendingSelection: () => pendingSelections.shift() || null
  }));

  page.onLoad({});
  assert.equal(
    application.calls.getView[0].selectedRecordId,
    'record_from_today_first'
  );
  page.onShow();
  assert.equal(application.calls.getView.length, 1);

  page.onShow();
  assert.equal(
    application.calls.getView.at(-1).selectedRecordId,
    'record_from_today_later'
  );
});

test('record page consumes a pending cross-tab selection by closing preserved edit or delete state', () => {
  for (const modalState of ['edit', 'delete']) {
    const application = applicationDouble();
    let pendingSelection = null;
    const page = mount(createRecordPageDefinition({
      applicationFactory: () => application,
      getWx: () => wxDouble('release'),
      consumePendingSelection() {
        const selected = pendingSelection;
        pendingSelection = null;
        return selected;
      }
    }));

    page.onLoad({});
    page.onShow();
    page.onDateFilterChange({ detail: { value: '2026-08-03' } });
    page.onKindFilterChange({ detail: { value: 1 } });
    if (modalState === 'edit') {
      page.onStartEdit();
    } else {
      page.onRequestDelete();
    }
    pendingSelection = `record_from_today_with_${modalState}`;

    page.onShow();

    assert.equal(page.data.editing, false, `${modalState} must not block the handoff`);
    assert.equal(page.data.editDraft, null);
    assert.equal(page.data.editRecordIdentity, null);
    assert.equal(page.data.deleteConfirmation, null);
    assert.equal(page.deleteCommandIntent ?? null, null);
    assert.equal(
      application.calls.getView.at(-1).selectedRecordId,
      `record_from_today_with_${modalState}`
    );
    assert.deepEqual(page.filters, { trainingDate: null, kind: null });
    assert.equal(application.calls.getView.at(-1).trainingDate, null);
    assert.equal(application.calls.getView.at(-1).kind, null);
    assert.equal(application.calls.correctRecord.length, 0);
    assert.equal(application.calls.deleteRecord.length, 0);
  }
});

test('record page edits completed values and feedback, but does not expose inputs for skipped or unknown steps', () => {
  const application = applicationDouble();
  const wxApi = wxDouble('release');
  const times = [1785719400000, 1785719409999];
  const page = mount(createRecordPageDefinition({
    applicationFactory: () => application,
    getWx: () => wxApi,
    now: () => times.shift(),
    commandKeyFactory: () => 'page-edit-command'
  }));
  page.onLoad({});
  page.onStartEdit();

  assert.equal(page.data.editing, true);
  assert.equal(page.data.editDraft.steps[0].editable, true);
  assert.equal(page.data.editDraft.steps[1].editable, false);
  let updateIndex = page.setDataCalls.length;
  page.onStepValueInput({
    currentTarget: { dataset: { stepIndex: 0, field: 'actualReps' } },
    detail: { value: '15' }
  });
  assert.deepEqual(page.setDataCalls[updateIndex], {
    'editDraft.steps[0].actualReps': '15'
  });
  updateIndex = page.setDataCalls.length;
  page.onFeedbackInput({ currentTarget: { dataset: { field: 'rpe' } }, detail: { value: '8' } });
  assert.deepEqual(page.setDataCalls[updateIndex], {
    'editDraft.feedback.rpe': '8'
  });
  updateIndex = page.setDataCalls.length;
  page.onPainChange({ currentTarget: { dataset: { field: 'lowerBack' } }, detail: { value: true } });
  assert.deepEqual(page.setDataCalls[updateIndex], {
    'editDraft.feedback.pain.lowerBack': true
  });
  page.onFeedbackInput({ currentTarget: { dataset: { field: 'note' } }, detail: { value: '更新备注' } });
  page.onSaveEdit();

  assert.equal(application.calls.correctRecord.length, 1);
  assert.equal(application.calls.correctRecord[0].expectedRevision, 4);
  assert.equal(application.calls.correctRecord[0].commandKey, 'page-edit-command');
  assert.equal(
    application.calls.correctRecord[0].nowMs,
    1785719400000,
    'edit retries must keep the command timestamp frozen with its command key'
  );
  assert.equal(application.calls.correctRecord[0].draft.steps[0].actualReps, '15');
  assert.equal(application.calls.correctRecord[0].draft.feedback.rpe, '8');
  assert.equal(application.calls.correctRecord[0].draft.feedback.pain.lowerBack, true);
  assert.equal(page.data.editing, false);
  assert.deepEqual(wxApi.toasts, [{ title: '训练记录已更新', icon: 'none' }]);
});

test('record page binds an edit to the record that opened it and blocks selection drift', () => {
  const application = applicationDouble();
  const page = mount(createRecordPageDefinition({
    applicationFactory: () => application,
    getWx: () => wxDouble('release'),
    now: () => 1785719450000,
    commandKeyFactory: () => 'bound-edit-command'
  }));
  page.onLoad({});
  page.onStartEdit();
  const viewCallsBeforeBlockedNavigation = application.calls.getView.length;

  page.onDateFilterChange({ detail: { value: '2026-08-04' } });
  page.onClearDateFilter();
  page.onKindFilterChange({ detail: { value: 1 } });
  page.onSelectRecord({ currentTarget: { dataset: { recordId: 'record_other' } } });

  assert.equal(application.calls.getView.length, viewCallsBeforeBlockedNavigation);
  assert.deepEqual(page.filters, { trainingDate: null, kind: null });

  page.data.view.selectedRecord = {
    ...page.data.view.selectedRecord,
    id: 'record_other',
    revision: 99,
    title: '其他记录'
  };
  page.onSaveEdit();

  assert.equal(application.calls.correctRecord[0].recordId, 'record_page_fixture');
  assert.equal(application.calls.correctRecord[0].expectedRevision, 4);
  assert.equal(application.calls.getView.at(-1).selectedRecordId, 'record_page_fixture');
  assert.equal(page.data.editRecordIdentity, null);
});

test('record page updates one strength set field without cloning the full edit draft', () => {
  const page = mount(createRecordPageDefinition({
    applicationFactory: () => applicationDouble(),
    getWx: () => wxDouble('release')
  }));
  page.onLoad({});
  page.onStartEdit();
  page.data.editDraft.steps[0] = {
    ...page.data.editDraft.steps[0],
    kind: 'strength',
    sets: [{ setNumber: 1, reps: 10, weightKg: 20 }]
  };
  const updateIndex = page.setDataCalls.length;

  page.onSetValueInput({
    currentTarget: { dataset: { stepIndex: 0, setIndex: 0, field: 'weightKg' } },
    detail: { value: '22.5' }
  });

  assert.deepEqual(page.setDataCalls[updateIndex], {
    'editDraft.steps[0].sets[0].weightKg': '22.5'
  });
  assert.equal(page.data.editDraft.steps[0].sets[0].weightKg, '22.5');
});

test('record page requires an explicit in-page confirmation before deletion and refreshes to the honest empty state', () => {
  const application = applicationDouble();
  const page = mount(createRecordPageDefinition({
    applicationFactory: () => application,
    getWx: () => wxDouble('release'),
    now: () => 1785719600000,
    commandKeyFactory: (kind) => `${kind}-command`
  }));
  page.onLoad({});

  page.onRequestDelete();
  assert.deepEqual(page.data.deleteConfirmation, {
    recordId: 'record_page_fixture',
    revision: 4,
    title: '全身基础训练'
  });
  assert.equal(application.calls.deleteRecord.length, 0);
  page.onCancelDelete();
  assert.equal(page.data.deleteConfirmation, null);

  page.onRequestDelete();
  page.onConfirmDelete();
  assert.deepEqual(application.calls.deleteRecord, [{
    recordId: 'record_page_fixture',
    expectedRevision: 4,
    commandKey: 'delete-command',
    nowMs: 1785719600000
  }]);
  assert.equal(page.data.deleteConfirmation, null);
  assert.deepEqual(page.data.view.records, []);
  assert.match(page.data.view.emptyState.title, /没有训练记录/);
});

test('developer visual fixtures are develop-only, anonymous and can open list, edit and delete-confirm states', () => {
  assert.equal(developerFixturesEnabled(wxDouble('develop')), true);
  assert.equal(developerFixturesEnabled(wxDouble('release')), false);
  assert.equal(developerFixturesEnabled({}), false);

  const fixtureApplication = applicationDouble();
  const page = mount(createRecordPageDefinition({
    applicationFactory() {
      throw new Error('release application must not be used for develop fixture');
    },
    fixtureApplicationFactory: () => fixtureApplication,
    getWx: () => wxDouble('develop'),
    commandKeyFactory: () => 'fixture-command'
  }));
  page.onLoad({ fixture: 'worked-sample', state: 'delete-confirm' });
  assert.equal(page.data.view.records[0].id, 'record_page_fixture');
  assert.doesNotMatch(JSON.stringify(page.data.view), /mouse9527|PRIVATE_|@|token|secret/i);
  assert.equal(page.data.deleteConfirmation.recordId, 'record_page_fixture');

  const releaseApplication = applicationDouble();
  const releasePage = mount(createRecordPageDefinition({
    applicationFactory: () => releaseApplication,
    fixtureApplicationFactory() {
      throw new Error('release must never use developer fixture');
    },
    getWx: () => wxDouble('release')
  }));
  releasePage.onLoad({ fixture: 'worked-sample', state: 'edit' });
  assert.equal(releaseApplication.calls.getView.length, 1);
  assert.equal(releasePage.data.editing, false, 'release query cannot force fixture-only visual state');
});

test('record WXML binds filters, list/detail actual states, edit inputs and delete confirmation; shell copy is gone', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/record/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/record/index.wxss'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/record/index.js'), 'utf8');

  assert.match(source, /record-application-service/);
  assert.match(source, /training-record-repository/);
  assert.doesNotMatch(source, /getStorageSync|setStorageSync/);
  assert.doesNotMatch(wxml, /训练记录即将上线/);
  assert.match(wxml, /bindchange="onDateFilterChange"/);
  assert.match(wxml, /bindchange="onKindFilterChange"/);
  assert.match(wxml, /bindtap="onSelectRecord"/);
  assert.match(wxml, /selectedRecord\.steps/);
  assert.match(wxml, /statusLabel/);
  assert.match(wxml, /actualLabel/);
  assert.match(wxml, /feedback\.weightBeforeLabel/);
  assert.doesNotMatch(wxml, /feedback\.weightBeforeKg\s*\|\|/);
  assert.match(wxml, /wx:if="\{\{editing\}\}"/);
  assert.match(wxml, /bindtap="onSaveEdit"/);
  assert.match(wxml, /deleteConfirmation/);
  assert.match(wxml, /bindtap="onConfirmDelete"/);
  assert.match(wxss, /record-card-selected/);
  assert.match(wxss, /delete-confirmation/);
  assert.match(wxss, /edit-panel/);
  const loadErrorIndex = wxml.indexOf('record-load-error');
  assert.notEqual(loadErrorIndex, -1, 'WXML must render a dedicated first-load error');
  assert.ok(
    loadErrorIndex < wxml.indexOf('wx:if="{{view}}"'),
    'first-load errors must render outside the view-gated page root'
  );
});

test('record page preserves a visible first-load error when repository view creation fails', () => {
  const page = mount(createRecordPageDefinition({
    applicationFactory: () => ({
      getView() {
        throw new Error('记录存储校验失败');
      }
    }),
    getWx: () => wxDouble('release')
  }));

  page.onLoad({});

  assert.equal(page.data.view, null);
  assert.equal(page.data.validationError, '记录存储校验失败');
});
