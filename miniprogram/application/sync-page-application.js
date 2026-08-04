const { createSyncApplicationService } = require('./sync-application-service');
const { createCloudBaseSyncProvider } = require('../services/cloudbase-sync-provider');
const { createLocalDatabase } = require('../services/local-database');
const { createSyncService } = require('../services/sync-service');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function unavailableError() {
  const error = new Error('Cloud sync is unavailable');
  error.code = 'CLOUD_SYNC_UNAVAILABLE';
  return error;
}

function createUnavailableProvider() {
  return {
    async bootstrap() { throw unavailableError(); },
    async push() { throw unavailableError(); },
    async pull() { throw unavailableError(); },
    async preparePurge() { throw unavailableError(); },
    async purge() { throw unavailableError(); }
  };
}

function createProductionSyncApplication({ wx: wxApi } = {}) {
  let provider;
  try {
    provider = createCloudBaseSyncProvider({ wx: wxApi });
  } catch (_error) {
    provider = createUnavailableProvider();
  }
  return createSyncApplicationService({
    syncService: createSyncService({
      database: createLocalDatabase(),
      provider
    })
  });
}

function fixtureState(name) {
  const base = {
    enabled: true,
    pendingCount: 0,
    lastSyncedAt: 1785799800000,
    errorCode: null,
    conflicts: []
  };
  if (name === 'denied') {
    return {
      ...base,
      code: 'failure',
      label: '失败可重试',
      pendingCount: 3,
      lastSyncedAt: null,
      errorCode: 'SYNC_ACCESS_DENIED'
    };
  }
  if (name === 'conflict') {
    return {
      ...base,
      code: 'conflict',
      label: '冲突',
      pendingCount: 1,
      conflicts: [{
        conflictId: 'fixture-plan-conflict',
        entityType: 'workout_plan',
        entityId: 'fixture-plan',
        status: 'open',
        localSummary: '本机：晨间力量 · 2026-08-04',
        remoteSummary: '云端：恢复训练 · 2026-08-04',
        actions: ['keep_remote', 'keep_local_as_copy', 'rebase']
      }]
    };
  }
  if (name === 'purge') {
    return { ...base, code: 'synced', label: '已同步' };
  }
  return {
    ...base,
    code: 'waiting',
    label: '等待 3 项',
    pendingCount: 3,
    lastSyncedAt: null
  };
}

function createDeveloperSyncApplication(name = 'waiting', { now = Date.now } = {}) {
  let state = fixtureState(name);
  return {
    getState() {
      return cloneJson(state);
    },

    prepareEnable() {
      return {
        confirmationId: 'fixture-enable-confirmation',
        scope: { plans: 2, records: 3, settings: 1, pendingOperations: 3 },
        warning: '将把匿名夹具中的本机计划、训练记录和设置加入同步。'
      };
    },

    async confirmEnable() {
      state = fixtureState('waiting');
      return { ok: true, state: cloneJson(state) };
    },

    async disable() {
      state = {
        enabled: false,
        code: 'disabled',
        label: '未启用',
        pendingCount: 0,
        lastSyncedAt: null,
        errorCode: null,
        conflicts: []
      };
      return { ok: true, state: cloneJson(state) };
    },

    async retry() {
      if (name !== 'denied' && state.conflicts.length === 0) {
        state = { ...state, code: 'synced', label: '已同步', pendingCount: 0, lastSyncedAt: now() };
      }
      return { ok: name !== 'denied', state: cloneJson(state) };
    },

    async resolveConflict({ conflictId, action }) {
      state = {
        ...state,
        code: 'waiting',
        label: '等待 1 项',
        conflicts: state.conflicts.filter((conflict) => conflict.conflictId !== conflictId)
      };
      return { conflictId, action, resolvedAt: now(), copyEntityId: action === 'keep_local_as_copy' ? 'fixture-copy' : null };
    },

    async prepareRemotePurge() {
      return { confirmationToken: 'fixture-server-confirmation', expiresAt: now() + 300000 };
    },

    async purgeRemote() {
      return { purgedAt: now() };
    }
  };
}

module.exports = {
  createDeveloperSyncApplication,
  createProductionSyncApplication
};
