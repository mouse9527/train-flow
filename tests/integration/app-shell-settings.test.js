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
    save(settings) {
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

  const updated = service.updateSettings({ vibrationEnabled: false, defaultRestSeconds: 90 });

  assert.equal(updated.vibrationEnabled, false);
  assert.equal(updated.defaultRestSeconds, 90);
  assert.equal(updated.revision, DEFAULT_USER_SETTINGS.revision + 1);
  assert.deepEqual(repository.load(), updated);
});

test('updateSettings rejects defaultRestSeconds outside the allowed range', () => {
  const service = createSettingsApplicationService({ repository: createInMemoryRepository(DEFAULT_USER_SETTINGS) });

  assert.throws(() => service.updateSettings({ defaultRestSeconds: -5 }), /defaultRestSeconds/);
  assert.throws(() => service.updateSettings({ defaultRestSeconds: 999 }), /defaultRestSeconds/);
});

test('updateSettings rejects unknown fields so pages cannot smuggle arbitrary state', () => {
  const service = createSettingsApplicationService({ repository: createInMemoryRepository(DEFAULT_USER_SETTINGS) });

  assert.throws(() => service.updateSettings({ openId: 'oX123' }), /Unknown settings field/);
});

test('updateSettings rejects non-boolean values for boolean fields', () => {
  const service = createSettingsApplicationService({ repository: createInMemoryRepository(DEFAULT_USER_SETTINGS) });

  assert.throws(() => service.updateSettings({ soundEnabled: 'yes' }), /soundEnabled/);
});
