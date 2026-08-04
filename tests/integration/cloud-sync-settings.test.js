const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSyncApplicationService
} = require('../../miniprogram/application/sync-application-service');
const {
  createSettingsApplicationService
} = require('../../miniprogram/application/settings-application-service');
const {
  createBaselineTrainingRecord
} = require('../../miniprogram/domain/execution/training-record');
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
  appendRepositorySyncMutation,
  entityKey
} = require('../../miniprogram/domain/sync/sync-operation');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const {
  createSyncService
} = require('../../miniprogram/services/sync-service');
const { StorageDouble } = require('../helpers/storage-double');
const {
  assertPurgePreparationResult,
  createCloudBaseSyncProvider
} = require('../../miniprogram/services/cloudbase-sync-provider');
const {
  createDeterministicRemoteSyncProvider
} = require('../../miniprogram/services/remote-sync-provider');
const { computeChecksum } = require('../../miniprogram/utils/checksum');

const NOW = 1785719340000;

function createRuntime(provider, { now = () => NOW } = {}) {
  const storage = new StorageDouble();
  const database = createLocalDatabase({ storage, now });
  database.commit((draft) => {
    draft.install = { deviceId: 'device_cloud_settings', createdAt: NOW - 1000 };
  });
  const plan = {
    ...structuredClone(createDefaultPlans({ now })[0]),
    id: 'plan_cloud_settings',
    trainingDate: '2026-08-10',
    templateSource: null
  };
  createPlanRepository({ database, now }).save(plan, 0);
  const syncService = createSyncService({ database, provider, now });
  return {
    application: createSyncApplicationService({ syncService }),
    database,
    plan,
    storage,
    syncService
  };
}

function createFaultableProvider({ now }) {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_stage_failure',
    now
  });
  let nextFailure = null;
  function fail(stage) {
    if (nextFailure !== stage) return;
    nextFailure = null;
    const error = new Error(`private ${stage} failure sentinel`);
    error.code = 'CLOUD_SYNC_UNAVAILABLE';
    throw error;
  }
  return {
    ...provider,
    failNext(stage) {
      nextFailure = stage;
    },
    async bootstrap(request) {
      fail('bootstrap');
      return provider.bootstrap(request);
    },
    async push(request) {
      fail('push');
      return provider.push(request);
    },
    async pull(request) {
      fail('pull');
      return provider.pull(request);
    },
    async preparePurge(request) {
      fail('preparePurge');
      return provider.preparePurge(request);
    },
    async purge(request) {
      fail('purge');
      return provider.purge(request);
    }
  };
}

function addReadableRecord(database, plan, id) {
  const record = createBaselineTrainingRecord({
    id,
    planSnapshot: structuredClone(plan),
    trainingDate: plan.trainingDate,
    status: 'completed',
    startedAt: NOW,
    endedAt: NOW + 1000,
    elapsedActiveSeconds: 1,
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'completed',
      completedAt: NOW + 1000,
      setResults: []
    }))
  });
  database.commit((draft) => {
    draft.records.push(structuredClone(record));
  });
  return record;
}

function assertLocalDomainWritable({ database, plan, recordId, now, marker }) {
  const planRepository = createPlanRepository({ database, now });
  const currentPlan = planRepository.findById(plan.id);
  const savedPlan = planRepository.save({
    ...currentPlan,
    title: `${currentPlan.title}-${marker}`
  }, currentPlan.revision);
  const settingsRepository = createSettingsRepository({ database, now });
  const settingsApplication = createSettingsApplicationService({ repository: settingsRepository });
  const currentSettings = settingsApplication.getSettings();
  const savedSettings = settingsApplication.updateSettings({
    defaultRestSeconds: currentSettings.defaultRestSeconds === 75 ? 80 : 75
  }, currentSettings.revision);

  assert.equal(planRepository.findById(plan.id).title, savedPlan.title);
  assert.equal(savedSettings.revision, currentSettings.revision + 1);
  assert.equal(database.load().records.some(({ id }) => id === recordId), true);
}

function remoteEnvelope({ entityType, entityId, payload, serverRevision = 3 }) {
  return {
    ownerId: 'anonymous_fixture_owner',
    entityType,
    entityId,
    serverRevision,
    schemaVersion: 1,
    payload: structuredClone(payload),
    deleted: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW + serverRevision,
    sourceDeviceId: 'anonymous_remote_device'
  };
}

function enableForConflict(database) {
  database.commit((draft) => {
    draft.settings.cloudSyncEnabled = true;
    draft.sync.enabled = true;
    draft.sync.provider = 'fixture';
  });
}

