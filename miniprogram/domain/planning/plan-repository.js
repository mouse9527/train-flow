const { assertWorkoutPlan } = require('./plan-validation');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateDefaultSet(plans, templateVersion) {
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error('Default plans must be a non-empty array');
  }
  if (typeof templateVersion !== 'string' || templateVersion.length === 0) {
    throw new Error('templateVersion must be a non-empty string');
  }
  plans.forEach((plan) => {
    assertWorkoutPlan(plan);
    if (plan.templateSource !== templateVersion) {
      throw new Error(`Default plan ${plan.id} must use templateSource ${templateVersion}`);
    }
  });
  const ids = plans.map(({ id }) => id);
  const dates = plans.map(({ trainingDate }) => trainingDate);
  if (new Set(ids).size !== ids.length || new Set(dates).size !== dates.length) {
    throw new Error('Default plans must use unique IDs and training dates');
  }
}

class PlanRepository {
  constructor({ database, now = Date.now }) {
    if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
      throw new Error('PlanRepository requires a LocalDatabase');
    }
    if (typeof now !== 'function') {
      throw new Error('PlanRepository now must be a function');
    }
    this.database = database;
    this.now = now;
  }

  initializeDefaults(plans, templateVersion) {
    validateDefaultSet(plans, templateVersion);
    const candidates = clone(plans);
    const snapshot = this.database.load();
    const existingFromTemplate = snapshot.plans.filter(
      ({ templateSource }) => templateSource === templateVersion
    );
    const candidateIds = new Set(candidates.map(({ id }) => id));
    if (
      existingFromTemplate.length === candidates.length &&
      existingFromTemplate.every(({ id }) => candidateIds.has(id))
    ) {
      return {
        created: 0,
        templateVersion,
        plans: clone(existingFromTemplate).sort((left, right) => (
          left.trainingDate.localeCompare(right.trainingDate)
        ))
      };
    }

    const existingIds = new Set(snapshot.plans.map(({ id }) => id));
    const existingDates = new Set(snapshot.plans.map(({ trainingDate }) => trainingDate));
    const missing = candidates.filter(({ id }) => !existingIds.has(id));
    for (const plan of missing) {
      if (existingDates.has(plan.trainingDate)) {
        throw new Error(`Plan already exists for trainingDate ${plan.trainingDate}`);
      }
    }
    if (missing.length === 0) {
      throw new Error(`Default template ${templateVersion} conflicts with existing plan IDs`);
    }

    const committed = this.database.commit((draft) => {
      draft.plans.push(...clone(missing));
    }, snapshot.localRevision);
    const persisted = committed.plans.filter(({ id }) => candidateIds.has(id));
    return {
      created: missing.length,
      templateVersion,
      plans: clone(persisted).sort((left, right) => left.trainingDate.localeCompare(right.trainingDate))
    };
  }

  findRange(startDate, endDate) {
    return this.database.load().plans
      .filter(({ status, trainingDate }) => (
        status !== 'deleted' && trainingDate >= startDate && trainingDate <= endDate
      ))
      .sort((left, right) => left.trainingDate.localeCompare(right.trainingDate))
      .map(clone);
  }
}

function createPlanRepository(options) {
  return new PlanRepository(options);
}

module.exports = { PlanRepository, createPlanRepository };
