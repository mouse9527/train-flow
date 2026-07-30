const { DEFAULT_USER_SETTINGS } = require('../../utils/constants');

class SettingsRepository {
  constructor({ database }) {
    if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
      throw new Error('SettingsRepository requires a LocalDatabase');
    }
    this.database = database;
  }

  load() {
    const snapshot = this.database.load();
    return snapshot.settings ? { ...snapshot.settings } : { ...DEFAULT_USER_SETTINGS };
  }

  save(settings, expectedRevision) {
    return this.database.commit((draft) => {
      const current = draft.settings || DEFAULT_USER_SETTINGS;
      if (current.revision !== expectedRevision) {
        throw new Error(
          `Settings revision conflict: expected ${expectedRevision}, actual ${current.revision}`
        );
      }
      draft.settings = { ...settings };
    }).settings;
  }
}

function createSettingsRepository(options) {
  return new SettingsRepository(options);
}

module.exports = { SettingsRepository, createSettingsRepository };