test('AC1/AC5: CloudBase provider uses only callable functions and a server-issued purge confirmation', async () => {
  const calls = [];
  const responses = {
    authBootstrap: { cursor: null, serverTime: NOW },
    syncPush: { accepted: [], rejected: [], conflicts: [] },
    syncPull: { changes: [], nextCursor: null, hasMore: false },
    accountPurge: null
  };
  const wxApi = {
    cloud: {
      async callFunction(request) {
        calls.push(structuredClone(request));
        if (request.name === 'accountPurge' && request.data.action === 'prepare') {
          return {
            result: {
              confirmationToken: 'purge_v1.server-issued-token',
              expiresAt: NOW + 300000
            }
          };
        }
        if (request.name === 'accountPurge' && request.data.action === 'confirm') {
          return { result: { purgedAt: NOW + 1 } };
        }
        return { result: responses[request.name] };
      }
    }
  };
  const provider = createCloudBaseSyncProvider({ wx: wxApi });

  await provider.bootstrap({ deviceId: 'device_client_boundary' });
  await provider.push({ operations: [] });
  await provider.pull({ cursor: null, limit: 25 });
  const prepared = await provider.preparePurge({ deviceId: 'device_client_boundary' });
  assertPurgePreparationResult(prepared);
  const receipt = await provider.purge({
    deviceId: 'device_client_boundary',
    confirmationToken: prepared.confirmationToken
  });

  assert.deepEqual(receipt, { purgedAt: NOW + 1 });
  assert.deepEqual(calls, [
    { name: 'authBootstrap', data: { deviceId: 'device_client_boundary', schemaVersion: 1 } },
    { name: 'syncPush', data: { operations: [] } },
    { name: 'syncPull', data: { cursor: null, limit: 25 } },
    { name: 'accountPurge', data: { action: 'prepare', deviceId: 'device_client_boundary' } },
    {
      name: 'accountPurge',
      data: {
        action: 'confirm',
        deviceId: 'device_client_boundary',
        confirmationToken: 'purge_v1.server-issued-token'
      }
    }
  ]);
  assert.equal(typeof wxApi.cloud.database, 'undefined', 'client provider must not query CloudBase collections');
});

test('AC5: deterministic provider binds purge confirmation to the requesting device and replays one receipt', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const prepared = await provider.preparePurge({ deviceId: 'device_fixture_one' });

  await assert.rejects(
    () => provider.purge({
      deviceId: 'device_fixture_two',
      confirmationToken: prepared.confirmationToken
    }),
    { code: 'PURGE_CONFIRMATION_INVALID' }
  );
  const first = await provider.purge({
    deviceId: 'device_fixture_one',
    confirmationToken: prepared.confirmationToken
  });
  const replay = await provider.purge({
    deviceId: 'device_fixture_one',
    confirmationToken: prepared.confirmationToken
  });

  assert.deepEqual(first, { purgedAt: NOW });
  assert.deepEqual(replay, first);
  assert.deepEqual(provider.calls.purge, [
    { deviceId: 'device_fixture_two', confirmationToken: '[redacted]' },
    { deviceId: 'device_fixture_one', confirmationToken: '[redacted]' },
    { deviceId: 'device_fixture_one', confirmationToken: '[redacted]' }
  ]);
});

test('P1: cloud purge atomically resets only the remote boundary and re-enable uploads every entity from base zero', async () => {
  let clock = NOW;
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_purge_reenable',
    now: () => clock
  });
  const { application, database, plan, syncService } = createRuntime(provider, { now: () => clock });
  const record = createBaselineTrainingRecord({
    id: 'session_purge_reenable',
    planSnapshot: structuredClone(plan),
    trainingDate: plan.trainingDate,
    status: 'completed',
    startedAt: NOW,
    endedAt: NOW + 1000,
    elapsedActiveSeconds: 1,
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'completed',
      completedAt: NOW + 1000,
      setResults: []
    }))
  });
  database.commit((draft) => {
    draft.records.push(structuredClone(record));
    draft.sync.outbox = [];
    draft.sync.replicas = {};
  });
  const firstPreview = application.prepareEnable();
  assert.equal((await application.confirmEnable({ confirmationId: firstPreview.confirmationId })).ok, true);

  clock = NOW + 2000;
  const plans = createPlanRepository({ database, now: () => clock });
  const currentPlan = plans.findById(plan.id);
  plans.save({
    ...structuredClone(currentPlan),
    title: '删除云端前的本机编辑',
    revision: currentPlan.revision + 1,
    updatedAt: clock
  }, currentPlan.revision);
  const pendingPlanOp = database.load().sync.outbox.find(({ entityId }) => entityId === plan.id);
  provider.conflictOperation(pendingPlanOp.opId, remoteEnvelope({
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    payload: {
      ...structuredClone(currentPlan),
      title: '即将删除的云端冲突',
      revision: currentPlan.revision + 1
    }
  }));
  await syncService.pushPending();
  database.commit((draft) => {
    draft.sync.lastError = { code: 'RECOVERABLE_FIXTURE', failedAt: NOW };
  });
  const beforePurge = database.load();
  assert.ok(beforePurge.sync.cursor);
  assert.ok(Object.keys(beforePurge.sync.replicas).length > 0);
  assert.ok(beforePurge.sync.conflicts.length > 0);
  assert.ok(beforePurge.sync.outbox.length > 0);

  const prepared = await application.prepareRemotePurge();
  const receipt = await application.purgeRemote({ confirmationToken: prepared.confirmationToken });
  const afterPurge = database.load();

  assert.equal(receipt.purgedAt, clock);
  assert.deepEqual(afterPurge.plans, beforePurge.plans);
  assert.deepEqual(afterPurge.records, beforePurge.records);
  for (const field of [
    'vibrationEnabled',
    'soundEnabled',
    'voiceEnabled',
    'keepScreenOn',
    'defaultStartLocalTime',
    'recommendedEndLocalTime',
    'defaultRestSeconds',
    'timezone'
  ]) {
    assert.equal(afterPurge.settings[field], beforePurge.settings[field]);
  }
  assert.equal(afterPurge.settings.cloudSyncEnabled, false);
  assert.equal(afterPurge.sync.enabled, false);
  assert.equal(afterPurge.sync.provider, 'none');
  assert.equal(afterPurge.sync.cursor, null);
  assert.equal(afterPurge.sync.lastSyncedAt, null);
  assert.equal(afterPurge.sync.lastError, null);
  assert.deepEqual(afterPurge.sync.outbox, []);
  assert.deepEqual(afterPurge.sync.conflicts, []);
  assert.deepEqual(afterPurge.sync.replicas, {});

  const secondPreview = application.prepareEnable();
  assert.deepEqual(secondPreview.scope, {
    plans: 1,
    records: 1,
    settings: 1,
    pendingOperations: 0
  });
  assert.equal((await application.confirmEnable({ confirmationId: secondPreview.confirmationId })).ok, true);
  const reenableOperations = provider.calls.push.at(-1).operations;
  assert.equal(reenableOperations.length, 3);
  assert.equal(reenableOperations.every(({ baseServerRevision }) => baseServerRevision === 0), true);
  assert.deepEqual(database.load().sync.outbox, []);
  assert.equal(application.getState().code, 'synced');
});

