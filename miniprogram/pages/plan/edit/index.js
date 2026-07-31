const {
  createPlanApplicationService
} = require('../../../application/plan-application-service');
const {
  moveDraftStep,
  updateDraftStep
} = require('../../../domain/planning/plan-editor');
const {
  createPlanRepository
} = require('../../../domain/planning/plan-repository');
const {
  createLocalDatabase
} = require('../../../services/local-database');

const STEP_KINDS = Object.freeze(['timed', 'strength', 'interval', 'manual', 'rest_day']);
const STEP_KIND_LABELS = Object.freeze(['计时', '力量', '间歇', '手动', '休息日']);
const database = createLocalDatabase();
const application = createPlanApplicationService({
  repository: createPlanRepository({ database })
});

function numericInput(value) {
  if (value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function targetValue(step, target, bound) {
  const range = step.targets[target];
  if (!range || range[bound] === null || range[bound] === undefined) {
    return '';
  }
  return range[bound];
}

function stepView(step, index, fieldErrors) {
  const error = (field) => fieldErrors[`plan.steps[${index}].${field}`] || '';
  return {
    ...step,
    position: index + 1,
    canMoveUp: index > 0,
    showDuration: step.kind === 'timed' || step.kind === 'interval',
    showSets: step.kind === 'strength' || step.kind === 'interval' || step.kind === 'manual',
    showReps: step.kind === 'strength' || step.kind === 'manual',
    showRest: step.kind === 'strength' || step.kind === 'interval',
    showTargets: step.kind !== 'rest_day',
    alternativeText: step.alternatives.join('，'),
    speedMin: targetValue(step, 'speedKph', 'min'),
    speedMax: targetValue(step, 'speedKph', 'max'),
    inclineMin: targetValue(step, 'inclinePercent', 'min'),
    inclineMax: targetValue(step, 'inclinePercent', 'max'),
    resistanceMin: targetValue(step, 'resistance', 'min'),
    resistanceMax: targetValue(step, 'resistance', 'max'),
    errors: {
      name: error('name'),
      durationSeconds: error('durationSeconds'),
      sets: error('sets'),
      reps: error('reps'),
      restSeconds: error('restSeconds'),
      speedKph: error('targets.speedKph'),
      inclinePercent: error('targets.inclinePercent'),
      resistance: error('targets.resistance')
    }
  };
}

Page({
  data: {
    draft: null,
    editorSessionId: null,
    stepViews: [],
    expectedRevision: 0,
    isNew: false,
    futureStartNotice: '',
    fieldErrors: {},
    planErrors: {},
    saveState: 'idle',
    saveMessage: '',
    errorSummary: '',
    stepKinds: STEP_KINDS,
    stepKindLabels: STEP_KIND_LABELS,
    addKindIndex: 0,
    copyDate: '2026-08-10',
    copyState: 'idle',
    copyMessage: '',
    copyConfirmation: {
      visible: false,
      targetRevision: null,
      message: ''
    }
  },

  onLoad(query = {}) {
    application.initializeDefaultPlans();
    const editor = application.openPlanEditor({
      planId: query.planId || null,
      trainingDate: query.trainingDate || null
    });
    this.setData({
      draft: editor.draft,
      editorSessionId: editor.editorSessionId,
      expectedRevision: editor.expectedRevision,
      isNew: editor.isNew,
      futureStartNotice: editor.futureStartNotice,
      copyDate: editor.draft.trainingDate === '2026-08-10' ? '2026-08-11' : '2026-08-10'
    });
    this.refreshViews();
  },

  onUnload() {
    if (this.data.editorSessionId) {
      application.closePlanEditor(this.data.editorSessionId);
    }
  },

  refreshViews(fieldErrors = this.data.fieldErrors) {
    const draft = this.data.draft;
    this.setData({
      fieldErrors,
      planErrors: {
        title: fieldErrors['plan.title'] || '',
        trainingDate: fieldErrors['plan.trainingDate'] || '',
        revision: fieldErrors['plan.revision'] || '',
        steps: fieldErrors['plan.steps'] || ''
      },
      stepViews: draft ? draft.steps.map((step, index) => stepView(step, index, fieldErrors)) : []
    });
  },

  onPlanTextInput(event) {
    this.data.draft[event.currentTarget.dataset.field] = event.detail.value;
    this.setData({ draft: this.data.draft, saveState: 'idle', errorSummary: '' });
    this.refreshViews({});
  },

  onStepTextInput(event) {
    const { stepId, field } = event.currentTarget.dataset;
    const value = field === 'alternatives'
      ? event.detail.value.split(/[，,]/).map((entry) => entry.trim()).filter(Boolean)
      : event.detail.value;
    updateDraftStep(this.data.draft, stepId, { [field]: value });
    this.setData({ draft: this.data.draft, saveState: 'idle', errorSummary: '' });
    this.refreshViews({});
  },

  onStepNumberInput(event) {
    const { stepId, field, target, bound } = event.currentTarget.dataset;
    const value = numericInput(event.detail.value);
    const step = this.data.draft.steps.find(({ id }) => id === stepId);
    if (target) {
      const targets = JSON.parse(JSON.stringify(step.targets));
      const range = targets[target] && typeof targets[target] === 'object'
        ? targets[target]
        : { min: null, max: null };
      range[bound] = value;
      targets[target] = range.min === null && range.max === null ? null : range;
      updateDraftStep(this.data.draft, stepId, { targets });
    } else {
      updateDraftStep(this.data.draft, stepId, { [field]: value });
    }
    this.setData({ draft: this.data.draft, saveState: 'idle', errorSummary: '' });
    this.refreshViews({});
  },

  onStepOptionalChange(event) {
    updateDraftStep(this.data.draft, event.currentTarget.dataset.stepId, {
      optional: Boolean(event.detail.value)
    });
    this.setData({ draft: this.data.draft, saveState: 'idle' });
    this.refreshViews({});
  },

  onMoveStep(event) {
    moveDraftStep(
      this.data.draft,
      event.currentTarget.dataset.stepId,
      event.currentTarget.dataset.direction
    );
    this.setData({ draft: this.data.draft, saveState: 'idle' });
    this.refreshViews({});
  },

  onDeleteStep(event) {
    application.removePlanDraftStep({
      editorSessionId: this.data.editorSessionId,
      draft: this.data.draft,
      stepId: event.currentTarget.dataset.stepId
    });
    this.setData({ draft: this.data.draft, saveState: 'idle' });
    this.refreshViews({});
  },

  onAddKindChange(event) {
    this.setData({ addKindIndex: Number(event.detail.value) });
  },

  onAddStep() {
    const kind = STEP_KINDS[this.data.addKindIndex];
    application.addPlanDraftStep({
      editorSessionId: this.data.editorSessionId,
      draft: this.data.draft,
      kind,
      name: STEP_KIND_LABELS[this.data.addKindIndex] + '步骤'
    });
    this.setData({ draft: this.data.draft, saveState: 'idle' });
    this.refreshViews({});
  },

  onSave() {
    const result = application.savePlanDraft({
      editorSessionId: this.data.editorSessionId,
      draft: this.data.draft,
      expectedRevision: this.data.expectedRevision
    });
    if (!result.ok) {
      this.setData({
        saveState: 'error',
        saveMessage: '',
        errorSummary: '保存失败，请检查标红字段后重试。'
      });
      this.refreshViews(result.fieldErrors);
      return;
    }
    this.setData({
      draft: result.plan,
      expectedRevision: result.plan.revision,
      isNew: false,
      saveState: 'saved',
      saveMessage: '计划已保存，修改会在下次开始训练时生效。',
      errorSummary: ''
    });
    this.refreshViews({});
  },

  onCopyDateChange(event) {
    this.setData({ copyDate: event.detail.value, copyState: 'idle', copyMessage: '' });
  },

  copyCommand(confirmReplace, expectedTargetRevision) {
    return application.copyPlanToDate({
      sourcePlanId: this.data.draft.id,
      targetDate: this.data.copyDate,
      commandKey: `copy:${this.data.draft.id}:${this.data.copyDate}`,
      confirmReplace,
      expectedTargetRevision
    });
  },

  onCopyPlan() {
    if (this.data.isNew) {
      this.setData({ copyState: 'error', copyMessage: '请先保存新计划，再复制到其他日期。' });
      return;
    }
    const result = this.copyCommand(false, null);
    if (result.code === 'PLAN_REPLACE_CONFIRMATION_REQUIRED') {
      this.setData({
        copyState: 'confirming',
        copyConfirmation: {
          visible: true,
          targetRevision: result.targetRevision,
          message: `${this.data.copyDate} 已有计划。确认后将以当前计划的深复制版本替换它。`
        }
      });
      return;
    }
    this.finishCopy(result);
  },

  onConfirmCopy() {
    if (!this.data.copyConfirmation.visible) {
      return;
    }
    const result = this.copyCommand(true, this.data.copyConfirmation.targetRevision);
    this.setData({
      copyConfirmation: { visible: false, targetRevision: null, message: '' }
    });
    this.finishCopy(result);
  },

  onCancelCopy() {
    this.setData({
      copyState: 'idle',
      copyConfirmation: { visible: false, targetRevision: null, message: '' }
    });
  },

  finishCopy(result) {
    if (result.ok) {
      this.setData({
        copyState: 'copied',
        copyMessage: result.replayed ? '该日期已完成同一次复制。' : `已复制到 ${result.plan.trainingDate}。`
      });
      return;
    }
    this.setData({
      copyState: 'error',
      copyMessage: result.fieldErrors && (
        result.fieldErrors['plan.revision'] || result.fieldErrors['plan.trainingDate']
      )
        ? result.fieldErrors['plan.revision'] || result.fieldErrors['plan.trainingDate']
        : '复制失败，请稍后重试。'
    });
  }
});
