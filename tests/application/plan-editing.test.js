const assert = require('node:assert/strict');
const test = require('node:test');

const {
  addDraftStep,
  createPlanDraft,
  moveDraftStep,
  removeDraftStep,
  updateDraftStep,
  validatePlanDraft
} = require('../../miniprogram/domain/planning/plan-editor');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');

const FIXED_NOW = 1785717300000;

function sourcePlan(index = 0) {
  return createDefaultPlans({ now: () => FIXED_NOW })[index];
}

test('plan editor keeps a detached draft and supports add, remove and reorder without mutating persisted input', () => {
  const persisted = sourcePlan();
  const original = structuredClone(persisted);
  const draft = createPlanDraft(persisted);

  draft.title = '调整后的训练';
  updateDraftStep(draft, persisted.steps[0].id, {
    name: '调整后的热身',
    durationSeconds: 420,
    targets: {
      speedKph: { min: 4.2, max: 4.8 },
      inclinePercent: { min: 1, max: 2 }
    },
    optional: true,
    alternatives: ['椭圆机热身']
  });
  addDraftStep(draft, {
    id: 'step_custom_strength',
    kind: 'strength',
    name: '自定义力量动作'
  });
  moveDraftStep(draft, 'step_custom_strength', 'up');
  removeDraftStep(draft, persisted.steps[1].id);

  assert.deepEqual(persisted, original);
  assert.equal(draft.title, '调整后的训练');
  assert.equal(draft.steps.at(-2).id, 'step_custom_strength');
  assert.equal(draft.steps.some(({ id }) => id === persisted.steps[1].id), false);
  assert.deepEqual(draft.steps.map(({ order }) => order), [10, 20, 30, 40, 50, 60, 70]);
  assert.deepEqual(draft.steps[0].targets.speedKph, { min: 4.2, max: 4.8 });
  assert.deepEqual(draft.steps[0].alternatives, ['椭圆机热身']);
});

test('plan editor returns field-level errors for required and kind-specific values', () => {
  const draft = createPlanDraft(sourcePlan());
  draft.title = '';
  updateDraftStep(draft, draft.steps[0].id, {
    durationSeconds: 0,
    targets: {
      speedKph: { min: 6, max: 4 },
      inclinePercent: { min: 0, max: 1 }
    }
  });
  updateDraftStep(draft, draft.steps[3].id, {
    sets: 0,
    reps: 0,
    restSeconds: -1
  });

  const result = validatePlanDraft(draft);

  assert.equal(result.valid, false);
  assert.match(result.fieldErrors['plan.title'], /必填/);
  assert.match(result.fieldErrors['plan.steps[0].durationSeconds'], /大于 0/);
  assert.match(result.fieldErrors['plan.steps[0].targets.speedKph'], /最小值/);
  assert.match(result.fieldErrors['plan.steps[3].sets'], /大于 0/);
  assert.match(result.fieldErrors['plan.steps[3].reps'], /大于 0/);
  assert.match(result.fieldErrors['plan.steps[3].restSeconds'], /不能小于 0/);
});

test('new step defaults expose only fields valid for its kind', () => {
  const expected = {
    timed: { durationSeconds: 600, sets: null, reps: null, restSeconds: null },
    strength: { durationSeconds: null, sets: 3, reps: 10, restSeconds: 60 },
    interval: { durationSeconds: 60, sets: 5, reps: null, restSeconds: 30 },
    manual: { durationSeconds: null, sets: 1, reps: 10, restSeconds: null },
    rest_day: { durationSeconds: null, sets: null, reps: null, restSeconds: null }
  };

  for (const [kind, fields] of Object.entries(expected)) {
    const draft = createPlanDraft(sourcePlan(6));
    removeDraftStep(draft, draft.steps[0].id);
    const step = addDraftStep(draft, {
      id: `step_new_${kind}`,
      kind,
      name: `${kind} step`
    });
    assert.deepEqual({
      durationSeconds: step.durationSeconds,
      sets: step.sets,
      reps: step.reps,
      restSeconds: step.restSeconds
    }, fields);
    assert.deepEqual(step.targets, {});
    assert.deepEqual(step.alternatives, []);
    assert.equal(step.optional, false);
  }
});