test('P1: purge provider failure leaves local domain and sync metadata unchanged and the same token retries', async () => {
  const fake = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_purge_retry',
    now: () => NOW
  });
  const realPurge = fake.purge.bind(fake);
  let failNextPurge = true;
  const provider = {
    ...fake,
    async purge(request) {
      if (failNextPurge) {
        failNextPurge = false;
        const error = new Error('temporary purge failure');
        error.code = 'CLOUD_SYNC_UNAVAILABLE';
        throw error;
      }
      return realPurge(request);
    }
  };
  const { application, database } = createRuntime(provider);
  const preview = application.prepareEnable();
  assert.equal((await application.confirmEnable({ confirmationId: preview.confirmationId })).ok, true);
  const prepared = await application.prepareRemotePurge();
  const beforeFailure = database.load();

  await assert.rejects(
    () => application.purgeRemote({ confirmationToken: prepared.confirmationToken }),
    { code: 'CLOUD_SYNC_UNAVAILABLE' }
  );
  const afterFailure = database.load();
  assert.deepEqual(afterFailure.plans, beforeFailure.plans);
  assert.deepEqual(afterFailure.records, beforeFailure.records);
  assert.deepEqual(afterFailure.settings, beforeFailure.settings);
  assert.deepEqual(
    { ...afterFailure.sync, lastError: null },
    { ...beforeFailure.sync, lastError: null }
  );
  assert.equal(afterFailure.sync.lastError.code, 'CLOUD_SYNC_UNAVAILABLE');
  assert.equal(application.getState().code, 'failure');
  assert.equal(application.getState().label, '失败可重试');

  const receipt = await application.purgeRemote({ confirmationToken: prepared.confirmationToken });
  assert.equal(receipt.purgedAt, NOW);
  const afterRetry = database.load();
  assert.equal(afterRetry.sync.enabled, false);
  assert.equal(afterRetry.settings.cloudSyncEnabled, false);
  assert.deepEqual(afterRetry.sync.outbox, []);
  assert.deepEqual(afterRetry.sync.replicas, {});
});

test('AC1/AC2: enabling previews only upload counts and denied cloud becomes a recoverable sanitized state', async () => {
  const privateError = 'openid-secret-allowlist-sentinel';
  const fake = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const provider = {
    ...fake,
    async bootstrap() {
      const error = new Error(privateError);
      error.code = 'CLOUD_SYNC_UNAVAILABLE';
      throw error;
    }
  };
  const { application, database, plan } = createRuntime(provider);
  const preview = application.prepareEnable();

  assert.deepEqual(preview.scope, {
    plans: 1,
    records: 0,
    settings: 1,
    pendingOperations: 1
  });
  assert.equal(JSON.stringify(preview).includes(plan.title), false, 'preview must not expose local payloads');
  const result = await application.confirmEnable({ confirmationId: preview.confirmationId });
  const snapshot = database.load();

  assert.equal(result.ok, false);
  assert.equal(snapshot.settings.cloudSyncEnabled, true);
  assert.equal(snapshot.sync.enabled, true);
  assert.equal(snapshot.plans[0].title, plan.title, 'cloud denial must not block or mutate local plans');
  assert.equal(application.getState().code, 'failure');
  assert.equal(application.getState().label, '失败可重试');
  assert.equal(application.getState().errorCode, 'CLOUD_SYNC_UNAVAILABLE');
  assert.equal(JSON.stringify(application.getState()).includes(privateError), false);
  assert.equal(JSON.stringify(application.getState()).includes('openid'), false);
});

