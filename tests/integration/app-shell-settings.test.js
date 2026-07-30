const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSettingsApplicationService
} = require('../../miniprogram/application/settings-application-service');
const { DEFAULT_USER_SETTINGS } = require('../../miniprogram/utils/constants');

function createInMemoryRepository(initial) {
  let state = initial ? { ...initial } : null;
  return {
    load() {
      return state ? { ...state } : null;
    },
    save(settings, expectedRevision) {
      const actualRevision = state ? state.revision : DEFAULT_USER_SETTINGS.revision;
      if (expectedRevision !== actualRevision) {
        throw new Error(`Settings revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
      }
      state = { ...settings };
      return { ...state };
    }
  };
}

test('getSettings returns schema defaults when no settings are persisted yet', () => {
  const service = createSettingsApplicationService({ repository: createInMemoryRepository(null) });

  const settings = service.getSettings();

  assert.deepEqual(settings, DEFAULT_USER_SETTINGS);
});

test('updateSettings persists a valid partial change and bumps revision', () => {
  const repository = createInMemoryRepository(DEFAULT_USER_SETTINGS);
  const service = createSettingsApplicationService({ repository });

  const updated = service.updateSettings(
    { vibrationEnabled: false, defaultRestSeconds: 90 },
    DEFAULT_USER_SETTINGS.revision
  );

  assert.equal(updated.vibrationEnabled, false);
  assert.equal(updated.defaultRestSeconds, 90);
  assert.equal(updated.revision, DEFAULT_USER_SETTINGS.revision + 1);
  assert.deepEqual(repository.load(), updated);
});

test('updateSettings rejects defaultRestSeconds outside the allowed range', () => {
  const service = createSettingsApplicationService({ repository: createInMemoryRepository(DEFAULT_USER_SETTINGS) });

  assert.throws(
    () => service.updateSettings({ defaultRestSeconds: -5 }, DEFAULT_USER_SETTINGS.revision),
    /defaultRestSeconds/
  );
  assert.throws(
    () => service.updateSettings({ defaultRestSeconds: 999 }, DEFAULT_USER_SETTINGS.revision),
    /defaultRestSeconds/
  );
});

test('updateSettings rejects unknown fields so pages cannot smuggle arbitrary state', () => {
  const service = createSettingsApplicationService({ repository: createInMemoryRepository(DEFAULT_USER_SETTINGS) });

  assert.throws(
    () => service.updateSettings({ openId: 'oX123' }, DEFAULT_USER_SETTINGS.revision),
    /Unknown settings field/
  );
});

test('updateSettings rejects non-boolean values for boolean fields', () => {
  const service = createSettingsApplicationService({ repository: createInMemoryRepository(DEFAULT_USER_SETTINGS) });

  assert.throws(
    () => service.updateSettings({ soundEnabled: 'yes' }, DEFAULT_USER_SETTINGS.revision),
    /soundEnabled/
  );
});

test('updateSettings rejects a stale expected revision without overwriting newer settings', () => {
  const repository = createInMemoryRepository(DEFAULT_USER_SETTINGS);
  const service = createSettingsApplicationService({ repository });

  const firstUpdate = service.updateSettings(
    { soundEnabled: false },
    DEFAULT_USER_SETTINGS.revision
  );

  assert.throws(
    () => service.updateSettings({ vibrationEnabled: false }, DEFAULT_USER_SETTINGS.revision),
    /Settings revision conflict: expected 1, actual 2/
  );
  assert.deepEqual(repository.load(), firstUpdate);
});

test('updateSettings requires an integer expected revision', () => {
  const service = createSettingsApplicationService({ repository: createInMemoryRepository(DEFAULT_USER_SETTINGS) });

  assert.throws(() => service.updateSettings({ soundEnabled: false }), /expectedRevision/);
  assert.throws(() => service.updateSettings({ soundEnabled: false }, 1.5), /expectedRevision/);
});
