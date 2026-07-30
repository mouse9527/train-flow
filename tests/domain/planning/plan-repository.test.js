const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PlanValidationError,
  assertWorkoutPlan,
  canStartStepTimer
} = require('../../../miniprogram/domain/planning/plan-validation');
const {
  createDefaultPlans
} = require('../../../miniprogram/domain/planning/default-plan-factory');
const {
  createPlanRepository
} = require('../../../miniprogram/domain/planning/plan-repository');
const {
  createPlanCopyService
} = require('../../../miniprogram/domain/planning/plan-copy-service');
const {
  createLocalDatabase
} = require('../../../miniprogram/services/local-database');
const { StorageDouble } = require('../../helpers/storage-double');

const FIXED_NOW = 1785717300000;
const SAVE_NOW = FIXED_NOW + 60000;

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

function createPersistentRepository(storage = new StorageDouble(), now = () => SAVE_NOW) {
  const database = createLocalDatabase({ storage, now: () => FIXED_NOW });
  const repository = createPlanRepository({ database, now });
  return { database, repository, storage };
}

function initializeBuiltinPlans(repository) {
  return repository.initializeDefaults(createDefaultPlans({ now: () => FIXED_NOW }), 'builtin_v1');
}

test('PlanRepository finds active plans by ID/date/inclusive range and never exposes mutable storage references', () => {
  const { repository } = createPersistentRepository();
  initializeBuiltinPlans(repository);

  const byId = repository.findById('plan_20260803_builtin');
  const byDate = repository.findByDate('2026-08-03');
  const range = repository.findRange('2026-08-05', '2026-08-07');

  assert.deepEqual(byDate, byId);
  assert.deepEqual(range.map(({ trainingDate }) => trainingDate), [
    '2026-08-05',
    '2026-08-06',
    '2026-08-07'
  ]);
  byId.title = 'mutated outside repository';
  byId.steps[0].name = 'mutated step';
  assert.equal(repository.findById('plan_20260803_builtin').title, '熟悉器械与基础力量');
  assert.notEqual(repository.findById('plan_20260803_builtin').steps[0].name, 'mutated step');
  assert.equal(repository.findById('missing'), null);
  assert.equal(repository.findByDate('2026-12-31'), null);
});

test('PlanRepository save creates with expected revision zero and updates with monotonic revision', () => {
  const { database, repository } = createPersistentRepository();
  const newPlan = makePlan(makeStep('manual'), {
    id: 'plan_custom',
    trainingDate: '2026-08-10',
    title: 'Custom plan'
  });

  const created = repository.save(newPlan, 0);
  assert.equal(created.revision, 1);
  assert.equal(created.createdAt, SAVE_NOW);
  assert.equal(created.updatedAt, SAVE_NOW);

  const updated = repository.save({ ...created, title: 'Updated custom plan' }, created.revision);
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, SAVE_NOW);
  assert.equal(updated.updatedAt, SAVE_NOW);
  assert.equal(repository.findById(newPlan.id).title, 'Updated custom plan');
  assert.equal(database.load().localRevision, 2);
});

test('PlanRepository save rejects non-finite targets before cloning without writes or input mutation', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const { database, repository, storage } = createPersistentRepository();
    const plan = makePlan(makeStep('timed', {
      targets: { speedKph: { min: invalid, max: 4.5 } }
    }), {
      id: `plan_non_finite_${String(invalid)}`,
      trainingDate: '2026-08-10'
    });
    const inputTargets = plan.steps[0].targets;
    const before = database.load();
    storage.clearOperations();

    assert.throws(
      () => repository.save(plan, 0),
      (error) => (
        error &&
        error.code === 'PLAN_VALIDATION_FAILED' &&
        error.fields.some((field) => field.includes('steps[0].targets.speedKph'))
      )
    );

    assert.deepEqual(database.load(), before);
    assert.deepEqual(storage.operations.filter(({ type }) => type === 'write'), []);
    assert.equal(plan.steps[0].targets, inputTargets);
    assert.ok(Object.is(plan.steps[0].targets.speedKph.min, invalid));
    assert.equal(plan.steps[0].targets.speedKph.max, 4.5);
  }
});