test('P1: every provider stage failure is sanitized, leaves local domains writable, and retries', async (t) => {
  for (const stage of ['bootstrap', 'push', 'pull', 'preparePurge', 'purge']) {
    await t.test(stage, async () => {
      let clock = NOW;
      const provider = createFaultableProvider({ now: () => clock });
      const { application, database, plan } = createRuntime(provider, { now: () => clock });
      const record = addReadableRecord(database, plan, `record_stage_${stage}`);
      let retry;

      if (['bootstrap', 'push', 'pull'].includes(stage)) {
        provider.failNext(stage);
        const preview = application.prepareEnable();
        const result = await application.confirmEnable({ confirmationId: preview.confirmationId });
        assert.equal(result.ok, false);
        assert.equal(result.state.code, 'failure');
        assert.equal(result.state.label, '失败可重试');
        assert.equal(result.state.errorCode, 'CLOUD_SYNC_UNAVAILABLE');

        clock += 10000;
        assertLocalDomainWritable({
          database,
          plan,
          recordId: record.id,
          now: () => clock,
          marker: stage
        });
        retry = await application.retry({ source: 'manual' });
        assert.equal(retry.ok, true);
        if (retry.state.code === 'waiting') {
          retry = await application.retry({ source: 'automatic' });
          assert.equal(retry.ok, true);
        }
        assert.equal(retry.state.code, 'synced');
      } else {
        const preview = application.prepareEnable();
        assert.equal((await application.confirmEnable({ confirmationId: preview.confirmationId })).ok, true);
        let prepared = null;
        if (stage === 'purge') prepared = await application.prepareRemotePurge();
        provider.failNext(stage);
        await assert.rejects(
          () => stage === 'preparePurge'
            ? application.prepareRemotePurge()
            : application.purgeRemote({ confirmationToken: prepared.confirmationToken }),
          { code: 'CLOUD_SYNC_UNAVAILABLE' }
        );
        assert.equal(application.getState().code, 'failure');
        assert.equal(application.getState().label, '失败可重试');
        assert.equal(application.getState().errorCode, 'CLOUD_SYNC_UNAVAILABLE');

        clock += 10000;
        assertLocalDomainWritable({
          database,
          plan,
          recordId: record.id,
          now: () => clock,
          marker: stage
        });
        if (stage === 'preparePurge') {
          retry = await application.retry({ source: 'manual' });
          assert.equal(retry.ok, true);
          prepared = await application.prepareRemotePurge();
          assert.match(prepared.confirmationToken, /^purge_fixture_/);
        } else {
          const receipt = await application.purgeRemote({
            confirmationToken: prepared.confirmationToken
          });
          assert.equal(receipt.purgedAt, clock);
          assert.equal(application.getState().code, 'disabled');
          assert.equal(database.load().plans[0].title.endsWith(`-${stage}`), true);
          assert.equal(database.load().records.some(({ id }) => id === record.id), true);
        }
      }

      assert.equal(JSON.stringify(application.getState()).includes('private'), false);
    });
  }
});

test('P1: empty outbox enable preview atomically enqueues every missing active local entity before sync', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const { application, database, plan } = createRuntime(provider);
  const record = createBaselineTrainingRecord({
    id: 'session_enable_preview',
    planSnapshot: structuredClone(plan),
    trainingDate: plan.trainingDate,
    status: 'completed',
    startedAt: NOW,
    endedAt: NOW + 1000,
    elapsedActiveSeconds: 1,
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'completed',
      completedAt: NOW + 1000,
      setResults: []
    }))
  });
  database.commit((draft) => {
    draft.records.push(structuredClone(record));
    draft.sync.outbox = [];
    draft.sync.replicas = {};
  });

  const preview = application.prepareEnable();
  assert.deepEqual(preview.scope, {
    plans: 1,
    records: 1,
    settings: 1,
    pendingOperations: 0
  });
  assert.equal(Object.prototype.hasOwnProperty.call(preview, 'previewToken'), false);
  const result = await application.confirmEnable({ confirmationId: preview.confirmationId });

  assert.equal(result.ok, true);
  assert.deepEqual(
    new Set(provider.calls.push[0].operations.map(({ entityType }) => entityType)),
    new Set([
      ENTITY_TYPES.WORKOUT_PLAN,
      ENTITY_TYPES.TRAINING_RECORD,
      ENTITY_TYPES.USER_SETTINGS
    ])
  );
  assert.equal(provider.calls.push[0].operations.length, 3);
  assert.equal(database.load().sync.outbox.length, 0);
});

test('P1: stale enable preview rejects with zero writes after the intervening local revision', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const { application, database } = createRuntime(provider);
  database.commit((draft) => {
    draft.sync.outbox = [];
    draft.sync.replicas = {};
  });
  const preview = application.prepareEnable();
  database.commit((draft) => {
    draft.settings.defaultRestSeconds = 95;
    draft.settings.revision += 1;
  });
  const beforeConfirm = database.load();

  await assert.rejects(
    () => application.confirmEnable({ confirmationId: preview.confirmationId }),
    { code: 'SYNC_ENABLE_PREVIEW_STALE' }
  );
  assert.deepEqual(database.load(), beforeConfirm);
  assert.equal(provider.calls.bootstrap.length, 0);
  assert.equal(provider.calls.push.length, 0);
});

