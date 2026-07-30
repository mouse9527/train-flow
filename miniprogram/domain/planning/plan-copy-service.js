const { assertWorkoutPlan } = require('./plan-validation');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class PlanCopyService {
  constructor({ now = Date.now, idFactory = null } = {}) {
    if (typeof now !== 'function') {
      throw new Error('PlanCopyService now must be a function');
    }
    if (idFactory !== null && typeof idFactory !== 'function') {
      throw new Error('PlanCopyService idFactory must be a function');
    }
    let sequence = 0;
    this.now = now;
    this.idFactory = idFactory || (({ entity }) => (
      `${entity}_${this.now()}_${++sequence}`
    ));
  }

  copy(sourcePlan, { trainingDate } = {}) {
    assertWorkoutPlan(sourcePlan);
    if (sourcePlan.status === 'deleted') {
      throw new Error('Deleted plans cannot be copied');
    }
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) {
      throw new Error('PlanCopyService now must return a finite epoch timestamp');
    }

    const planId = this.idFactory({ entity: 'plan', sourceId: sourcePlan.id, index: 0 });
    if (typeof planId !== 'string' || planId.length === 0 || planId === sourcePlan.id) {
      throw new Error('PlanCopyService must generate a new plan ID');
    }
    const sourceStepIds = new Set(sourcePlan.steps.map(({ id }) => id));
    const steps = sourcePlan.steps.map((sourceStep, index) => ({
      ...clone(sourceStep),
      id: this.idFactory({ entity: 'step', sourceId: sourceStep.id, index })
    }));
    const copiedStepIds = steps.map(({ id }) => id);
    if (
      copiedStepIds.some((id) => typeof id !== 'string' || id.length === 0 || sourceStepIds.has(id)) ||
      new Set(copiedStepIds).size !== copiedStepIds.length
    ) {
      throw new Error('PlanCopyService must generate unique new step IDs');
    }

    const copied = {
      ...clone(sourcePlan),
      id: planId,
      trainingDate,
      status: 'scheduled',
      steps,
      templateSource: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      revision: 1
    };
    assertWorkoutPlan(copied);
    return copied;
  }
}

function createPlanCopyService(options) {
  return new PlanCopyService(options);
}

module.exports = { PlanCopyService, createPlanCopyService };