test('PlanRepository save continues to accept explicit null target bounds', () => {
  const { repository } = createPersistentRepository();
  const plan = makePlan(makeStep('timed', {
    targets: { speedKph: { min: null, max: 4.5 } }
  }), {
    id: 'plan_nullable_target',
    trainingDate: '2026-08-10'
  });

  const saved = repository.save(plan, 0);

  assert.equal(saved.steps[0].targets.speedKph.min, null);
  assert.equal(plan.steps[0].targets.speedKph.min, null);
});

test('PlanRepository rejects stale revisions and duplicate dates without overwriting the winner', () => {
  const { repository, storage } = createPersistentRepository();
  const initial = repository.save(makePlan(makeStep('manual'), {
    id: 'plan_custom',
    trainingDate: '2026-08-10'
  }), 0);
  const winner = repository.save({ ...initial, title: 'winner' }, 1);
  storage.clearOperations();

  assert.throws(
    () => repository.save({ ...initial, title: 'stale loser' }, 1),
    (error) => error && error.code === 'PLAN_REVISION_CONFLICT'
  );
  assert.equal(repository.findById(initial.id).title, winner.title);
  assert.deepEqual(storage.operations.filter(({ type }) => type === 'write'), []);

  assert.throws(
    () => repository.save(makePlan(makeStep('manual'), {
      id: 'different_id',
      trainingDate: initial.trainingDate
    }), 0),
    (error) => error && error.code === 'PLAN_DATE_CONFLICT'
  );
});

test('PlanRepository delete writes a revisioned tombstone and hides it from active queries', () => {
  const { database, repository } = createPersistentRepository();
  const created = repository.save(makePlan(makeStep('manual'), {
    id: 'plan_to_delete',
    trainingDate: '2026-08-10'
  }), 0);

  const deleted = repository.delete(created.id, created.revision);

  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.deletedAt, SAVE_NOW);
  assert.equal(deleted.revision, 2);
  assert.equal(repository.findById(created.id), null);
  assert.equal(repository.findByDate(created.trainingDate), null);
  assert.deepEqual(repository.findRange(created.trainingDate, created.trainingDate), []);
  assert.deepEqual(
    database.load().plans.find(({ id }) => id === created.id),
    deleted
  );
});

test('PlanRepository preserves a tombstone while allowing a new plan ID on the same date', () => {
  const { database, repository } = createPersistentRepository();
  const first = repository.save(makePlan(makeStep('manual'), {
    id: 'plan_first',
    trainingDate: '2026-08-10'
  }), 0);
  const tombstone = repository.delete(first.id, first.revision);

  const replacement = repository.save(makePlan(makeStep('manual'), {
    id: 'plan_replacement',
    trainingDate: first.trainingDate,
    title: 'replacement'
  }), 0);

  assert.equal(repository.findByDate(first.trainingDate).id, replacement.id);
  assert.equal(repository.findById(first.id), null);
  assert.deepEqual(
    database.load().plans.find(({ id }) => id === first.id),
    tombstone
  );
});

test('PlanRepository commit re-check still rejects a newly active date owner after the pre-check', () => {
  const requested = makePlan(makeStep('manual'), {
    id: 'plan_requested',
    trainingDate: '2026-08-10'
  });
  const baseline = {
    localRevision: 0,
    plans: []
  };
  let committed = false;
  const repository = createPlanRepository({
    now: () => SAVE_NOW,
    database: {
      load() {
        return structuredClone(baseline);
      },
      commit(mutator) {
        const draft = structuredClone(baseline);
        draft.plans.push(makePlan(makeStep('manual'), {
          id: 'concurrent_owner',
          trainingDate: requested.trainingDate
        }));
        mutator(draft);
        committed = true;
        return draft;
      }
    }
  });

  assert.throws(
    () => repository.save(requested, 0),
    (error) => error && error.code === 'PLAN_DATE_CONFLICT'
  );
  assert.equal(committed, false);
});

