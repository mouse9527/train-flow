const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPlanApplicationService
} = require('../../miniprogram/application/plan-application-service');
const {
  createPlanCopyService
} = require('../../miniprogram/domain/planning/plan-copy-service');
const {
  createPlanRepository
} = require('../../miniprogram/domain/planning/plan-repository');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble } = require('../helpers/storage-double');

const FIXED_NOW = 1785717300000;

function createRuntime(storage) {
  const database = createLocalDatabase({ storage, now: () => FIXED_NOW });
  const repository = createPlanRepository({ database, now: () => FIXED_NOW });
  const application = createPlanApplicationService({ repository });
  return { application, repository };
}

test('planning golden path initializes, copies, saves and restores an independent plan', () => {
  const storage = new StorageDouble();
  const first = createRuntime(storage);
  first.application.initializeDefaultPlans();
  const source = first.repository.findByDate('2026-08-03');
  let sequence = 0;
  const copyService = createPlanCopyService({
    now: () => FIXED_NOW,
    idFactory: ({ entity }) => `${entity}_golden_${++sequence}`
  });

  const copied = copyService.copy(source, { trainingDate: '2026-08-10' });
  const saved = first.repository.save(copied, 0);
  const restarted = createRuntime(storage);
  const restored = restarted.repository.findByDate('2026-08-10');

  assert.deepEqual(restored, saved);
  assert.notEqual(restored.id, source.id);
  assert.deepEqual(restored.steps.map(({ kind }) => kind), source.steps.map(({ kind }) => kind));
  assert.ok(restored.steps.every(({ id }, index) => id !== source.steps[index].id));
});
