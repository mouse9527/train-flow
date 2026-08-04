const { DEFAULT_USER_SETTINGS } = require('../../utils/constants');
const { ENTITY_TYPES } = require('../sync/entity-mapper');
const {
  appendRepositorySyncMutation,
  createRepositoryDeviceIdFactory
} = require('../sync/sync-operation');

const LOCAL_ONLY_SETTINGS_FIELDS = new Set(['schemaVersion', 'revision']);

class SettingsRepository {
  constructor({ database, now = Date.now, deviceIdFactory = createRepositoryDeviceIdFactory() }) {
    if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
      throw new Error('SettingsRepository requires a LocalDatabase');
    }
    if (typeof now !== 'function') {
      throw new Error('SettingsRepository now must be a function');
    }
    if (typeof deviceIdFactory !== 'function') {
      throw new Error('SettingsRepository deviceIdFactory must be a function');
    }
    this.database = database;
    this.now = now;
    this.deviceIdFactory = deviceIdFactory;
  }

  load() {
    const snapshot = this.database.load();
    return snapshot.settings ? { ...snapshot.settings } : { ...DEFAULT_USER_SETTINGS };
  }

  save(settings, expectedRevision) {
    const createdAt = this.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new Error('SettingsRepository now must return a non-negative safe integer');
    }
    return this.database.commit((draft) => {
      const current = draft.settings || DEFAULT_USER_SETTINGS;
      if (current.revision !== expectedRevision) {
        throw new Error(
          `Settings revision conflict: expected ${expectedRevision}, actual ${current.revision}`
        );
      }
      draft.settings = { ...settings };
      const changedPayload = {};
      for (const field of Object.keys(settings).sort()) {
        if (!LOCAL_ONLY_SETTINGS_FIELDS.has(field) && current[field] !== settings[field]) {
          changedPayload[field] = settings[field];
        }
      }
      if (Object.keys(changedPayload).length > 0) {
        appendRepositorySyncMutation(draft, {
          entityType: ENTITY_TYPES.USER_SETTINGS,
          entityId: 'settings',
          action: 'upsert',
          payload: changedPayload
        }, {
          commandIdentity: `settings.save:${expectedRevision}`,
          createdAt,
          deviceIdFactory: this.deviceIdFactory
        });
      }
    }).settings;
  }
}

function createSettingsRepository(options) {
  return new SettingsRepository(options);
}

module.exports = { SettingsRepository, createSettingsRepository };
