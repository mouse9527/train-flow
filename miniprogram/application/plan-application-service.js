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
    return {
      draft: createPlanDraft(draft),
      expectedRevision: isNew ? 0 : persisted.revision,
      isNew,
      futureStartNotice: '保存后的修改仅应用于下次开始；进行中的训练保持原计划快照不变。'
    };
  }

  addPlanDraftStep({ draft, kind, name }) {
    return addDraftStep(draft, {
      id: this.idFactory({ entity: 'step', purpose: 'editor-add', kind }),
      kind,
      name
    });
  }

  savePlanDraft({ draft, expectedRevision } = {}) {
    const validation = validatePlanDraft(draft);
    if (!validation.valid) {
      return {
        ok: false,
        code: 'PLAN_VALIDATION_FAILED',
        fieldErrors: validation.fieldErrors
      };
    }
    try {
      return {
        ok: true,
        plan: this.repository.save(createPlanDraft(draft), expectedRevision),
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
    sourcePlanId,
    targetDate,
    commandKey,
    confirmReplace = false,
    expectedTargetRevision = null
  } = {}) {
    if (typeof commandKey !== 'string' || commandKey.trim().length === 0) {
      throw new Error('copy commandKey must be a non-empty string');
    }
    const source = this.repository.findById(sourcePlanId);
    if (source === null) {
      throw new Error(`WorkoutPlan ${sourcePlanId} is unavailable`);
    }
    const fingerprint = computeChecksum({
      command: 'copy_plan_to_date',
      sourcePlanId,
      targetDate,
      commandKey
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

    const target = this.repository.findByDate(targetDate);
    if (target !== null && !confirmReplace) {
      return {
        ok: false,
        code: 'PLAN_REPLACE_CONFIRMATION_REQUIRED',
        requiresConfirmation: true,
        targetRevision: target.revision,
        fieldErrors: {}
      };
    }
    try {
      const plan = target === null
        ? this.repository.save(candidate, 0)
        : this.repository.replaceForDate(candidate, expectedTargetRevision);
      return {
        ok: true,
        plan,
        replayed: false,
        replaced: target !== null
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