test('P1: enable bootstrap preserves exact queued work and skips an exact replica fact', async () => {
  const fake = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const provider = {
    ...fake,
    async bootstrap() {
      const error = new Error('offline fixture');
      error.code = 'CLOUD_SYNC_UNAVAILABLE';
      throw error;
    }
  };
  const { application, database, plan } = createRuntime(provider);
  const originalPlanOp = database.load().sync.outbox.find(({ entityId }) => entityId === plan.id);
  const record = createBaselineTrainingRecord({
    id: 'session_enable_replica',
    planSnapshot: structuredClone(plan),
    trainingDate: plan.trainingDate,
    status: 'completed',
    startedAt: NOW,
    endedAt: NOW + 1000,
    elapsedActiveSeconds: 1,
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'completed',
      completedAt: NOW + 1000,
      setResults: []
    }))
  });
  database.commit((draft) => {
    draft.records.push(structuredClone(record));
    draft.sync.replicas[entityKey(ENTITY_TYPES.TRAINING_RECORD, record.id)] = {
      entityType: ENTITY_TYPES.TRAINING_RECORD,
      entityId: record.id,
      serverRevision: 4,
      payloadHash: computeChecksum(record),
      deleted: false
    };
  });

  const preview = application.prepareEnable();
  const result = await application.confirmEnable({ confirmationId: preview.confirmationId });
  const outbox = database.load().sync.outbox;

  assert.equal(result.ok, false);
  assert.equal(outbox.find(({ entityId }) => entityId === plan.id).opId, originalPlanOp.opId);
  assert.equal(outbox.some(({ entityId }) => entityId === record.id), false);
  assert.equal(outbox.filter(({ entityType }) => entityType === ENTITY_TYPES.USER_SETTINGS).length, 1);
});

test('AC1/AC3: manual and automatic retry share the same outbox and a lost response creates no remote duplicate', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const { application, database } = createRuntime(provider);
  const preview = application.prepareEnable();
  provider.loseNextPushResponse();

  const enabled = await application.confirmEnable({ confirmationId: preview.confirmationId });
  assert.equal(enabled.ok, false);
  const afterLost = database.load();
  const pendingOpIds = afterLost.sync.outbox.map(({ opId }) => opId);
  assert.ok(pendingOpIds.length >= 2, 'plan and cloud preference remain queued after lost response');

  provider.loseNextPushResponse();
  const manual = await application.retry({ source: 'manual' });
  assert.equal(manual.ok, false);
  assert.deepEqual(database.load().sync.outbox.map(({ opId }) => opId), pendingOpIds);
  assert.equal(manual.state.code, 'failure');
  const automatic = await application.retry({ source: 'automatic' });
  assert.equal(automatic.ok, true);
  assert.deepEqual(database.load().sync.outbox, []);
  assert.deepEqual(
    provider.calls.push.slice(0, 3).map(({ operations }) => operations.map(({ opId }) => opId)),
    [pendingOpIds, pendingOpIds, pendingOpIds],
    'manual and automatic lost-response retries must send the exact same operation identities'
  );
  assert.equal(application.getState().code, 'synced');
  assert.equal(application.getState().label, '已同步');

  const remote = await provider.pull({ cursor: null, limit: 100 });
  assert.equal(remote.changes.length, 2, 'remote contains one plan and one settings entity only');
  assert.equal(new Set(remote.changes.map(({ entityId }) => entityId)).size, 2);
});

test('AC3: rejected operations stay visible and retain their exact pending identity', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_rejected_visibility',
    now: () => NOW
  });
  const { application, database, plan } = createRuntime(provider);
  const rejected = database.load().sync.outbox.find(({ entityId }) => entityId === plan.id);
  provider.rejectOperation(rejected.opId, 'REMOTE_VALIDATION_REJECTED');

  const preview = application.prepareEnable();
  const result = await application.confirmEnable({ confirmationId: preview.confirmationId });
  const state = application.getState();

  assert.equal(result.ok, true);
  assert.deepEqual(result.result.push.rejected, [{
    opId: rejected.opId,
    code: 'REMOTE_VALIDATION_REJECTED'
  }]);
  assert.equal(state.code, 'waiting');
  assert.equal(state.label, '等待 1 项');
  assert.equal(state.pendingCount, 1);
  assert.equal(database.load().sync.outbox[0].opId, rejected.opId);
});

test('AC3/AC4: one mixed push removes accepted work while rejected and conflict operations stay actionable', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_mixed_classification',
    now: () => NOW
  });
  const { application, database, plan } = createRuntime(provider);
  const record = createBaselineTrainingRecord({
    id: 'record_mixed_classification',
    planSnapshot: structuredClone(plan),
    trainingDate: plan.trainingDate,
    status: 'completed',
    startedAt: NOW,
    endedAt: NOW + 1000,
    elapsedActiveSeconds: 1,
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'completed',
      completedAt: NOW + 1000,
      setResults: []
    }))
  });
  database.commit((draft) => {
    draft.records.push(structuredClone(record));
    appendRepositorySyncMutation(draft, {
      entityType: ENTITY_TYPES.TRAINING_RECORD,
      entityId: record.id,
      action: 'upsert',
      payload: record
    }, {
      commandIdentity: 'record.mixed-classification.fixture',
      createdAt: NOW,
      deviceId: draft.install.deviceId
    });
  });
  const before = database.load();
  const planOperation = before.sync.outbox.find(({ entityId }) => entityId === plan.id);
  const recordOperation = before.sync.outbox.find(({ entityId }) => entityId === record.id);
  provider.rejectOperation(recordOperation.opId, 'REMOTE_VALIDATION_REJECTED');
  provider.conflictOperation(planOperation.opId, remoteEnvelope({
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    payload: {
      ...structuredClone(plan),
      title: '云端混合分类计划',
      revision: plan.revision + 1
    }
  }));

  const preview = application.prepareEnable();
  const result = await application.confirmEnable({ confirmationId: preview.confirmationId });
  const after = database.load();
  const state = application.getState();
  const acceptedSettings = result.result.push.acceptedOpIds.find((opId) => (
    ![planOperation.opId, recordOperation.opId].includes(opId)
  ));

  assert.equal(result.ok, true);
  assert.equal(typeof acceptedSettings, 'string');
  assert.deepEqual(result.result.push.rejected, [{
    opId: recordOperation.opId,
    code: 'REMOTE_VALIDATION_REJECTED'
  }]);
  assert.equal(result.result.push.conflicts[0].opId, planOperation.opId);
  assert.equal(after.sync.outbox.some(({ opId }) => opId === acceptedSettings), false);
  assert.deepEqual(
    after.sync.outbox.map(({ opId }) => opId).sort(),
    [planOperation.opId, recordOperation.opId].sort()
  );
  assert.equal(state.code, 'conflict');
  assert.equal(state.label, '冲突');
  assert.equal(state.pendingCount, 2);
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.conflicts[0].conflictId.length > 0, true);
  assert.equal(state.conflicts[0].actions.includes('rebase'), true, 'conflict must expose an explicit retry action');
});

