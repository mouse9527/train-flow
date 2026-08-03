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
const {
  consumePendingRecordSelection
} = require('../../application/record-navigation-handoff');

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
  commandKeyFactory = defaultCommandKey,
  consumePendingSelection = consumePendingRecordSelection
} = {}) {
  return {
    data: {
      view: null,
      kindLabels: [],
      selectedKindIndex: 0,
      editing: false,
      editDraft: null,
      editRecordIdentity: null,
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
      const pendingRecordId = consumePendingSelection();
      this.refresh(query.recordId || pendingRecordId || null);
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
      if (!this.application) {
        return;
      }
      const pendingRecordId = consumePendingSelection();
      if (pendingRecordId) {
        if (this.data.editing) {
          this.onCancelEdit();
        }
        if (this.data.deleteConfirmation) {
          this.onCancelDelete();
        }
        this.refresh(pendingRecordId);
        return;
      }
      if (this.data.editing || this.data.deleteConfirmation) {
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
      if (this.data.editing) {
        return;
      }
      this.filters.trainingDate = detail.value || null;
      this.refresh(null);
    },

    onClearDateFilter() {
      if (this.data.editing) {
        return;
      }
      this.filters.trainingDate = null;
      this.refresh(null);
    },

    onKindFilterChange({ detail }) {
      if (this.data.editing) {
        return;
      }
      const options = this.data.view ? this.data.view.kindOptions : [];
      const selected = options[Number(detail.value)] || options[0];
      this.filters.kind = selected ? selected.value : null;
      this.refresh(null);
    },

    onSelectRecord({ currentTarget }) {
      if (this.data.editing) {
        return;
      }
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
        editRecordIdentity: {
          recordId: record.id,
          revision: record.revision
        },
        editCommandKey: commandKeyFactory('correct', record.id, record.revision, nowMs),
        editCommandNowMs: nowMs,
        validationError: null
      });
    },

    onCancelEdit() {
      this.setData({
        editing: false,
        editDraft: null,
        editRecordIdentity: null,
        editCommandKey: null,
        editCommandNowMs: null
      });
    },

    onStepValueInput({ currentTarget, detail }) {
      const index = Number(currentTarget.dataset.stepIndex);
      const field = currentTarget.dataset.field;
      const draft = this.data.editDraft;
      const step = draft && draft.steps[index];
      if (!step || !step.editable) {
        return;
      }
      if (!['actualReps', 'actualDurationSeconds'].includes(field)) {
        return;
      }
      this.setData({ [`editDraft.steps[${index}].${field}`]: detail.value });
    },

    onSetValueInput({ currentTarget, detail }) {
      const stepIndex = Number(currentTarget.dataset.stepIndex);
      const setIndex = Number(currentTarget.dataset.setIndex);
      const field = currentTarget.dataset.field;
      const draft = this.data.editDraft;
      const setResult = draft && draft.steps[stepIndex] && draft.steps[stepIndex].sets[setIndex];
      if (!setResult || !['reps', 'weightKg'].includes(field)) {
        return;
      }
      this.setData({
        [`editDraft.steps[${stepIndex}].sets[${setIndex}].${field}`]: detail.value
      });
    },

    onFeedbackInput({ currentTarget, detail }) {
      const field = currentTarget.dataset.field;
      if (!['rpe', 'weightBeforeKg', 'note'].includes(field)) {
        return;
      }
      if (!this.data.editDraft) {
        return;
      }
      this.setData({ [`editDraft.feedback.${field}`]: detail.value });
    },

    onPainChange({ currentTarget, detail }) {
      const field = currentTarget.dataset.field;
      const draft = this.data.editDraft;
      if (!draft || !Object.prototype.hasOwnProperty.call(draft.feedback.pain, field)) {
        return;
      }
      this.setData({
        [`editDraft.feedback.pain.${field}`]: detail.value === true
      });
    },

    onSaveEdit() {
      const identity = this.data.editRecordIdentity;
      if (!identity || !this.data.editDraft) {
        return;
      }
      try {
        this.application.correctRecord({
          recordId: identity.recordId,
          expectedRevision: identity.revision,
          commandKey: this.data.editCommandKey,
          nowMs: this.data.editCommandNowMs,
          draft: this.data.editDraft
        });
        this.setData({
          editing: false,
          editDraft: null,
          editRecordIdentity: null,
          editCommandKey: null,
          editCommandNowMs: null,
          validationError: null
        });
        this.refresh(identity.recordId);
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

const definition = createRecordPageDefinition();
if (typeof Page === 'function') {
  Page(definition);
}

module.exports = {
  createRecordPageDefinition,
  developerFixturesEnabled
};
