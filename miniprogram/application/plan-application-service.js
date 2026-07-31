const {
  DEFAULT_PLAN_TEMPLATE_VERSION
} = require('../data/default-plans');
const {
  createDefaultPlans
} = require('../domain/planning/default-plan-factory');
const {
  DEFAULT_WEEK_START,
  createWeekPlanView
} = require('./week-plan-view');
const {
  addDraftStep,
  createPlanDraft,
  estimateModeledSeconds,
  removeDraftStep,
  validatePlanDraft
} = require('../domain/planning/plan-editor');
const {
  createPlanCopyService
} = require('../domain/planning/plan-copy-service');
const { computeChecksum } = require('../utils/checksum');

const EMPTY_RECORD_SUMMARY_PROVIDER = Object.freeze({
  findRange() {
    return [];
  }
});

class PlanApplicationService {
  constructor({
    repository,
    defaultPlanFactory = createDefaultPlans,
    recordSummaryProvider = EMPTY_RECORD_SUMMARY_PROVIDER,
    now = Date.now,
    idFactory = null
  }) {
    if (!repository || typeof repository.initializeDefaults !== 'function') {
      throw new Error('PlanApplicationService requires a PlanRepository');
    }
    if (typeof defaultPlanFactory !== 'function') {
      throw new Error('defaultPlanFactory must be a function');
    }
    if (!recordSummaryProvider || typeof recordSummaryProvider.findRange !== 'function') {
      throw new Error('recordSummaryProvider must provide findRange()');
    }
    if (typeof now !== 'function' || (idFactory !== null && typeof idFactory !== 'function')) {
      throw new Error('PlanApplicationService requires valid now and idFactory functions');
    }
    let sequence = 0;
    this.repository = repository;
    this.defaultPlanFactory = defaultPlanFactory;
    this.recordSummaryProvider = recordSummaryProvider;
    this.now = now;
    this.idFactory = idFactory || (({ entity }) => `${entity}_${this.now()}_${++sequence}`);
    this.editorSessionSequence = 0;
    this.editorSessions = new Map();
    this.copyIntentSequence = 0;
  }

  initializeDefaultPlans() {
    const plans = this.defaultPlanFactory();
    return this.repository.initializeDefaults(plans, DEFAULT_PLAN_TEMPLATE_VERSION);
  }

  getWeekPlan({
    weekStart = DEFAULT_WEEK_START,
    selectedDate = null
  } = {}) {
    if (typeof this.repository.findRange !== 'function') {
      throw new Error('PlanApplicationService week queries require PlanRepository.findRange');
    }
    const range = createWeekPlanView({ weekStart, plans: [] });
    const plans = this.repository.findRange(range.weekStart, range.weekEnd);
    const recordSummaries = this.recordSummaryProvider.findRange(range.weekStart, range.weekEnd);
    return createWeekPlanView({ weekStart, selectedDate, plans, recordSummaries });
  }

  openPlanEditor({ planId = null, trainingDate = null } = {}) {
    let persisted = null;
    if (planId !== null) {
      persisted = this.repository.findById(planId);
      if (persisted === null) {
        throw new Error(`WorkoutPlan ${planId} is unavailable`);
      }
    } else if (trainingDate !== null) {
      persisted = this.repository.findByDate(trainingDate);
    } else {
      throw new Error('planId or trainingDate is required to open the plan editor');
    }

    const isNew = persisted === null;
    const timestamp = this.now();
    const draft = persisted || {
      schemaVersion: 1,
      id: this.idFactory({ entity: 'plan', purpose: 'editor', trainingDate }),
      trainingDate,
      timezone: 'Asia/Shanghai',
      title: '自定义训练',
      summary: '按当天时间与可用器械调整。',
      estimatedDurationSeconds: 600,
      recommendedEndLocalTime: null,
      safetyNoticeCodes: ['STOP_ON_ALARM_SYMPTOMS'],
      status: 'scheduled',
      steps: [{
        id: this.idFactory({ entity: 'step', purpose: 'editor', trainingDate, index: 0 }),
        order: 10,
        kind: 'timed',
        name: '自定义有氧',
        description: '',
        durationSeconds: 600,
        sets: null,
        reps: null,
        restSeconds: null,
        targets: {},
        optional: false,
        alternatives: [],
        safetyNoticeCodes: []
      }],
      templateSource: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      revision: 1
    };
    const detachedDraft = createPlanDraft(draft);
    const editorSessionId = `editor_session_${++this.editorSessionSequence}`;
    this.editorSessions.set(editorSessionId, {
      planId: detachedDraft.id,
      isNew,
      originalEstimatedDurationSeconds: isNew ? 0 : persisted.estimatedDurationSeconds,
      originalModeledSeconds: isNew ? 0 : estimateModeledSeconds(persisted.steps),
      reservedStepIds: new Set(detachedDraft.steps.map(({ id }) => id)),
      allowedStepIds: new Set(detachedDraft.steps.map(({ id }) => id)),
      removedStepIds: new Set(),
      stepKinds: new Map(detachedDraft.steps.map(({ id, kind }) => [id, kind]))
    });
    return {
      editorSessionId,
      draft: detachedDraft,
      expectedRevision: isNew ? 0 : persisted.revision,
      isNew,
      futureStartNotice: '保存后的修改仅应用于下次开始；进行中的训练保持原计划快照不变。'
    };
  }

