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

const EMPTY_RECORD_SUMMARY_PROVIDER = Object.freeze({
  findRange() {
    return [];
  }
});

class PlanApplicationService {
  constructor({
    repository,
    defaultPlanFactory = createDefaultPlans,
    recordSummaryProvider = EMPTY_RECORD_SUMMARY_PROVIDER
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
    this.repository = repository;
    this.defaultPlanFactory = defaultPlanFactory;
    this.recordSummaryProvider = recordSummaryProvider;
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
}

function createPlanApplicationService(options) {
  return new PlanApplicationService(options);
}

module.exports = { PlanApplicationService, createPlanApplicationService };
