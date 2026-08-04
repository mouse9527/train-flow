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

  const manual = await application.retry({ source: 'manual' });
  assert.equal(manual.ok, true);
  assert.deepEqual(database.load().sync.outbox, []);
  assert.deepEqual(
    provider.calls.push.slice(0, 2).map(({ operations }) => operations.map(({ opId }) => opId)),
    [pendingOpIds, pendingOpIds],
    'lost response retry must send the exact same operation identities'
  );
  const afterManualPushCount = provider.calls.push.length;
  const automatic = await application.retry({ source: 'automatic' });
  assert.equal(automatic.ok, true);
  assert.equal(provider.calls.push.length, afterManualPushCount, 'empty automatic retry must not invent work');
  assert.equal(application.getState().code, 'synced');
  assert.equal(application.getState().label, '已同步');

  const remote = await provider.pull({ cursor: null, limit: 100 });
  assert.equal(remote.changes.length, 2, 'remote contains one plan and one settings entity only');
  assert.equal(new Set(remote.changes.map(({ entityId }) => entityId)).size, 2);
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
