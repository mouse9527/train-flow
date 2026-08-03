const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PRIVATE_EXPORT_JSON = '{"privateTrainingPayload":"EXPORT_PRIVATE_5f1d"}';
const PRIVATE_IMPORT_JSON = '{"privateTrainingPayload":"IMPORT_PRIVATE_0ac7"}';

function maybePromise(value) {
  return value && typeof value.then === 'function' ? value : Promise.resolve(value);
}

function loadServiceContract(options) {
  const serviceModule = require('../../miniprogram/application/settings-application-service');
  const factory =
    serviceModule.createSettingsDataApplicationService ||
    serviceModule.createSettingsApplicationService;
  assert.equal(typeof factory, 'function', 'settings application module must expose a service factory');
  const service = factory(options);
  for (const method of [
    'createExportPreview',
    'copyExportToClipboard',
    'previewImport',
    'confirmImport',
    'prepareLocalClear',
    'confirmLocalClear'
  ]) {
    assert.equal(typeof service[method], 'function', `settings data service must expose ${method}()`);
  }
  return service;
}

function createServiceHarness() {
  const calls = [];
  const database = {
    exportPortableBackup() {
      calls.push({ type: 'export' });
      return {
        jsonText: PRIVATE_EXPORT_JSON,
        summary: { plans: 2, records: 3, bytes: Buffer.byteLength(PRIVATE_EXPORT_JSON), checksumPrefix: 'abcd1234' }
      };
    },
    previewPortableImport(jsonText) {
      calls.push({ type: 'preview-import', jsonText });
      return {
        confirmationId: 'import-confirmation',
        packageVersion: 1,
        appSchemaVersion: 1,
        checksumPrefix: 'abcd1234',
        expiresAt: 1785719640000,
        baselineLocalRevision: 4,
        counts: { plans: 2, records: 3 },
        changes: {
          plans: { added: 1, changed: 0, unchanged: 1, removed: 0 },
          records: { added: 3, changed: 0, unchanged: 0, removed: 0 }
        },
        warnings: ['导入只影响本机；不会删除云端数据']
      };
    },
    applyPortableImport(jsonText, confirmationId) {
      calls.push({ type: 'apply-import', jsonText, confirmationId });
      return { applied: true, snapshot: { localRevision: 5 } };
    },
    prepareLocalPurge() {
      calls.push({ type: 'prepare-clear' });
      return {
        confirmationId: 'clear-confirmation',
        counts: { plans: 2, records: 3 },
        hasPendingSync: true,
        warnings: ['未同步变更会从本机移除；云端内容不会删除']
      };
    },
    applyLocalPurge(confirmationId) {
      calls.push({ type: 'apply-clear', confirmationId });
      return { purged: true, snapshot: { plans: [], records: [] }, cleanupPending: false };
    }
  };
  const repository = {
    load() {
      return {
        schemaVersion: 1,
        revision: 1,
        vibrationEnabled: true,
        soundEnabled: true,
        voiceEnabled: false,
        keepScreenOn: true,
        defaultStartLocalTime: '08:35',
        recommendedEndLocalTime: '09:10',
        defaultRestSeconds: 75,
        timezone: 'Asia/Shanghai',
        cloudSyncEnabled: false
      };
    },
    save(value) { return value; }
  };
  const clipboardWrites = [];
  const wxApi = {
    setClipboardData({ data, success }) {
      clipboardWrites.push(data);
      if (success) success();
    }
  };
  return {
    calls,
    clipboardWrites,
    service: loadServiceContract({ database, repository, wx: wxApi, clipboard: wxApi })
  };
}

function replaceRequireCache(modulePath, exports) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: [],
    paths: []
  };
  return () => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  };
}

