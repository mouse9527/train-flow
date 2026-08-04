const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSettingsPageDefinition
} = require('../../miniprogram/pages/settings/index');
const {
  createSyncApplicationService
} = require('../../miniprogram/application/sync-application-service');
const {
  createSettingsApplicationService
} = require('../../miniprogram/application/settings-application-service');
const {
  createSettingsRepository
} = require('../../miniprogram/domain/identity-settings/settings-repository');
const {
  createPlanRepository
} = require('../../miniprogram/domain/planning/plan-repository');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  ENTITY_TYPES
} = require('../../miniprogram/domain/sync/entity-mapper');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const {
  createDeterministicRemoteSyncProvider
} = require('../../miniprogram/services/remote-sync-provider');
const {
  createSyncService
} = require('../../miniprogram/services/sync-service');
const { StorageDouble } = require('../helpers/storage-double');

const NOW = 1785719340000;

function pageHarness(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) {
      this.data = { ...this.data, ...patch };
    }
  };
}

function remoteEnvelope(plan) {
  return {
    ownerId: 'anonymous_fixture_owner',
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    serverRevision: 2,
    schemaVersion: 1,
    payload: structuredClone(plan),
    deleted: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW + 2,
    sourceDeviceId: 'anonymous_remote_device'
  };
}

test('golden path: settings page enables, retries, resolves a plan conflict and purges only cloud data', async () => {
  const storage = new StorageDouble();
  const database = createLocalDatabase({ storage, now: () => NOW });
  database.commit((draft) => {
    draft.install = { deviceId: 'anonymous_device', createdAt: NOW - 1000 };
  });
  const planRepository = createPlanRepository({ database, now: () => NOW });
  const plan = {
    ...structuredClone(createDefaultPlans({ now: () => NOW })[0]),
    id: 'plan_sync_golden',
    trainingDate: '2026-08-10',
    templateSource: null
  };
  planRepository.save(plan, 0);

  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const syncApplication = createSyncApplicationService({
    syncService: createSyncService({ database, provider, now: () => NOW })
  });
  const settingsApplication = createSettingsApplicationService({
    repository: createSettingsRepository({ database }),
    database
  });
  const wxApi = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'release' } };
    },
    showModal(options) {
      options.success({ confirm: true });
    }
  };
  const page = pageHarness(createSettingsPageDefinition({
    settingsApplication,
    syncApplicationFactory: () => syncApplication,
    getWx: () => wxApi
  }));

  page.onLoad({ section: 'cloud-sync' });
  assert.equal(page.data.syncState.code, 'disabled');
  await page.onPrepareSyncEnable();
  assert.equal(page.data.syncEnablePreview.scope.plans, 1);
  await page.onConfirmSyncEnable();
  assert.equal(page.data.syncState.code, 'synced');
  assert.equal(database.load().sync.outbox.length, 0);

  const localPlan = planRepository.findById(plan.id);
  const localUpdate = {
    ...structuredClone(localPlan),
    title: '本机晨练调整',
    revision: localPlan.revision + 1,
    updatedAt: NOW
  };
  planRepository.save(localUpdate, localPlan.revision);
  const pending = database.load().sync.outbox.find(({ entityId }) => entityId === plan.id);
  const remotePlan = {
    ...structuredClone(localUpdate),
    title: '云端恢复训练',
    revision: localUpdate.revision + 1,
    updatedAt: NOW + 1
  };
  provider.conflictOperation(pending.opId, remoteEnvelope(remotePlan));

  await page.onRetrySync();
  assert.equal(page.data.syncState.code, 'conflict');
  assert.equal(page.data.syncState.conflicts.length, 1);
  await page.onResolveSyncConflict({
    detail: {
      conflictId: page.data.syncState.conflicts[0].conflictId,
      action: 'keep_local_as_copy'
    }
  });
  const afterResolution = database.load();
  assert.equal(afterResolution.plans.some(({ title }) => title === '云端恢复训练'), true);
  assert.equal(afterResolution.plans.some(({ title }) => title === '本机晨练调整（本机副本）'), true);
  assert.equal(page.data.syncState.conflicts.length, 0);

  await page.onPrepareCloudPurge();
  const localBeforePurge = database.load();
  await page.onConfirmCloudPurge();
  assert.equal(Number.isSafeInteger(page.data.cloudPurgeReceipt.purgedAt), true);
  const localAfterPurge = database.load();
  assert.deepEqual(localAfterPurge.plans, localBeforePurge.plans);
  assert.deepEqual(localAfterPurge.records, localBeforePurge.records);
  assert.equal(localAfterPurge.settings.defaultRestSeconds, localBeforePurge.settings.defaultRestSeconds);
  assert.equal(localAfterPurge.settings.cloudSyncEnabled, false);
  assert.equal(localAfterPurge.sync.enabled, false);
  assert.equal(localAfterPurge.sync.cursor, null);
  assert.deepEqual(localAfterPurge.sync.outbox, []);
  assert.deepEqual(localAfterPurge.sync.conflicts, []);
  assert.deepEqual(localAfterPurge.sync.replicas, {});
});

test('local clear through the real settings page/application path never purges or mutates remote copies', async () => {
  const storage = new StorageDouble();
  const database = createLocalDatabase({ storage, now: () => NOW });
  database.commit((draft) => {
    draft.install = { deviceId: 'anonymous_local_clear_device', createdAt: NOW - 1000 };
  });
  const planRepository = createPlanRepository({ database, now: () => NOW });
  const plan = {
    ...structuredClone(createDefaultPlans({ now: () => NOW })[0]),
    id: 'plan_local_clear_boundary',
    trainingDate: '2026-08-11',
    templateSource: null
  };
  planRepository.save(plan, 0);
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_local_clear_owner',
    now: () => NOW
  });
  const syncApplication = createSyncApplicationService({
    syncService: createSyncService({ database, provider, now: () => NOW })
  });
  const settingsApplication = createSettingsApplicationService({
    repository: createSettingsRepository({ database, now: () => NOW }),
    database
  });
  const wxApi = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'release' } };
    },
    showModal(options) {
      options.success({ confirm: true });
    }
  };
  const page = pageHarness(createSettingsPageDefinition({
    settingsApplication,
    syncApplicationFactory: () => syncApplication,
    getWx: () => wxApi
  }));

  page.onLoad({ section: 'cloud-sync' });
  await page.onPrepareSyncEnable();
  await page.onConfirmSyncEnable();
  const remoteBefore = await provider.pull({ cursor: null, limit: 100 });
  assert.equal(remoteBefore.changes.length, 2, 'plan and settings must exist remotely before local clear');

  await page.onPrepareLocalClear();
  const cleared = await page.onConfirmLocalClear();
  const localAfter = database.load();
  const remoteAfter = await provider.pull({ cursor: null, limit: 100 });

  assert.equal(cleared.purged, true);
  assert.deepEqual(localAfter.plans, []);
  assert.deepEqual(localAfter.records, []);
  assert.equal(provider.calls.preparePurge.length, 0);
  assert.equal(provider.calls.purge.length, 0);
  assert.deepEqual(remoteAfter.changes, remoteBefore.changes);
  assert.match(page.data.dataNotice, /本机数据已清除/);
  assert.match(page.data.dataNotice, /不会删除云端数据/);
});