test('AC4: plan conflict remains visible until explicit keep-local-as-copy atomically preserves both sides', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const { application, database, plan, syncService } = createRuntime(provider);
  enableForConflict(database);
  const localOperation = database.load().sync.outbox.find(({ entityId }) => entityId === plan.id);
  const remotePlan = { ...structuredClone(plan), title: '云端版本', revision: plan.revision + 1 };
  provider.conflictOperation(localOperation.opId, remoteEnvelope({
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    payload: remotePlan
  }));

  await syncService.pushPending();
  const visible = application.getState().conflicts[0];
  assert.equal(application.getState().code, 'conflict');
  assert.deepEqual(visible.actions, ['keep_remote', 'keep_local_as_copy', 'rebase']);
  assert.match(visible.localSummary, /本机/);
  assert.match(visible.remoteSummary, /云端版本/);
  assert.equal(JSON.stringify(visible).includes('ownerId'), false);
  assert.equal(database.load().sync.outbox.some(({ opId }) => opId === localOperation.opId), true);

  const resolved = await application.resolveConflict({
    conflictId: visible.conflictId,
    action: 'keep_local_as_copy'
  });
  const after = database.load();
  const original = after.plans.find(({ id }) => id === plan.id);
  const copy = after.plans.find(({ id }) => id === resolved.copyEntityId);

  assert.equal(original.title, '云端版本');
  assert.equal(copy.title, `${plan.title}（本机副本）`);
  assert.equal(after.sync.outbox.some(({ opId }) => opId === localOperation.opId), false);
  assert.equal(after.sync.outbox.some(({ entityId }) => entityId === copy.id), true);
  assert.equal(application.getState().conflicts.length, 0);
  assert.equal(after.sync.replicas[entityKey(ENTITY_TYPES.WORKOUT_PLAN, plan.id)].serverRevision, 3);
});

test('P1: a same-entity successor makes the displayed conflict stale with zero resolution writes', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const { application, database, plan, syncService } = createRuntime(provider);
  enableForConflict(database);
  const localOperation = database.load().sync.outbox.find(({ entityId }) => entityId === plan.id);
  const remotePlan = { ...structuredClone(plan), title: '云端旧冲突', revision: plan.revision + 1 };
  provider.conflictOperation(localOperation.opId, remoteEnvelope({
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    payload: remotePlan
  }));
  await syncService.pushPending();
  const visible = application.getState().conflicts[0];

  const repository = createPlanRepository({ database, now: () => NOW + 2000 });
  const current = repository.findById(plan.id);
  repository.save({
    ...structuredClone(current),
    title: '冲突出现后的新编辑',
    revision: current.revision + 1,
    updatedAt: NOW + 2000
  }, current.revision);
  const beforeResolution = database.load();
  const providerCallsBeforeResolution = structuredClone(provider.calls);

  await assert.rejects(
    () => application.resolveConflict({
      conflictId: visible.conflictId,
      action: 'keep_remote'
    }),
    { code: 'SYNC_CONFLICT_STALE' }
  );
  assert.deepEqual(database.load(), beforeResolution);
  assert.deepEqual(provider.calls, providerCallsBeforeResolution);
  assert.equal(application.getState().conflicts.length, 1);
  assert.equal(
    database.load().sync.outbox.filter(({ entityId }) => entityId === plan.id).length,
    2
  );
});