function loadSettingsPage(fakeService) {
  const pagePath = require.resolve('../../miniprogram/pages/settings/index');
  const servicePath = require.resolve('../../miniprogram/application/settings-application-service');
  const repositoryPath = require.resolve('../../miniprogram/domain/identity-settings/settings-repository');
  const databasePath = require.resolve('../../miniprogram/services/local-database');
  const restores = [
    replaceRequireCache(servicePath, {
      createSettingsApplicationService() { return fakeService; },
      createSettingsDataApplicationService() { return fakeService; }
    }),
    replaceRequireCache(repositoryPath, { createSettingsRepository() { return {}; } }),
    replaceRequireCache(databasePath, { createLocalDatabase() { return {}; } })
  ];
  const previousPage = global.Page;
  let definition = null;
  global.Page = (candidate) => { definition = candidate; };
  delete require.cache[pagePath];
  try {
    require(pagePath);
  } finally {
    if (previousPage === undefined) delete global.Page;
    else global.Page = previousPage;
    delete require.cache[pagePath];
    restores.reverse().forEach((restore) => restore());
  }
  assert.ok(definition, 'settings page must register through Page()');
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) {
      this.data = { ...this.data, ...patch };
    }
  };
}

test('[C] Attack: application service 不得向返回值/日志泄露完整 JSON，复制必须二次动作且单次消费', async () => {
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  const logs = [];
  for (const level of Object.keys(originalConsole)) {
    console[level] = (...args) => logs.push({ level, text: args.map(String).join(' ') });
  }
  try {
    const { service, calls, clipboardWrites } = createServiceHarness();
    const preview = await maybePromise(service.createExportPreview());

    assert.deepEqual(clipboardWrites, [], 'generating a backup must not copy automatically');
    assert.deepEqual(calls.map(({ type }) => type), ['export']);
    assert.ok(preview.confirmationId, 'copy requires an explicit confirmation id');

    await maybePromise(service.copyExportToClipboard(preview.confirmationId));
    assert.deepEqual(clipboardWrites, [PRIVATE_EXPORT_JSON]);
    assert.equal(logs.some(({ text }) => text.includes(PRIVATE_EXPORT_JSON)), false);
    await assert.rejects(
      Promise.resolve().then(() => service.copyExportToClipboard(preview.confirmationId)),
      /consumed|confirmation|expired|missing/i
    );
  } finally {
    Object.assign(console, originalConsole);
  }
});

test('[F4] Attack: one-argument copy 必须复制 preview 同一份私有 JSON，禁止重新 export 后 digest 漂移', async () => {
  const firstJson = '{"privateTrainingPayload":"FIRST_EXPORT_7de2","exportedAt":1785719340000}';
  const regeneratedJson = '{"privateTrainingPayload":"REGENERATED_EXPORT_4c6f","exportedAt":1785719340001}';
  let exportCalls = 0;
  const database = {
    exportPortableBackup() {
      exportCalls += 1;
      const jsonText = exportCalls === 1 ? firstJson : regeneratedJson;
      return {
        jsonText,
        summary: {
          plans: 0,
          records: 0,
          bytes: Buffer.byteLength(jsonText),
          checksumPrefix: exportCalls === 1 ? 'first7de' : 'regen4c6'
        }
      };
    }
  };
  const clipboardWrites = [];
  const wxApi = {
    setClipboardData({ data, success }) {
      clipboardWrites.push(data);
      if (success) success();
    }
  };
  const repository = { load() { return {}; }, save(value) { return value; } };
  const service = loadServiceContract({ database, repository, wx: wxApi, clipboard: wxApi });

  const preview = await maybePromise(service.createExportPreview());
  await maybePromise(service.copyExportToClipboard(preview.confirmationId));

  assert.equal(exportCalls, 1, 'copy must reuse the private preview payload instead of regenerating');
  assert.deepEqual(clipboardWrites, [firstJson]);
  await assert.rejects(
    Promise.resolve().then(() => service.copyExportToClipboard(preview.confirmationId)),
    /consumed|confirmation|expired|missing/i
  );
  assert.equal(exportCalls, 1, 'consumed confirmation must not regenerate or retain a reusable payload');
  assert.deepEqual(clipboardWrites, [firstJson]);
});

