const { PlanValidationError, assertWorkoutPlan } = require('./plan-validation');

const EDITABLE_STEP_FIELDS = new Set([
  'name',
  'description',
  'durationSeconds',
  'sets',
  'reps',
  'restSeconds',
  'targets',
  'optional',
  'alternatives'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPlanDraft(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('plan draft source must be an object');
  }
  return clone(plan);
}

function estimateModeledSeconds(steps) {
  if (!Array.isArray(steps)) {
    throw new Error('modeled duration requires WorkoutSteps');
  }
  return steps.reduce((total, step) => {
    if (step.kind === 'timed') {
      return total + step.durationSeconds;
    }
    if (step.kind === 'interval') {
      return total + (step.sets * step.durationSeconds) + ((step.sets - 1) * step.restSeconds);
    }
    if (step.kind === 'strength') {
      return total + (step.sets * step.reps * 5) + ((step.sets - 1) * step.restSeconds);
    }
    if (step.kind === 'manual') {
      return total + ((step.sets ?? 1) * step.reps * 5);
    }
    if (step.kind === 'rest_day') {
      return total;
    }
    throw new Error(`Unsupported WorkoutStep kind ${step.kind}`);
  }, 0);
}

function normalizeOrders(draft) {
  draft.steps.forEach((step, index) => {
    step.order = (index + 1) * 10;
  });
}

function findStep(draft, stepId) {
  if (!draft || !Array.isArray(draft.steps)) {
    throw new Error('plan draft must contain steps');
  }
  const step = draft.steps.find(({ id }) => id === stepId);
  if (!step) {
    throw new Error(`WorkoutStep ${stepId} is unavailable in the draft`);
  }
  return step;
}

function updateDraftStep(draft, stepId, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('step patch must be an object');
  }
  const unexpected = Object.keys(patch).find((field) => !EDITABLE_STEP_FIELDS.has(field));
  if (unexpected) {
    throw new Error(`step field ${unexpected} is not editable`);
  }
  const step = findStep(draft, stepId);
  Object.assign(step, clone(patch));
  return step;
}

function defaultsForKind(kind) {
  const defaults = {
    timed: { durationSeconds: 600, sets: null, reps: null, restSeconds: null },
    strength: { durationSeconds: null, sets: 3, reps: 10, restSeconds: 60 },
    interval: { durationSeconds: 60, sets: 5, reps: null, restSeconds: 30 },
    manual: { durationSeconds: null, sets: 1, reps: 10, restSeconds: null },
    rest_day: { durationSeconds: null, sets: null, reps: null, restSeconds: null }
  };
  if (!Object.prototype.hasOwnProperty.call(defaults, kind)) {
    throw new Error(`Unsupported WorkoutStep kind ${kind}`);
  }
  return defaults[kind];
}

function addDraftStep(draft, { id, kind, name }) {
  if (typeof id !== 'string' || !/^step_[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('new WorkoutStep id must be a safe generated step_ identifier');
  }
  if (draft.steps.some((step) => step.id === id)) {
    throw new Error(`WorkoutStep ${id} already exists in the draft`);
  }
  const step = {
    id,
    order: (draft.steps.length + 1) * 10,
    kind,
    name,
    description: '',
    ...defaultsForKind(kind),
    targets: {},
    optional: false,
    alternatives: [],
    safetyNoticeCodes: []
  };
  draft.steps.push(step);
  normalizeOrders(draft);
  return step;
}

function removeDraftStep(draft, stepId) {
  findStep(draft, stepId);
  draft.steps = draft.steps.filter(({ id }) => id !== stepId);
  normalizeOrders(draft);
  return draft;
}

function moveDraftStep(draft, stepId, direction) {
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('step move direction must be up or down');
  }
  const index = draft.steps.findIndex(({ id }) => id === stepId);
  if (index === -1) {
    throw new Error(`WorkoutStep ${stepId} is unavailable in the draft`);
  }
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= draft.steps.length) {
    return draft;
  }
  [draft.steps[index], draft.steps[targetIndex]] = [draft.steps[targetIndex], draft.steps[index]];
  normalizeOrders(draft);
  return draft;
}

function fieldPath(message) {
  const match = message.match(/^(plan(?:\.steps\[\d+\])?(?:\.[A-Za-z][A-Za-z0-9]*)*)/);
  return match ? match[1] : 'plan';
}

function localizedMessage(message) {
  if (message.includes(' is required')) return '此字段必填';
  if (message.includes('must be positive')) return '必须大于 0';
  if (message.includes('must be non-negative')) return '不能小于 0';
  if (message.includes('min must not exceed max')) return '最小值不能大于最大值';
  if (message.includes('must contain at least one step')) return '至少保留一个训练步骤';
  if (message.includes('must be strictly increasing')) return '步骤顺序无效';
  if (message.includes('manual steps require sets or reps')) return '组数和次数至少填写一项';
  if (message.includes('cannot be mixed')) return '休息日不能与训练步骤混合';
  if (message.includes('rest_day plan duration must be zero')) return '休息日计划预计时长必须为 0';
  return message;
}

function validatePlanDraft(draft) {
  try {
    assertWorkoutPlan(draft);
    return { valid: true, fieldErrors: {} };
  } catch (error) {
    if (!(error instanceof PlanValidationError)) {
      throw error;
    }
    const fieldErrors = {};
    error.fields.forEach((message) => {
      const path = fieldPath(message);
      fieldErrors[path] = fieldErrors[path]
        ? `${fieldErrors[path]}；${localizedMessage(message)}`
        : localizedMessage(message);
    });
    return { valid: false, fieldErrors };
  }
}

module.exports = {
  addDraftStep,
  createPlanDraft,
  estimateModeledSeconds,
  moveDraftStep,
  removeDraftStep,
  updateDraftStep,
  validatePlanDraft
};
