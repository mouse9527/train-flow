const {
  createDeveloperRecordApplicationService,
  createRecordApplicationService
} = require('../../application/record-application-service');
const {
  createTrainingRecordRepository
} = require('../../domain/records/training-record-repository');
const {
  createLocalDatabase
} = require('../../services/local-database');

function developerFixturesEnabled(wxApi) {
  if (!wxApi || typeof wxApi.getAccountInfoSync !== 'function') {
    return false;
  }
  try {
    const info = wxApi.getAccountInfoSync();
    return Boolean(info && info.miniProgram && info.miniProgram.envVersion === 'develop');
  } catch (_error) {
    return false;
  }
}

function createProductionApplication() {
  const database = createLocalDatabase();
  return createRecordApplicationService({
    repository: createTrainingRecordRepository({ database })
  });
}

function defaultCommandKey(kind, recordId, revision, nowMs) {
  return JSON.stringify([kind, recordId, revision, nowMs]);
}

function createRecordPageDefinition({
  applicationFactory = createProductionApplication,
  fixtureApplicationFactory = createDeveloperRecordApplicationService,
  getWx = () => wx,
  now = Date.now,
  commandKeyFactory = defaultCommandKey
} = {}) {
  return {
    data: {
      view: null,
      kindLabels: [],
      selectedKindIndex: 0,
      editing: false,
      editDraft: null,
      editCommandKey: null,
      editCommandNowMs: null,
      deleteConfirmation: null,
      validationError: null
    },

    onLoad(query = {}) {
      const wxApi = getWx();
      const useFixture = developerFixturesEnabled(wxApi) && query.fixture === 'worked-sample';
      this.fixtureMode = useFixture;
      this.application = useFixture
        ? fixtureApplicationFactory()
        : applicationFactory();
      this.filters = {
        trainingDate: query.trainingDate || null,
        kind: query.kind || null
      };
      this.refresh(query.recordId || null);
      this.skipNextShowRefresh = true;
      if (useFixture && query.state === 'edit') {
        this.onStartEdit();
      }
      if (useFixture && query.state === 'delete-confirm') {
        this.onRequestDelete();
      }
    },

    onShow() {
      if (this.skipNextShowRefresh) {
        this.skipNextShowRefresh = false;
        return;
      }
      if (!this.application || this.data.editing || this.data.deleteConfirmation) {
        return;
      }
      const selected = this.data.view && this.data.view.selectedRecord;
      this.refresh(selected ? selected.id : null);
    },

    refresh(selectedRecordId = null) {
      try {
        const view = this.application.getView({
          trainingDate: this.filters.trainingDate,
          kind: this.filters.kind,
          selectedRecordId
        });
        const selectedKindIndex = Math.max(
          0,
          view.kindOptions.findIndex(({ value }) => value === view.filters.kind)
        );
        this.setData({
          view,
          kindLabels: view.kindOptions.map(({ label }) => label),
          selectedKindIndex,
          validationError: null
        });
      } catch (error) {
        this.setData({ validationError: error.message || '训练记录加载失败' });
      }
    },

    onDateFilterChange({ detail }) {
      this.filters.trainingDate = detail.value || null;
      this.refresh(null);
    },

    onClearDateFilter() {
      this.filters.trainingDate = null;
      this.refresh(null);
    },

    onKindFilterChange({ detail }) {
      const options = this.data.view ? this.data.view.kindOptions : [];
      const selected = options[Number(detail.value)] || options[0];
      this.filters.kind = selected ? selected.value : null;
      this.refresh(null);
    },

    onSelectRecord({ currentTarget }) {
      const recordId = currentTarget && currentTarget.dataset
        ? currentTarget.dataset.recordId
        : null;
      if (recordId) {
        this.refresh(recordId);
      }
    },

    onStartEdit() {
      const record = this.data.view && this.data.view.selectedRecord;
      if (!record) {
        return;
      }
      const nowMs = now();
      this.setData({
        editing: true,
        editDraft: this.application.createEditDraft(record),
        editCommandKey: commandKeyFactory('correct', record.id, record.revision, nowMs),
        editCommandNowMs: nowMs,
        validationError: null
      });
    },

    onCancelEdit() {
      this.setData({
        editing: false,
        editDraft: null,
        editCommandKey: null,
        editCommandNowMs: null
      });
    },

    onStepValueInput({ currentTarget, detail }) {
      const index = Number(currentTarget.dataset.stepIndex);
      const field = currentTarget.dataset.field;
      const draft = clone(this.data.editDraft);
      if (!draft || !draft.steps[index] || !draft.steps[index].editable) {
        return;
      }
      if (!['actualReps', 'actualDurationSeconds'].includes(field)) {
        return;
      }
      draft.steps[index][field] = detail.value;
      this.setData({ editDraft: draft });
    },

    onSetValueInput({ currentTarget, detail }) {
      const stepIndex = Number(currentTarget.dataset.stepIndex);
      const setIndex = Number(currentTarget.dataset.setIndex);
      const field = currentTarget.dataset.field;
      const draft = clone(this.data.editDraft);
      const setResult = draft && draft.steps[stepIndex] && draft.steps[stepIndex].sets[setIndex];
      if (!setResult || !['reps', 'weightKg'].includes(field)) {
        return;
      }
      setResult[field] = detail.value;
      this.setData({ editDraft: draft });
    },

    onFeedbackInput({ currentTarget, detail }) {
      const field = currentTarget.dataset.field;
      if (!['rpe', 'weightBeforeKg', 'note'].includes(field)) {
        return;
      }
      const draft = clone(this.data.editDraft);
      draft.feedback[field] = detail.value;
      this.setData({ editDraft: draft });
    },

    onPainChange({ currentTarget, detail }) {
      const field = currentTarget.dataset.field;
      const draft = clone(this.data.editDraft);
      if (!draft || !Object.prototype.hasOwnProperty.call(draft.feedback.pain, field)) {
        return;
      }
      draft.feedback.pain[field] = detail.value === true;
      this.setData({ editDraft: draft });
    },

    onSaveEdit() {
      const record = this.data.view && this.data.view.selectedRecord;
      if (!record || !this.data.editDraft) {
        return;
      }
      try {
        this.application.correctRecord({
          recordId: record.id,
          expectedRevision: record.revision,
          commandKey: this.data.editCommandKey,
          nowMs: this.data.editCommandNowMs,
          draft: this.data.editDraft
        });
        this.setData({
          editing: false,
          editDraft: null,
          editCommandKey: null,
          editCommandNowMs: null,
          validationError: null
        });
        this.refresh(record.id);
        const wxApi = getWx();
        if (typeof wxApi.showToast === 'function') {
          wxApi.showToast({ title: '训练记录已更新', icon: 'none' });
        }
      } catch (error) {
        this.setData({ validationError: error.message || '训练记录更新失败' });
      }
    },

    onRequestDelete() {
      const record = this.data.view && this.data.view.selectedRecord;
      if (!record) {
        return;
      }
      const nowMs = now();
      this.deleteCommandIntent = {
        commandKey: commandKeyFactory('delete', record.id, record.revision, nowMs),
        nowMs
      };
      this.setData({
        deleteConfirmation: {
          recordId: record.id,
          revision: record.revision,
          title: record.title
        },
        validationError: null
      });
    },

    onCancelDelete() {
      this.deleteCommandIntent = null;
      this.setData({ deleteConfirmation: null });
    },

    onConfirmDelete() {
      const confirmation = this.data.deleteConfirmation;
      if (!confirmation) {
        return;
      }
      const intent = this.deleteCommandIntent;
      if (!intent) {
        return;
      }
      try {
        this.application.deleteRecord({
          recordId: confirmation.recordId,
          expectedRevision: confirmation.revision,
          commandKey: intent.commandKey,
          nowMs: intent.nowMs
        });
        this.deleteCommandIntent = null;
        this.setData({ deleteConfirmation: null, validationError: null });
        this.refresh(null);
        const wxApi = getWx();
        if (typeof wxApi.showToast === 'function') {
          wxApi.showToast({ title: '训练记录已删除', icon: 'none' });
        }
      } catch (error) {
        this.setData({ validationError: error.message || '训练记录删除失败' });
      }
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const definition = createRecordPageDefinition();
if (typeof Page === 'function') {
  Page(definition);
}

module.exports = {
  createRecordPageDefinition,
  developerFixturesEnabled
};