  requireEditorSession(editorSessionId, draft) {
    const session = this.editorSessions.get(editorSessionId);
    if (!session || !draft || draft.id !== session.planId) {
      const error = new Error('Plan editor session is missing or does not match this draft');
      error.code = 'PLAN_EDITOR_SESSION_INVALID';
      throw error;
    }
    return session;
  }

  closePlanEditor(editorSessionId) {
    return this.editorSessions.delete(editorSessionId);
  }

  createCopyIntentId({ editorSessionId, draft, targetDate } = {}) {
    this.requireEditorSession(editorSessionId, draft);
    return `copy_intent_${computeChecksum({
      editorSessionId,
      sourcePlanId: draft.id,
      sourceRevision: draft.revision,
      targetDate,
      sequence: ++this.copyIntentSequence
    }).slice(0, 24)}`;
  }

  addPlanDraftStep({ editorSessionId, draft, kind, name }) {
    const session = this.requireEditorSession(editorSessionId, draft);
    const id = this.idFactory({ entity: 'step', purpose: 'editor-add', kind });
    if (session.reservedStepIds.has(id)) {
      const error = new Error(`WorkoutStep ID ${id} was already reserved in this editor session`);
      error.code = 'PLAN_STEP_ID_REUSED';
      throw error;
    }
    const step = addDraftStep(draft, {
      id,
      kind,
      name
    });
    session.reservedStepIds.add(id);
    session.allowedStepIds.add(id);
    session.stepKinds.set(id, kind);
    return step;
  }

  removePlanDraftStep({ editorSessionId, draft, stepId }) {
    const session = this.requireEditorSession(editorSessionId, draft);
    removeDraftStep(draft, stepId);
    session.removedStepIds.add(stepId);
    session.allowedStepIds.delete(stepId);
    return draft;
  }

  validateEditorStepIdentities(editorSessionId, draft) {
    let session;
    try {
      session = this.requireEditorSession(editorSessionId, draft);
    } catch (error) {
      return {
        ok: false,
        code: error.code,
        fieldErrors: { 'plan.steps': '编辑会话已失效，请重新加载计划' }
      };
    }
    for (const step of draft.steps) {
      if (session.removedStepIds.has(step.id)) {
        return {
          ok: false,
          code: 'PLAN_STEP_ID_REUSED',
          fieldErrors: { 'plan.steps': '已删除步骤的身份不能复用，请重新加载后添加新步骤' }
        };
      }
      if (!session.allowedStepIds.has(step.id)) {
        return {
          ok: false,
          code: 'PLAN_STEP_ID_FORGED',
          fieldErrors: { 'plan.steps': '检测到不是由当前编辑会话生成的步骤身份，请重新加载' }
        };
      }
      if (session.stepKinds.get(step.id) !== step.kind) {
        return {
          ok: false,
          code: 'PLAN_STEP_ID_REUSED',
          fieldErrors: { 'plan.steps': '步骤身份不能改作另一种动作类型，请删除后新增步骤' }
        };
      }
    }
    return { ok: true, session };
  }

  recalculateDraftDuration(draft, session) {
    const recalculated = createPlanDraft(draft);
    const modeledSeconds = estimateModeledSeconds(recalculated.steps);
    recalculated.estimatedDurationSeconds = session.isNew
      ? modeledSeconds
      : Math.max(
        0,
        session.originalEstimatedDurationSeconds + modeledSeconds - session.originalModeledSeconds
      );
    return recalculated;
  }

  savePlanDraft({ editorSessionId, draft, expectedRevision } = {}) {
    const identities = this.validateEditorStepIdentities(editorSessionId, draft);
    if (!identities.ok) {
      return identities;
    }
    const recalculated = this.recalculateDraftDuration(draft, identities.session);
    const validation = validatePlanDraft(recalculated);
    if (!validation.valid) {
      return {
        ok: false,
        code: 'PLAN_VALIDATION_FAILED',
        fieldErrors: validation.fieldErrors
      };
    }
    try {
      const plan = this.repository.save(recalculated, expectedRevision);
      identities.session.isNew = false;
      identities.session.originalEstimatedDurationSeconds = plan.estimatedDurationSeconds;
      identities.session.originalModeledSeconds = estimateModeledSeconds(plan.steps);
      identities.session.stepKinds = new Map(plan.steps.map(({ id, kind }) => [id, kind]));
      return {
        ok: true,
        plan,
        fieldErrors: {}
      };
    } catch (error) {
      if (error && error.code === 'PLAN_REVISION_CONFLICT') {
        return {
          ok: false,
          code: error.code,
          fieldErrors: { 'plan.revision': '计划已被更新，请重新加载后再保存' }
        };
      }
      if (error && error.code === 'PLAN_DATE_CONFLICT') {
        return {
          ok: false,
          code: error.code,
          fieldErrors: { 'plan.trainingDate': '该日期已有训练计划' }
        };
      }
      throw error;
    }
  }

