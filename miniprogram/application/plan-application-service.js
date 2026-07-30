const {
  DEFAULT_PLAN_TEMPLATE_VERSION
} = require('../data/default-plans');
const {
  createDefaultPlans
} = require('../domain/planning/default-plan-factory');

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
}

function createPlanApplicationService(options) {
  return new PlanApplicationService(options);
}

module.exports = { PlanApplicationService, createPlanApplicationService };
