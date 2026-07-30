const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { StorageDouble } = require('../helpers/storage-double');
const { DEFAULT_USER_SETTINGS } = require('../../miniprogram/utils/constants');
const {
  createSettingsApplicationService
} = require('../../miniprogram/application/settings-application-service');

const ROOT = path.join(__dirname, '..', '..');
const SLOT_A = 'train_flow:v1:db:a';
const SLOT_B = 'train_flow:v1:db:b';
const ACTIVE = 'train_flow:v1:db:active';
const STORAGE_KEY_PATTERN = /train_flow:v1:(?:db:(?:active|a|b)|install)/g;
const WX_WRITE_PATTERN = /wx\.(?:setStorage|setStorageSync)\s*\(/;

function loadPersistenceContract() {
  const localDatabaseModule = require('../../miniprogram/services/local-database');
  const settingsRepositoryModule = require(
    '../../miniprogram/domain/identity-settings/settings-repository'
  );
  const createLocalDatabase =
    localDatabaseModule.createLocalDatabase ||
    ((options) => new localDatabaseModule.LocalDatabase(options));
  const createSettingsRepository =
    settingsRepositoryModule.createSettingsRepository ||
    ((options) => new settingsRepositoryModule.SettingsRepository(options));

  assert.equal(typeof createLocalDatabase, 'function');
  assert.equal(typeof createSettingsRepository, 'function');
  return { createLocalDatabase, createSettingsRepository };
}

function createPersistentService(storage) {
  const { createLocalDatabase, createSettingsRepository } = loadPersistenceContract();
  const database = createLocalDatabase({ storage, now: () => 1785719340000 });
  const repository = createSettingsRepository({ database });
  const service = createSettingsApplicationService({ repository });
  return { database, repository, service };
}

function walkJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

test('Attack: settings 必须穿过 application service 与持久化 repository，重建全部对象后仍能恢复', () => {
  const storage = new StorageDouble();
  const firstRuntime = createPersistentService(storage);
  const updated = firstRuntime.service.updateSettings(
    { soundEnabled: false, defaultRestSeconds: 95 },
    DEFAULT_USER_SETTINGS.revision
  );

  const restartedRuntime = createPersistentService(storage);
  const reloaded = restartedRuntime.service.getSettings();

  assert.deepEqual(reloaded, updated);
  assert.equal(reloaded.soundEnabled, false);
  assert.equal(reloaded.defaultRestSeconds, 95);
  assert.equal(reloaded.revision, DEFAULT_USER_SETTINGS.revision + 1);
  assert.ok(storage.peek(ACTIVE) === 'a' || storage.peek(ACTIVE) === 'b');
  assert.ok(storage.peek(SLOT_A) || storage.peek(SLOT_B));
});

test('Attack: 两个并发 settings writer 使用同一 expected revision 时只能成功一个，失败者不得覆盖赢家', () => {
  const storage = new StorageDouble();
  const writerOne = createPersistentService(storage).service;
  const writerTwo = createPersistentService(storage).service;
  const sharedRevision = writerOne.getSettings().revision;

  const winner = writerOne.updateSettings({ vibrationEnabled: false }, sharedRevision);
  assert.throws(
    () => writerTwo.updateSettings({ soundEnabled: false }, sharedRevision),
    /revision conflict|expected .* actual/i
  );

  const persisted = createPersistentService(storage).service.getSettings();
  assert.deepEqual(persisted, winner);
  assert.equal(persisted.vibrationEnabled, false);
  assert.equal(persisted.soundEnabled, DEFAULT_USER_SETTINGS.soundEnabled);
});

test('Attack: page 不能继续使用 memory stub，重载页面后必须从持久化 repository 读取设置', () => {
  const pageSource = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/settings/index.js'),
    'utf8'
  );

  assert.doesNotMatch(pageSource, /settings-repository-stub/);
  assert.match(pageSource, /settings-repository/);
});

test('Attack: LocalDatabase 是唯一 storage 写边界，任何 page/domain/application 直接 wx.setStorage 都必须失败', () => {
  const miniprogramRoot = path.join(ROOT, 'miniprogram');
  const localDatabasePath = path.join(miniprogramRoot, 'services', 'local-database.js');
  const violations = [];

  for (const file of walkJavaScriptFiles(miniprogramRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    if (file !== localDatabasePath && WX_WRITE_PATTERN.test(source)) {
      violations.push(path.relative(ROOT, file));
    }
  }

  assert.deepEqual(violations, [], `direct storage writes outside LocalDatabase: ${violations.join(', ')}`);
});

test('Attack: train_flow:v1 storage key 只能出现在 LocalDatabase，不能泄漏到 page 或普通 service', () => {
  const miniprogramRoot = path.join(ROOT, 'miniprogram');
  const localDatabasePath = path.join(miniprogramRoot, 'services', 'local-database.js');
  const keyOwners = [];

  for (const file of walkJavaScriptFiles(miniprogramRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    const matches = source.match(STORAGE_KEY_PATTERN) || [];
    if (matches.length > 0) {
      keyOwners.push({ file, matches });
    }
  }

  assert.ok(fs.existsSync(localDatabasePath), 'LocalDatabase module must own the storage key boundary');
  assert.ok(keyOwners.length > 0, 'LocalDatabase must define the canonical train_flow:v1 keys');
  assert.deepEqual(
    [...new Set(keyOwners.map(({ file }) => file))],
    [localDatabasePath],
    `storage keys leaked outside LocalDatabase: ${keyOwners
      .filter(({ file }) => file !== localDatabasePath)
      .map(({ file }) => path.relative(ROOT, file))
      .join(', ')}`
  );
  assert.deepEqual(
    new Set(keyOwners.flatMap(({ matches }) => matches)),
    new Set([SLOT_A, SLOT_B, ACTIVE, 'train_flow:v1:install'])
  );
});