test('AC4: record copy and settings rebase stay explicit and preserve visible conflict state until chosen', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const { application, database, plan, syncService } = createRuntime(provider);
  const record = createBaselineTrainingRecord({
    id: 'session_cloud_conflict',
    planSnapshot: structuredClone(plan),
    trainingDate: plan.trainingDate,
    status: 'completed',
    startedAt: NOW,
    endedAt: NOW + 1000,
    elapsedActiveSeconds: 1,
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      status: 'completed',
      completedAt: NOW + 1000,
      setResults: []
    }))
  });
  database.commit((draft) => {
    draft.records.push(structuredClone(record));
    appendRepositorySyncMutation(draft, {
      entityType: ENTITY_TYPES.TRAINING_RECORD,
      entityId: record.id,
      action: 'upsert',
      payload: record
    }, {
      commandIdentity: 'record.conflict.fixture',
      createdAt: NOW,
      deviceId: draft.install.deviceId
    });
  });
  const settings = createSettingsApplicationService({
    repository: createSettingsRepository({ database, now: () => NOW })
  });
  settings.updateSettings({ defaultRestSeconds: 95 }, database.load().settings.revision);
  enableForConflict(database);
  const before = database.load();
  const recordOperation = before.sync.outbox.find(({ entityId }) => entityId === record.id);
  const settingsOperation = before.sync.outbox.find(
    ({ entityType }) => entityType === ENTITY_TYPES.USER_SETTINGS
  );
  const remoteRecord = structuredClone(record);
  const remoteSettings = {
    ...structuredClone(before.settings),
    defaultRestSeconds: 80,
    cloudSyncEnabled: true,
    revision: before.settings.revision + 2
  };
  provider.conflictOperation(recordOperation.opId, remoteEnvelope({
    entityType: ENTITY_TYPES.TRAINING_RECORD,
    entityId: record.id,
    payload: remoteRecord
  }));
  provider.conflictOperation(settingsOperation.opId, remoteEnvelope({
    entityType: ENTITY_TYPES.USER_SETTINGS,
    entityId: 'settings',
    payload: remoteSettings
  }));

  await syncService.pushPending();
  const conflicts = application.getState().conflicts;
  const recordConflict = conflicts.find(({ entityType }) => entityType === ENTITY_TYPES.TRAINING_RECORD);
  const settingsConflict = conflicts.find(({ entityType }) => entityType === ENTITY_TYPES.USER_SETTINGS);
  assert.deepEqual(recordConflict.actions, ['keep_remote', 'keep_local_as_copy', 'rebase']);
  assert.deepEqual(settingsConflict.actions, ['keep_remote', 'rebase']);
  assert.equal(database.load().records[0].elapsedActiveSeconds, 1, 'record stays local before explicit choice');

  const copyReceipt = await application.resolveConflict({
    conflictId: recordConflict.conflictId,
    action: 'keep_local_as_copy'
  });
  const afterRecord = database.load();
  assert.deepEqual(afterRecord.records.find(({ id }) => id === record.id), remoteRecord);
  const recordCopy = afterRecord.records.find(({ id }) => id === copyReceipt.copyEntityId);
  assert.ok(recordCopy, 'local record copy must remain available');
  assert.equal(recordCopy.elapsedActiveSeconds, 1);
  assert.equal(afterRecord.sync.outbox.some(({ entityId }) => entityId === recordCopy.id), true);

  await application.resolveConflict({
    conflictId: settingsConflict.conflictId,
    action: 'rebase'
  });
  const after = database.load();
  const rebasedSettingsOperation = after.sync.outbox.find(
    ({ entityType }) => entityType === ENTITY_TYPES.USER_SETTINGS
  );
  assert.equal(after.settings.defaultRestSeconds, 95);
  assert.equal(rebasedSettingsOperation.baseServerRevision, 3);
  assert.equal(application.getState().conflicts.length, 0);
});

