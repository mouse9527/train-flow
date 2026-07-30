const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PlanValidationError,
  assertWorkoutPlan,
  canStartStepTimer
} = require('../../../miniprogram/domain/planning/plan-validation');

const FIXED_NOW = 1785717300000;

function makeStep(kind, overrides = {}) {
  const common = {
    id: `step_${kind}`,
    order: 10,
    kind,
    name: `${kind} step`,
    description: '',
    durationSeconds: null,
    sets: null,
    reps: null,
    restSeconds: null,
    targets: {},
    optional: false,
    alternatives: [],
    safetyNoticeCodes: []
  };
  const defaults = {
    timed: { durationSeconds: 60 },
    strength: { sets: 2, reps: 12, restSeconds: 75 },
    interval: { durationSeconds: 60, sets: 5, restSeconds: 30 },
    manual: { sets: 1, reps: 10 },
    rest_day: {}
  };
  return { ...common, ...defaults[kind], ...overrides };
}

function makePlan(step, overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'plan_fixture',
    trainingDate: '2026-08-03',
    timezone: 'Asia/Shanghai',
    title: 'Anonymous fixture plan',
    summary: 'Fixture only',
    estimatedDurationSeconds: step.kind === 'rest_day' ? 0 : 600,
    recommendedEndLocalTime: '09:10',
    safetyNoticeCodes: [],
    status: 'scheduled',
    steps: [step],
    templateSource: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    deletedAt: null,
    revision: 1,
    ...overrides
  };
}

test('all five WorkoutStep kinds accept valid normalized shapes and only timer kinds can start timers', () => {
  for (const kind of ['timed', 'strength', 'interval', 'manual', 'rest_day']) {
    const plan = makePlan(makeStep(kind), {
      id: `plan_${kind}`,
      steps: [makeStep(kind)]
    });
    assert.equal(assertWorkoutPlan(plan), plan);
    assert.equal(canStartStepTimer(plan.steps[0]), kind === 'timed' || kind === 'interval');
  }
});

test('kind-specific invalid fields produce structured validation errors', () => {
  const invalidSteps = [
    makeStep('timed', { durationSeconds: 0 }),
    makeStep('strength', { sets: 0 }),
    makeStep('strength', { restSeconds: -1 }),
    makeStep('interval', { durationSeconds: null }),
    makeStep('manual', { sets: null, reps: null }),
    makeStep('rest_day', { durationSeconds: 86400 })
  ];

  for (const [index, step] of invalidSteps.entries()) {
    assert.throws(
      () => assertWorkoutPlan(makePlan(step, { id: `invalid_${index}`, steps: [step] })),
      (error) => (
        error instanceof PlanValidationError &&
        error.code === 'PLAN_VALIDATION_FAILED' &&
        Array.isArray(error.fields) &&
        error.fields.length > 0
      )
    );
  }
});

test('plan validation rejects duplicate step IDs, non-increasing order, invalid target ranges and mixed rest days', () => {
  const cases = [
    makePlan(makeStep('timed'), { steps: [null] }),
    makePlan(makeStep('timed'), { steps: [makeStep('timed'), makeStep('manual', { order: 20, id: 'step_timed' })] }),
    makePlan(makeStep('timed'), { steps: [makeStep('timed', { order: 20 }), makeStep('manual', { order: 10 })] }),
    makePlan(makeStep('timed', { targets: { speedKph: { min: 5.5, max: 4.5 } } })),
    makePlan(makeStep('rest_day'), { steps: [makeStep('rest_day'), makeStep('manual', { id: 'manual', order: 20 })] })
  ];

  for (const plan of cases) {
    assert.throws(() => assertWorkoutPlan(plan), PlanValidationError);
  }
});
