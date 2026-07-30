const { DEFAULT_USER_SETTINGS } = require('../../utils/constants');

let memoryState = null;

function createSettingsRepositoryStub() {
  return {
    load() {
      return memoryState ? { ...memoryState } : { ...DEFAULT_USER_SETTINGS };
    },
    save(settings, expectedRevision) {
      const current = memoryState || DEFAULT_USER_SETTINGS;
      if (expectedRevision !== current.revision) {
        throw new Error(
          `Settings revision conflict: expected ${expectedRevision}, actual ${current.revision}`
        );
      }
      memoryState = { ...settings };
      return { ...memoryState };
    }
  };
}

module.exports = { createSettingsRepositoryStub };
