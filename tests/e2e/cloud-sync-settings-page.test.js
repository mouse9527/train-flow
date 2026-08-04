const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

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

test('an in-flight retry immediately renders the sanitized syncing state', async () => {
  const { createSettingsPageDefinition } = require('../../miniprogram/pages/settings/index');
  let phase = 'idle';
  let finishRetry;
  const pendingRetry = new Promise((resolve) => { finishRetry = resolve; });
  const sync = {
    getState() {
      return {
        enabled: true,
        code: phase === 'syncing' ? 'syncing' : 'waiting',
        label: phase === 'syncing' ? '同步中' : '等待 1 项',
        pendingCount: 1,
        lastSyncedAt: null,
        errorCode: null,
        conflicts: []
      };
    },
    retry() {
      phase = 'syncing';
      return pendingRetry;
    }
  };
  const page = pageHarness(createSettingsPageDefinition({
    settingsApplication: settingsApplication(),
    syncApplicationFactory: () => sync,
    getWx: () => wxDouble('release')
  }));

  page.onLoad({ section: 'cloud-sync' });
  const retry = page.onRetrySync();
  assert.equal(page.data.syncState.code, 'syncing');
  phase = 'idle';
  finishRetry({ ok: true, state: sync.getState() });
  await retry;
  assert.equal(page.data.syncState.code, 'waiting');
});

test('cloud sync renders only the closed status codes with Chinese labels and disable returns to 未启用', async () => {
  const { createSettingsPageDefinition } = require('../../miniprogram/pages/settings/index');
  const statuses = [
    ['disabled', '未启用', 0],
    ['waiting', '等待 3 项', 3],
    ['syncing', '同步中', 3],
    ['conflict', '冲突', 1],
    ['failure', '失败可重试', 2],
    ['synced', '已同步', 0]
  ];

  for (const [code, label, pendingCount] of statuses) {
    const sync = syncApplication({
      enabled: code !== 'disabled',
      code,
      label,
      pendingCount,
      lastSyncedAt: code === 'synced' ? 1785799900000 : null,
      errorCode: code === 'failure' ? 'CLOUD_SYNC_UNAVAILABLE' : null,
      conflicts: []
    });
    const page = pageHarness(createSettingsPageDefinition({
      settingsApplication: settingsApplication(),
      syncApplicationFactory: () => sync,
      getWx: () => wxDouble('release')
    }));

    page.onLoad({ section: 'cloud-sync' });
    assert.equal(page.data.syncState.code, code);
    assert.equal(page.data.syncState.label, label);
  }

  const enabledSync = syncApplication({
    enabled: true,
    code: 'waiting',
    label: '等待 2 项',
    pendingCount: 2,
    lastSyncedAt: null,
    errorCode: null,
    conflicts: []
  });
  const enabledPage = pageHarness(createSettingsPageDefinition({
    settingsApplication: settingsApplication(),
    syncApplicationFactory: () => enabledSync,
    getWx: () => wxDouble('release')
  }));
  enabledPage.onLoad({ section: 'cloud-sync' });
  await enabledPage.onDisableCloudSync();

  assert.deepEqual(enabledSync.calls.find(([name]) => name === 'disable'), ['disable']);
  assert.equal(enabledPage.data.syncState.code, 'disabled');
  assert.equal(enabledPage.data.syncState.label, '未启用');
  assert.equal(enabledPage.data.syncState.enabled, false);
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

test('cloud sync surface declares sanitized status, explicit conflict choices and distinct cloud purge copy', () => {
  const pageJson = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/settings/index.json'),
    'utf8'
  ));
  const pageWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/settings/index.wxml'),
    'utf8'
  );
  const componentWxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/components/sync-status/index.wxml'),
    'utf8'
  );
  const pageSource = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/settings/index.js'),
    'utf8'
  );
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  assert.equal(pageJson.usingComponents['sync-status'], '/components/sync-status/index');
  assert.match(pageWxml, /云同步/);
  assert.match(pageWxml, /sync-status/);
  assert.match(pageWxml, /启用云同步/);
  assert.match(pageWxml, /本机计划/);
  assert.match(pageWxml, /本机.*不.*删除|不会删除本机/);
  assert.match(pageWxml, /服务器.*绑定|服务器签发/);
  assert.match(pageWxml, /删除云端同步副本/);
  assert.match(pageWxml, /wx:if="\{\{!syncState\.enabled\}\}"[^>]*bindtap="onPrepareSyncEnable"/);
  assert.match(pageWxml, /wx:if="\{\{syncState\.enabled\}\}"[^>]*bindtap="onDisableCloudSync"/);
  assert.match(componentWxml, /state\.label/);
  assert.match(componentWxml, /本机.*正常|本机训练不受影响/);
  assert.match(componentWxml, /采用云端/);
  assert.match(componentWxml, /保留本机副本/);
  assert.match(componentWxml, /基于云端重试/);
  assert.doesNotMatch(pageSource, /wx\.cloud\.database|\.watch\s*\(/);
  for (const fixture of ['waiting', 'denied', 'conflict', 'purge']) {
    assert.match(readme, new RegExp(`pages/settings/index\\?section=cloud-sync&fixture=${fixture}`));
  }
  assert.match(readme, /develop/);
  assert.match(readme, /trial/);
  assert.match(readme, /release/);
});