test('[C] Attack: service import/clear 只传递私有 payload，不把内容塞进 preview，并保持本机/云端边界', async () => {
  const { service, calls } = createServiceHarness();

  const importPreview = await maybePromise(service.previewImport(PRIVATE_IMPORT_JSON));
  assert.equal(JSON.stringify(importPreview).includes(PRIVATE_IMPORT_JSON), false);
  assert.deepEqual(calls.at(-1), { type: 'preview-import', jsonText: PRIVATE_IMPORT_JSON });
  await maybePromise(service.confirmImport(PRIVATE_IMPORT_JSON, importPreview.confirmationId));
  assert.deepEqual(calls.at(-1), {
    type: 'apply-import',
    jsonText: PRIVATE_IMPORT_JSON,
    confirmationId: 'import-confirmation'
  });

  const clearPreview = await maybePromise(service.prepareLocalClear());
  assert.equal(clearPreview.hasPendingSync, true);
  assert.match(clearPreview.warnings.join(' '), /未同步/);
  assert.match(clearPreview.warnings.join(' '), /云端.*不.*删除|不会删除云端/);
  await maybePromise(service.confirmLocalClear(clearPreview.confirmationId));
  assert.deepEqual(calls.at(-1), { type: 'apply-clear', confirmationId: 'clear-confirmation' });
  assert.equal(calls.some(({ type }) => /cloud|remote|push|purge-account/.test(type)), false);
});

test('[C] Attack: settings data 页面必须展示隐私、preview、仅清除本机与不会删除云端的明确文案', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/index.wxml'), 'utf8');

  assert.match(wxml, /数据备份/);
  assert.match(wxml, /私人|隐私/);
  assert.match(wxml, /训练数据/);
  assert.match(wxml, /导入/);
  assert.match(wxml, /预览/);
  assert.match(wxml, /仅清除本机数据/);
  assert.match(wxml, /不会删除云端数据/);
  assert.match(wxml, /生成备份/);
  assert.match(wxml, /复制 JSON/);
  assert.doesNotMatch(wxml, />\s*确定\s*</, 'destructive second confirmation must not use generic 确定 copy');
});

test('[C] Attack: page 只能经 application service 操作数据，不得直接 storage/clipboard 或 console payload', () => {
  const source = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/settings/index.js'), 'utf8');

  assert.match(source, /settings-application-service/);
  assert.doesNotMatch(source, /wx\.(?:getStorage|setStorage|removeStorage)/);
  assert.doesNotMatch(source, /wx\.setClipboardData/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/);
});

