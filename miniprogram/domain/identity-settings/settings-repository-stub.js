const { DEFAULT_USER_SETTINGS } = require('../../utils/constants');

let memoryState = null;

function createSettingsRepositoryStub() {
  return {
    load() {
      return memoryState ? { ...memoryState } : { ...DEFAULT_USER_SETTINGS };
    },
    save(settings) {
      memoryState = { ...settings };
      return { ...memoryState };
    }
  };
}

module.exports = { createSettingsRepositoryStub };