  copyPlanToDate({
    editorSessionId = null,
    sourcePlanDraft = null,
    sourcePlanId,
    targetDate,
    commandKey,
    confirmReplace = false,
    copyIntentId = null,
    expectedTargetPlanId = null,
    expectedTargetRevision = null
  } = {}) {
    if (typeof commandKey !== 'string' || commandKey.trim().length === 0) {
      throw new Error('copy commandKey must be a non-empty string');
    }
    const persistedSource = this.repository.findById(sourcePlanId);
    if (persistedSource === null) {
      throw new Error(`WorkoutPlan ${sourcePlanId} is unavailable`);
    }
    let source = persistedSource;
    if (sourcePlanDraft !== null) {
      const identities = this.validateEditorStepIdentities(editorSessionId, sourcePlanDraft);
      if (!identities.ok) {
        return identities;
      }
      if (sourcePlanDraft.id !== sourcePlanId) {
        return {
          ok: false,
          code: 'PLAN_EDITOR_SESSION_INVALID',
          fieldErrors: { 'plan.id': '复制来源与当前编辑计划不一致' }
        };
      }
      source = this.recalculateDraftDuration(sourcePlanDraft, identities.session);
      const validation = validatePlanDraft(source);
      if (!validation.valid) {
        return {
          ok: false,
          code: 'PLAN_VALIDATION_FAILED',
          fieldErrors: validation.fieldErrors
        };
      }
    }
    if (targetDate === source.trainingDate) {
      return {
        ok: false,
        code: 'PLAN_COPY_SAME_DATE',
        fieldErrors: { 'plan.trainingDate': '请选择与来源计划不同的其他日期' }
      };
    }
    if (confirmReplace && (
      typeof copyIntentId !== 'string' || copyIntentId.trim().length === 0 ||
      typeof expectedTargetPlanId !== 'string' || expectedTargetPlanId.trim().length === 0 ||
      !Number.isSafeInteger(expectedTargetRevision) || expectedTargetRevision < 0
    )) {
      return {
        ok: false,
        code: 'PLAN_REPLACE_CONFIRMATION_INVALID',
        fieldErrors: { 'plan.revision': '替换确认已失效，请重新加载目标计划' }
      };
    }
    const target = this.repository.findByDate(targetDate);
    const stableIntentId = copyIntentId || commandKey;
    const fingerprint = computeChecksum({
      command: 'copy_plan_to_date',
      sourcePlanId,
      sourceRevision: source.revision,
      targetDate,
      copyIntentId: stableIntentId
    }).slice(0, 20);
    const copyService = createPlanCopyService({
      now: this.now,
      idFactory: ({ entity, index }) => entity === 'plan'
        ? `plan_copy_${fingerprint}`
        : `step_copy_${fingerprint}_${index + 1}`
    });
    const candidate = copyService.copy(source, { trainingDate: targetDate });
    const replayed = this.repository.findById(candidate.id);
    if (replayed !== null && replayed.trainingDate === targetDate) {
      return { ok: true, plan: replayed, replayed: true, replaced: false };
    }
    if (target !== null && !confirmReplace) {
      const issuedIntentId = copyIntentId || `copy_intent_${computeChecksum({
        sourcePlanId,
        sourceRevision: source.revision,
        targetDate,
        targetPlanId: target.id,
        targetRevision: target.revision,
        sequence: ++this.copyIntentSequence
      }).slice(0, 24)}`;
      return {
        ok: false,
        code: 'PLAN_REPLACE_CONFIRMATION_REQUIRED',
        requiresConfirmation: true,
        copyIntentId: issuedIntentId,
        targetPlanId: target.id,
        targetRevision: target.revision,
        fieldErrors: {}
      };
    }

    try {
      const plan = confirmReplace
        ? this.repository.replaceForDate(candidate, {
          expectedTargetPlanId,
          expectedTargetRevision
        })
        : this.repository.save(candidate, 0);
      return {
        ok: true,
        plan,
        replayed: false,
        replaced: confirmReplace
      };
    } catch (error) {
      if (error && error.code === 'PLAN_REVISION_CONFLICT') {
        return {
          ok: false,
          code: error.code,
          fieldErrors: { 'plan.revision': '目标日期计划已变化，请重新加载后确认' }
        };
      }
      throw error;
    }
  }
}

function createPlanApplicationService(options) {
  return new PlanApplicationService(options);
}

module.exports = { PlanApplicationService, createPlanApplicationService };
