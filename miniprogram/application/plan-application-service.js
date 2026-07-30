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

class PlanApplicationService {
  constructor({ repository, defaultPlanFactory = createDefaultPlans }) {
    if (!repository || typeof repository.initializeDefaults !== 'function') {
      throw new Error('PlanApplicationService requires a PlanRepository');
    }
    if (typeof defaultPlanFactory !== 'function') {
      throw new Error('defaultPlanFactory must be a function');
    }
    this.repository = repository;
    this.defaultPlanFactory = defaultPlanFactory;
  }

  initializeDefaultPlans() {
    const plans = this.defaultPlanFactory();
    return this.repository.initializeDefaults(plans, DEFAULT_PLAN_TEMPLATE_VERSION);
  }

  getWeekPlan({
    weekStart = DEFAULT_WEEK_START,
    selectedDate = null,
    recordSummaries = []
  } = {}) {
    if (typeof this.repository.findRange !== 'function') {
      throw new Error('PlanApplicationService week queries require PlanRepository.findRange');
    }
    const range = createWeekPlanView({ weekStart, plans: [] });
    const plans = this.repository.findRange(range.weekStart, range.weekEnd);
    return createWeekPlanView({ weekStart, selectedDate, plans, recordSummaries });
  }
}

function createPlanApplicationService(options) {
  return new PlanApplicationService(options);
}

module.exports = { PlanApplicationService, createPlanApplicationService };