test('P1: conflict action matrix consumes only the exact operation for plan, record and settings', async (t) => {
  async function planFixture(label) {
    const provider = createDeterministicRemoteSyncProvider({
      ownerId: `anonymous_plan_${label}`,
      now: () => NOW
    });
    const runtime = createRuntime(provider);
    enableForConflict(runtime.database);
    const operation = runtime.database.load().sync.outbox.find(({ entityId }) => entityId === runtime.plan.id);
    const remote = {
      ...structuredClone(runtime.plan),
      title: `云端计划 ${label}`,
      revision: runtime.plan.revision + 1
    };
    provider.conflictOperation(operation.opId, remoteEnvelope({
      entityType: ENTITY_TYPES.WORKOUT_PLAN,
      entityId: runtime.plan.id,
      payload: remote
    }));
    await runtime.syncService.pushPending();
    return { ...runtime, operation, remote, conflict: runtime.application.getState().conflicts[0] };
  }

  async function recordFixture(label) {
    const provider = createDeterministicRemoteSyncProvider({
      ownerId: `anonymous_record_${label}`,
      now: () => NOW
    });
    const runtime = createRuntime(provider);
    const record = createBaselineTrainingRecord({
      id: `session_record_${label}`,
      planSnapshot: structuredClone(runtime.plan),
      trainingDate: runtime.plan.trainingDate,
      status: 'completed',
      startedAt: NOW,
      endedAt: NOW + 1000,
      elapsedActiveSeconds: 1,
      stepResults: runtime.plan.steps.map((step) => ({
        stepId: step.id,
        status: 'completed',
        completedAt: NOW + 1000,
        setResults: []
      }))
    });
    runtime.database.commit((draft) => {
      draft.records.push(structuredClone(record));
      appendRepositorySyncMutation(draft, {
        entityType: ENTITY_TYPES.TRAINING_RECORD,
        entityId: record.id,
        action: 'upsert',
        payload: record
      }, {
        commandIdentity: `record.matrix.${label}`,
        createdAt: NOW,
        deviceId: draft.install.deviceId
      });
    });
    enableForConflict(runtime.database);
    const operation = runtime.database.load().sync.outbox.find(({ entityId }) => entityId === record.id);
    const remote = {
      ...structuredClone(record),
      feedback: {
        rpe: 6,
        weightBeforeKg: null,
        pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
        note: `云端记录 ${label}`
      }
    };
    provider.conflictOperation(operation.opId, remoteEnvelope({
      entityType: ENTITY_TYPES.TRAINING_RECORD,
      entityId: record.id,
      payload: remote
    }));
    await runtime.syncService.pushPending();
    const conflict = runtime.application.getState().conflicts.find(
      ({ entityType }) => entityType === ENTITY_TYPES.TRAINING_RECORD
    );
    return { ...runtime, operation, record, remote, conflict };
  }

  async function settingsFixture(label) {
    const provider = createDeterministicRemoteSyncProvider({
      ownerId: `anonymous_settings_${label}`,
      now: () => NOW
    });
    const runtime = createRuntime(provider);
    const settings = createSettingsApplicationService({
      repository: createSettingsRepository({ database: runtime.database, now: () => NOW })
    });
    settings.updateSettings({ defaultRestSeconds: 95 }, runtime.database.load().settings.revision);
    enableForConflict(runtime.database);
    const before = runtime.database.load();
    const operation = before.sync.outbox.find(({ entityType }) => entityType === ENTITY_TYPES.USER_SETTINGS);
    const remote = {
      ...structuredClone(before.settings),
      defaultRestSeconds: 80,
      cloudSyncEnabled: true,
      revision: before.settings.revision + 2
    };
    provider.conflictOperation(operation.opId, remoteEnvelope({
      entityType: ENTITY_TYPES.USER_SETTINGS,
      entityId: 'settings',
      payload: remote
    }));
    await runtime.syncService.pushPending();
    const conflict = runtime.application.getState().conflicts.find(
      ({ entityType }) => entityType === ENTITY_TYPES.USER_SETTINGS
    );
    return { ...runtime, operation, remote, conflict };
  }

  await t.test('plan keep_remote consumes the exact op and applies remote', async () => {
    const fixture = await planFixture('keep_remote');
    assert.deepEqual(fixture.conflict.actions, ['keep_remote', 'keep_local_as_copy', 'rebase']);
    await fixture.application.resolveConflict({
      conflictId: fixture.conflict.conflictId,
      action: 'keep_remote'
    });
    const after = fixture.database.load();
    assert.equal(after.plans.find(({ id }) => id === fixture.plan.id).title, fixture.remote.title);
    assert.equal(after.sync.outbox.some(({ opId }) => opId === fixture.operation.opId), false);
  });

  await t.test('plan rebase preserves local and exact opId at the remote base', async () => {
    const fixture = await planFixture('rebase');
    await fixture.application.resolveConflict({
      conflictId: fixture.conflict.conflictId,
      action: 'rebase'
    });
    const after = fixture.database.load();
    assert.equal(after.plans.find(({ id }) => id === fixture.plan.id).title, fixture.plan.title);
    const operation = after.sync.outbox.find(({ opId }) => opId === fixture.operation.opId);
    assert.equal(operation.baseServerRevision, 3);
  });

  await t.test('record keep_remote consumes the exact op and applies remote', async () => {
    const fixture = await recordFixture('keep_remote');
    assert.deepEqual(fixture.conflict.actions, ['keep_remote', 'keep_local_as_copy', 'rebase']);
    await fixture.application.resolveConflict({
      conflictId: fixture.conflict.conflictId,
      action: 'keep_remote'
    });
    const after = fixture.database.load();
    assert.equal(after.records.find(({ id }) => id === fixture.record.id).feedback.note, '云端记录 keep_remote');
    assert.equal(after.sync.outbox.some(({ opId }) => opId === fixture.operation.opId), false);
  });

  await t.test('record rebase preserves local and exact opId at the remote base', async () => {
    const fixture = await recordFixture('rebase');
    await fixture.application.resolveConflict({
      conflictId: fixture.conflict.conflictId,
      action: 'rebase'
    });
    const after = fixture.database.load();
    assert.equal(after.records.find(({ id }) => id === fixture.record.id).feedback, null);
    const operation = after.sync.outbox.find(({ opId }) => opId === fixture.operation.opId);
    assert.equal(operation.baseServerRevision, 3);
  });

  await t.test('settings keep_remote consumes the exact op and applies remote', async () => {
    const fixture = await settingsFixture('keep_remote');
    assert.deepEqual(fixture.conflict.actions, ['keep_remote', 'rebase']);
    await fixture.application.resolveConflict({
      conflictId: fixture.conflict.conflictId,
      action: 'keep_remote'
    });
    const after = fixture.database.load();
    assert.equal(after.settings.defaultRestSeconds, 80);
    assert.equal(after.sync.outbox.some(({ opId }) => opId === fixture.operation.opId), false);
  });

  await t.test('settings rebase preserves the local field on the exact op', async () => {
    const fixture = await settingsFixture('rebase');
    await fixture.application.resolveConflict({
      conflictId: fixture.conflict.conflictId,
      action: 'rebase'
    });
    const after = fixture.database.load();
    assert.equal(after.settings.defaultRestSeconds, 95);
    const operation = after.sync.outbox.find(({ opId }) => opId === fixture.operation.opId);
    assert.equal(operation.baseServerRevision, 3);
  });
});