test('PlanRepository commit re-check ignores a historical tombstone added after the pre-check', () => {
  const requested = makePlan(makeStep('manual'), {
    id: 'plan_requested',
    trainingDate: '2026-08-10'
  });
  const baseline = {
    localRevision: 0,
    plans: []
  };
  const historical = makePlan(makeStep('manual'), {
    id: 'historical_owner',
    trainingDate: requested.trainingDate,
    status: 'deleted',
    deletedAt: SAVE_NOW,
    revision: 2
  });
  const repository = createPlanRepository({
    now: () => SAVE_NOW,
    database: {
      load() {
        return structuredClone(baseline);
      },
      commit(mutator) {
        const draft = structuredClone(baseline);
        draft.plans.push(structuredClone(historical));
        mutator(draft);
        return draft;
      }
    }
  });

  const saved = repository.save(requested, 0);

  assert.equal(saved.id, requested.id);
  assert.equal(saved.status, 'scheduled');
});

test('PlanCopyService deep-copies a plan with fresh plan/step IDs while preserving normalized values', () => {
  const source = createDefaultPlans({ now: () => FIXED_NOW })[0];
  let sequence = 0;
  const service = createPlanCopyService({
    now: () => SAVE_NOW,
    idFactory: ({ entity }) => `${entity}_copied_${++sequence}`
  });

  const copied = service.copy(source, { trainingDate: '2026-08-10' });

  assert.equal(copied.id, 'plan_copied_1');
  assert.notEqual(copied.id, source.id);
  assert.deepEqual(
    copied.steps.map(({ id }) => id),
    source.steps.map((step, index) => `step_copied_${index + 2}`)
  );
  assert.deepEqual(
    copied.steps.map(({ kind, durationSeconds, sets, reps, restSeconds, targets }) => ({
      kind,
      durationSeconds,
      sets,
      reps,
      restSeconds,
      targets
    })),
    source.steps.map(({ kind, durationSeconds, sets, reps, restSeconds, targets }) => ({
      kind,
      durationSeconds,
      sets,
      reps,
      restSeconds,
      targets
    }))
  );
  assert.equal(copied.trainingDate, '2026-08-10');
  assert.equal(copied.templateSource, null);
  assert.equal(copied.revision, 1);
  assert.equal(copied.createdAt, SAVE_NOW);
  assert.equal(copied.updatedAt, SAVE_NOW);

  copied.safetyNoticeCodes.push('COPY_ONLY');
  copied.steps[0].targets.speedKph.min = 999;
  copied.steps[0].alternatives.push('copy only');
  assert.equal(source.safetyNoticeCodes.includes('COPY_ONLY'), false);
  assert.notEqual(source.steps[0].targets.speedKph.min, 999);
  assert.equal(source.steps[0].alternatives.includes('copy only'), false);
});

test('PlanCopyService rejects ID factories that reuse source or duplicate step IDs', () => {
  const source = createDefaultPlans({ now: () => FIXED_NOW })[0];
  const sourceIdService = createPlanCopyService({
    now: () => SAVE_NOW,
    idFactory: ({ entity }) => entity === 'plan' ? source.id : 'fresh_step'
  });
  assert.throws(() => sourceIdService.copy(source, { trainingDate: '2026-08-10' }), /new plan ID/);

  const duplicateStepService = createPlanCopyService({
    now: () => SAVE_NOW,
    idFactory: ({ entity }) => entity === 'plan' ? 'fresh_plan' : 'duplicate_step'
  });
  assert.throws(
    () => duplicateStepService.copy(source, { trainingDate: '2026-08-10' }),
    /unique new step IDs/
  );
});