test('[C] Attack: page 的完整导入 JSON 只能短驻 controller 私有字段，绝不能进入可渲染 data', async () => {
  const calls = [];
  const fakeService = {
    getSettings() { return { revision: 1 }; },
    updateSettings(value) { return { revision: 2, ...value }; },
    createExportPreview() {
      calls.push({ type: 'export-preview' });
      return {
        confirmationId: 'copy-id',
        jsonText: PRIVATE_EXPORT_JSON,
        summary: { plans: 1, records: 1 },
        privacyWarning: '包含私人训练数据'
      };
    },
    copyExportToClipboard(...args) {
      calls.push({ type: 'copy', confirmationId: args[0], argumentCount: args.length });
      return { copied: true };
    },
    previewImport(jsonText) {
      calls.push({ type: 'preview-import', jsonText });
      return { confirmationId: 'import-id', counts: { plans: 1, records: 1 }, warnings: [] };
    },
    confirmImport(jsonText, confirmationId) {
      calls.push({ type: 'confirm-import', jsonText, confirmationId });
      return { applied: true };
    },
    prepareLocalClear() {
      calls.push({ type: 'prepare-clear' });
      return { confirmationId: 'clear-id', counts: { plans: 1, records: 1 }, warnings: ['不会删除云端数据'] };
    },
    confirmLocalClear(confirmationId) {
      calls.push({ type: 'confirm-clear', confirmationId });
      return { purged: true };
    }
  };
  const page = loadSettingsPage(fakeService);
  for (const method of [
    'onGenerateBackup',
    'onCopyBackup',
    'onImportInput',
    'onPreviewImport',
    'onConfirmImport',
    'onPrepareLocalClear',
    'onConfirmLocalClear',
    'onUnload'
  ]) {
    assert.equal(typeof page[method], 'function', `settings data page must expose ${method}`);
  }

  await maybePromise(page.onLoad({ section: 'data' }));
  assert.equal(page.data.section, 'data');
  await maybePromise(page.onGenerateBackup());
  assert.equal(JSON.stringify(page.data).includes(PRIVATE_EXPORT_JSON), false);
  await maybePromise(page.onCopyBackup());
  assert.deepEqual(calls.at(-1), { type: 'copy', confirmationId: 'copy-id', argumentCount: 1 });
  assert.equal(JSON.stringify(page).includes(PRIVATE_EXPORT_JSON), false, 'successful copy must clear private export reference');
  page.onImportInput({ detail: { value: PRIVATE_IMPORT_JSON } });
  assert.equal(JSON.stringify(page.data).includes(PRIVATE_IMPORT_JSON), false, 'raw JSON entered renderable data');
  await maybePromise(page.onPreviewImport());
  assert.deepEqual(calls.at(-1), { type: 'preview-import', jsonText: PRIVATE_IMPORT_JSON });
  await maybePromise(page.onConfirmImport());
  assert.deepEqual(calls.at(-1), {
    type: 'confirm-import',
    jsonText: PRIVATE_IMPORT_JSON,
    confirmationId: 'import-id'
  });
  assert.equal(JSON.stringify(page).includes(PRIVATE_IMPORT_JSON), false, 'successful import must clear private input reference');
  await maybePromise(page.onPrepareLocalClear());
  await maybePromise(page.onConfirmLocalClear());
  assert.deepEqual(calls.at(-1), { type: 'confirm-clear', confirmationId: 'clear-id' });

  page.onUnload();
  assert.equal(JSON.stringify(page).includes(PRIVATE_IMPORT_JSON), false, 'unload must clear private import text');
});

test('[F4] Attack: pending sync 的最终本机清除 modal 必须四字按钮并明确未同步变更会丢失', async (t) => {
  const calls = [];
  let modalOptions = null;
  const fakeService = {
    getSettings() { return { revision: 1 }; },
    updateSettings(value) { return value; },
    createExportPreview() { throw new Error('not used'); },
    copyExportToClipboard() { throw new Error('not used'); },
    previewImport() { throw new Error('not used'); },
    confirmImport() { throw new Error('not used'); },
    prepareLocalClear() {
      return {
        confirmationId: 'pending-clear-id',
        counts: { plans: 2, records: 3 },
        hasPendingSync: true,
        warnings: ['未同步变更会从本机移除；不会删除云端数据']
      };
    },
    confirmLocalClear(confirmationId) {
      calls.push({ type: 'confirm-clear', confirmationId });
      return { purged: true };
    }
  };
  const previousWx = global.wx;
  global.wx = {
    showModal(options) {
      modalOptions = options;
      options.success({ confirm: true, cancel: false });
    },
    showToast() {}
  };
  try {
    const page = loadSettingsPage(fakeService);
    await maybePromise(page.onLoad({ section: 'data' }));
    await maybePromise(page.onPrepareLocalClear());
    await maybePromise(page.onConfirmLocalClear());

    assert.ok(modalOptions, 'final destructive action must use a real modal contract');
    await t.test('confirmText respects the four-character API limit', () => {
      assert.ok(Array.from(modalOptions.confirmText || '').length <= 4, 'wx.showModal confirmText supports at most four characters');
    });
    await t.test('final body repeats pending-sync loss and cloud boundary', () => {
      assert.match(modalOptions.content, /未同步[\s\S]*(?:丢失|移除|删除)/);
      assert.match(modalOptions.content, /不会删除云端/);
    });
    assert.deepEqual(calls, [{ type: 'confirm-clear', confirmationId: 'pending-clear-id' }]);
  } finally {
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});
