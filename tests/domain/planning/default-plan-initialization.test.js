const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE_VERSION
} = require('../../../miniprogram/data/default-plans');
const {
  createDefaultPlans
} = require('../../../miniprogram/domain/planning/default-plan-factory');
const {
  createPlanApplicationService
} = require('../../../miniprogram/application/plan-application-service');
const {
  createPlanRepository
} = require('../../../miniprogram/domain/planning/plan-repository');
const {
  createLocalDatabase
} = require('../../../miniprogram/services/local-database');
const { StorageDouble } = require('../../helpers/storage-double');

const FIXED_NOW = 1785717300000;

test('anonymous builtin_v1 template covers 2026-08-03 through 2026-08-09 with the confirmed structure', () => {
  assert.equal(DEFAULT_PLAN_TEMPLATE_VERSION, 'builtin_v1');
  assert.deepEqual(
    DEFAULT_PLAN_TEMPLATE.map(({ trainingDate }) => trainingDate),
    [
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09'
    ]
  );

  const monday = DEFAULT_PLAN_TEMPLATE[0];
  assert.equal(monday.title, '熟悉器械与基础力量');
  assert.deepEqual(
    monday.steps.map(({ kind, durationSeconds, sets, reps, restSeconds }) => ({
      kind,
      durationSeconds,
      sets,
      reps,
      restSeconds
    })),
    [
      { kind: 'timed', durationSeconds: 300, sets: null, reps: null, restSeconds: null },
      { kind: 'timed', durationSeconds: 720, sets: null, reps: null, restSeconds: null },
      { kind: 'timed', durationSeconds: 180, sets: null, reps: null, restSeconds: null },
      { kind: 'strength', durationSeconds: null, sets: 2, reps: 12, restSeconds: 75 },
      { kind: 'strength', durationSeconds: null, sets: 2, reps: 12, restSeconds: 75 },
      { kind: 'strength', durationSeconds: null, sets: 2, reps: 10, restSeconds: 60 },
      { kind: 'timed', durationSeconds: 300, sets: null, reps: null, restSeconds: null }
    ]
  );

  const thursdayInterval = DEFAULT_PLAN_TEMPLATE[3].steps[1];
  assert.deepEqual(
    {
      kind: thursdayInterval.kind,
      sets: thursdayInterval.sets,
      durationSeconds: thursdayInterval.durationSeconds,
      restSeconds: thursdayInterval.restSeconds,
      cadenceSpm: thursdayInterval.targets.cadenceSpm
    },
    {
      kind: 'interval',
      sets: 5,
      durationSeconds: 60,
      restSeconds: 30,
      cadenceSpm: { min: 18, max: 22 }
    }
  );

  const sunday = DEFAULT_PLAN_TEMPLATE[6];
  assert.equal(sunday.title, '完全休息');
  assert.equal(sunday.estimatedDurationSeconds, 0);
  assert.ok(sunday.steps.every(({ kind, durationSeconds }) => kind === 'rest_day' && durationSeconds === null));
});

test('default plan factory creates validated immutable-date plans with stable IDs and epoch timestamps', () => {
  const plans = createDefaultPlans({ now: () => FIXED_NOW });

  assert.equal(plans.length, 7);
  assert.ok(plans.every(({ templateSource }) => templateSource === DEFAULT_PLAN_TEMPLATE_VERSION));
  assert.ok(plans.every(({ createdAt, updatedAt, revision }) => (
    createdAt === FIXED_NOW && updatedAt === FIXED_NOW && revision === 1
  )));
  assert.equal(new Set(plans.map(({ id }) => id)).size, 7);
  assert.equal(
    new Set(plans.flatMap(({ steps }) => steps.map(({ id }) => id))).size,
    plans.reduce((total, { steps }) => total + steps.length, 0)
  );

  const repeated = createDefaultPlans({ now: () => FIXED_NOW + 999999 });
  assert.deepEqual(
    repeated.map(({ id, steps }) => ({ id, stepIds: steps.map(({ id: stepId }) => stepId) })),
    plans.map(({ id, steps }) => ({ id, stepIds: steps.map(({ id: stepId }) => stepId) }))
  );
});

test('default plan factory strips unknown identity context before validation', () => {
  const contaminated = DEFAULT_PLAN_TEMPLATE.map((plan, index) => ({
    ...plan,
    ...(index === 0 ? { ownerId: 'forged-owner', openId: 'forged-openid' } : {}),
    steps: plan.steps.map((step, stepIndex) => ({
      ...step,
      ...(index === 0 && stepIndex === 0 ? { sessionKey: 'forged-session' } : {})
    }))
  }));

  const plans = createDefaultPlans({ template: contaminated, now: () => FIXED_NOW });

  assert.equal(plans[0].ownerId, undefined);
  assert.equal(plans[0].openId, undefined);
  assert.equal(plans[0].steps[0].sessionKey, undefined);
});

function createPersistentPlanningRuntime(storage, { defaultPlanFactory } = {}) {
  const database = createLocalDatabase({ storage, now: () => FIXED_NOW });
  const repository = createPlanRepository({ database, now: () => FIXED_NOW });
  const service = createPlanApplicationService({ repository, defaultPlanFactory });
  return { database, repository, service };
}

test('application service validates and atomically persists all seven defaults through LocalDatabase', () => {
  const storage = new StorageDouble();
  const firstRuntime = createPersistentPlanningRuntime(storage);

  const result = firstRuntime.service.initializeDefaultPlans();

  assert.equal(result.created, 7);
  assert.equal(result.templateVersion, DEFAULT_PLAN_TEMPLATE_VERSION);
  assert.equal(result.plans.length, 7);
  assert.equal(firstRuntime.database.load().localRevision, 1);

  const restarted = createPersistentPlanningRuntime(storage);
  assert.deepEqual(
    restarted.repository.findRange('2026-08-03', '2026-08-09').map(({ id }) => id),
    result.plans.map(({ id }) => id)
  );
});

test('initializing the same templateVersion twice is an idempotent zero-write no-op', () => {
  const storage = new StorageDouble();
  const runtime = createPersistentPlanningRuntime(storage);
  runtime.service.initializeDefaultPlans();
  const revisionAfterFirstRun = runtime.database.load().localRevision;
  storage.clearOperations();

  const second = runtime.service.initializeDefaultPlans();

  assert.equal(second.created, 0);
  assert.equal(second.plans.length, 7);
  assert.equal(runtime.database.load().localRevision, revisionAfterFirstRun);
  assert.deepEqual(
    storage.operations.filter(({ type }) => type === 'write'),
    []
  );
});

test('an invalid default set fails before LocalDatabase writes any partial plan', () => {
  const storage = new StorageDouble();
  const invalidPlans = createDefaultPlans({ now: () => FIXED_NOW });
  invalidPlans[3].steps[0].kind = 'unknown';
  const runtime = createPersistentPlanningRuntime(storage, {
    defaultPlanFactory: () => invalidPlans
  });

  assert.throws(
    () => runtime.service.initializeDefaultPlans(),
    (error) => error && error.code === 'PLAN_VALIDATION_FAILED'
  );
  assert.deepEqual(
    storage.operations.filter(({ type }) => type === 'write'),
    []
  );
});
