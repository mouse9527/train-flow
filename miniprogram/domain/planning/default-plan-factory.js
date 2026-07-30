const {
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE_VERSION
} = require('../../data/default-plans');
const { assertWorkoutPlan } = require('./plan-validation');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function projectStep(step) {
  return {
    id: step.id,
    order: step.order,
    kind: step.kind,
    name: step.name,
    description: step.description,
    durationSeconds: step.durationSeconds,
    sets: step.sets,
    reps: step.reps,
    restSeconds: step.restSeconds,
    targets: step.targets,
    optional: step.optional,
    alternatives: step.alternatives,
    safetyNoticeCodes: step.safetyNoticeCodes
  };
}

function projectPlan(plan, templateVersion, timestamp) {
  return {
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    trainingDate: plan.trainingDate,
    timezone: plan.timezone,
    title: plan.title,
    summary: plan.summary,
    estimatedDurationSeconds: plan.estimatedDurationSeconds,
    recommendedEndLocalTime: plan.recommendedEndLocalTime,
    safetyNoticeCodes: plan.safetyNoticeCodes,
    status: 'scheduled',
    steps: plan.steps.map(projectStep),
    templateSource: templateVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    revision: 1
  };
}

function createDefaultPlans({
  template = DEFAULT_PLAN_TEMPLATE,
  templateVersion = DEFAULT_PLAN_TEMPLATE_VERSION,
  now = Date.now
} = {}) {
  if (!Array.isArray(template) || template.length === 0) {
    throw new Error('Default plan template must contain plans');
  }
  if (typeof templateVersion !== 'string' || templateVersion.length === 0) {
    throw new Error('Default plan templateVersion must be a non-empty string');
  }
  const timestamp = now();
  if (!Number.isFinite(timestamp)) {
    throw new Error('Default plan timestamp must be finite epoch milliseconds');
  }
  const plans = template.map((plan) => {
    const projected = projectPlan(plan, templateVersion, timestamp);
    assertWorkoutPlan(projected);
    const detached = clone(projected);
    assertWorkoutPlan(detached);
    return detached;
  });
  const ids = plans.map(({ id }) => id);
  const dates = plans.map(({ trainingDate }) => trainingDate);
  if (new Set(ids).size !== ids.length || new Set(dates).size !== dates.length) {
    throw new Error('Default plan template must use unique plan IDs and training dates');
  }
  return plans;
}

module.exports = { createDefaultPlans };
