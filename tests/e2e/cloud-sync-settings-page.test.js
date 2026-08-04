const assert = require('node:assert/strict');
const test = require('node:test');

function settingsApplication() {
  return {
    getSettings() {
      return { revision: 1, cloudSyncEnabled: false };
    },
    updateSettings(patch) {
      return { revision: 2, cloudSyncEnabled: false, ...patch };
    }
  };
}

function syncApplication(initialState) {
  let state = JSON.parse(JSON.stringify(initialState));
  const calls = [];
  return {
    calls,
    getState() {
      calls.push(['getState']);
      return JSON.parse(JSON.stringify(state));
    },
    prepareEnable() {
      calls.push(['prepareEnable']);
      return {
        confirmationId: 'private-enable-confirmation',
        scope: { plans: 2, records: 3, settings: 1, pendingOperations: 4 },
        warning: 'preview warning'
      };
    },
    async confirmEnable(command) {
      calls.push(['confirmEnable', command]);
      state = { ...state, enabled: true, code: 'waiting', label: '等待 4 项', pendingCount: 4 };
      return { ok: true, state: this.getState() };
    },
    async disable() {
      calls.push(['disable']);
      state = { ...state, enabled: false, code: 'disabled', label: '未启用', pendingCount: 0 };
      return { ok: true, state: this.getState() };
    },
    async retry(command) {
      calls.push(['retry', command]);
      return { ok: false, state: this.getState() };
    },
    async resolveConflict(command) {
      calls.push(['resolveConflict', command]);
      state = { ...state, code: 'waiting', label: '等待 1 项', conflicts: [] };
      return { conflictId: command.conflictId, action: command.action };
    },
    async prepareRemotePurge() {
      calls.push(['prepareRemotePurge']);
      return { confirmationToken: 'private-server-bound-confirmation', expiresAt: 1785800000000 };
    },
    async purgeRemote(command) {
      calls.push(['purgeRemote', command]);
      return { purgedAt: 1785799900000 };
    }
  };
}

function pageHarness(definition) {
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) {
      this.data = { ...this.data, ...patch };
    }
  };
}

function wxDouble(envVersion = 'develop') {
  const modals = [];
  return {
    modals,
    getAccountInfoSync() {
      return { miniProgram: { envVersion } };
    },
    showModal(options) {
      modals.push(options);
      options.success({ confirm: true });
    }
  };
}

test('cloud sync settings keeps enable and purge confirmations private while forwarding explicit commands', async () => {
  const { createSettingsPageDefinition } = require('../../miniprogram/pages/settings/index');
  const sync = syncApplication({
    enabled: false,
    code: 'disabled',
    label: '未启用',
    pendingCount: 0,
    lastSyncedAt: null,
    errorCode: null,
    conflicts: []
  });
  const wxApi = wxDouble();
  const page = pageHarness(createSettingsPageDefinition({
    settingsApplication: settingsApplication(),
    syncApplicationFactory: () => sync,
    fixtureSyncApplicationFactory: () => sync,
    getWx: () => wxApi
  }));

  page.onLoad({ section: 'cloud-sync' });
  await page.onPrepareSyncEnable();
  assert.equal(page._syncEnableConfirmationId, 'private-enable-confirmation');
  assert.equal(JSON.stringify(page.data).includes('private-enable-confirmation'), false);
  assert.deepEqual(page.data.syncEnablePreview.scope, {
    plans: 2,
    records: 3,
    settings: 1,
    pendingOperations: 4
  });

  await page.onConfirmSyncEnable();
  assert.deepEqual(sync.calls.find(([name]) => name === 'confirmEnable'), [
    'confirmEnable',
    { confirmationId: 'private-enable-confirmation' }
  ]);

  await page.onPrepareCloudPurge();
  assert.equal(page._remotePurgeConfirmationToken, 'private-server-bound-confirmation');
  assert.equal(JSON.stringify(page.data).includes('private-server-bound-confirmation'), false);
  await page.onConfirmCloudPurge();
  assert.deepEqual(sync.calls.find(([name]) => name === 'purgeRemote'), [
    'purgeRemote',
    { confirmationToken: 'private-server-bound-confirmation' }
  ]);
  assert.deepEqual(page.data.cloudPurgeReceipt, { purgedAt: 1785799900000 });
  assert.equal(page.data.settings.cloudSyncEnabled, false, 'cloud purge must not delete or rewrite local settings');
});

test('manual and automatic recovery use retry with distinct source labels and conflicts require a chosen action', async () => {
  const { createSettingsPageDefinition } = require('../../miniprogram/pages/settings/index');
  const sync = syncApplication({
    enabled: true,
    code: 'conflict',
    label: '冲突',
    pendingCount: 1,
    lastSyncedAt: null,
    errorCode: null,
    conflicts: [{
      conflictId: 'conflict-plan-1',
      entityType: 'workout_plan',
      entityId: 'plan-1',
      localSummary: '本机：力量训练 · 2026-08-04',
      remoteSummary: '云端：恢复训练 · 2026-08-04',
      actions: ['keep_remote', 'keep_local_as_copy', 'rebase']
    }]
  });
  const page = pageHarness(createSettingsPageDefinition({
    settingsApplication: settingsApplication(),
    syncApplicationFactory: () => sync,
    fixtureSyncApplicationFactory: () => sync,
    getWx: () => wxDouble('release')
  }));

  page.onLoad({ section: 'cloud-sync', fixture: 'conflict' });
  await page.onRetrySync();
  await page.onResolveSyncConflict({
    currentTarget: { dataset: { conflictId: 'conflict-plan-1', action: 'keep_local_as_copy' } }
  });
  page.setData({ syncState: { ...page.data.syncState, enabled: true, code: 'waiting' } });
  page._skipNextSyncShow = false;
  await page.onShow();

  assert.deepEqual(sync.calls.filter(([name]) => name === 'retry'), [
    ['retry', { source: 'manual' }],
    ['retry', { source: 'automatic' }]
  ]);
  assert.deepEqual(sync.calls.find(([name]) => name === 'resolveConflict'), [
    'resolveConflict',
    { conflictId: 'conflict-plan-1', action: 'keep_local_as_copy' }
  ]);
});

test('developer fixtures are anonymous and develop-only while trial and release use production state', () => {
  const {
    createSettingsPageDefinition,
    developerSyncFixturesEnabled
  } = require('../../miniprogram/pages/settings/index');
  const fixtureCalls = [];
  const productionCalls = [];
  const make = (envVersion) => pageHarness(createSettingsPageDefinition({
    settingsApplication: settingsApplication(),
    syncApplicationFactory() {
      productionCalls.push(envVersion);
      return syncApplication({ enabled: false, code: 'disabled', label: '未启用', pendingCount: 0, conflicts: [] });
    },
    fixtureSyncApplicationFactory(state) {
      fixtureCalls.push([envVersion, state]);
      return syncApplication({ enabled: true, code: state, label: state, pendingCount: 2, conflicts: [] });
    },
    getWx: () => wxDouble(envVersion)
  }));

  for (const envVersion of ['release', 'trial']) {
    make(envVersion).onLoad({ section: 'cloud-sync', fixture: 'denied' });
  }
  make('develop').onLoad({ section: 'cloud-sync', fixture: 'denied' });

  assert.equal(developerSyncFixturesEnabled(wxDouble('develop')), true);
  assert.equal(developerSyncFixturesEnabled(wxDouble('trial')), false);
  assert.deepEqual(productionCalls, ['release', 'trial']);
  assert.deepEqual(fixtureCalls, [['develop', 'denied']]);
});
