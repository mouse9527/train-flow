const { DEFAULT_USER_SETTINGS, MIN_REST_SECONDS, MAX_REST_SECONDS } = require('../utils/constants');

const BOOLEAN_FIELDS = ['vibrationEnabled', 'soundEnabled', 'voiceEnabled', 'keepScreenOn', 'cloudSyncEnabled'];
const TIME_FIELDS = ['defaultStartLocalTime', 'recommendedEndLocalTime'];
const EDITABLE_FIELDS = new Set([...BOOLEAN_FIELDS, ...TIME_FIELDS, 'defaultRestSeconds']);
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function assertKnownFields(patch) {
  for (const field of Object.keys(patch)) {
    if (!EDITABLE_FIELDS.has(field)) {
      throw new Error(`Unknown settings field: ${field}`);
    }
  }
}

function assertValidValue(field, value) {
  if (BOOLEAN_FIELDS.includes(field) && typeof value !== 'boolean') {
    throw new Error(`${field} must be a boolean`);
  }
  if (TIME_FIELDS.includes(field) && (typeof value !== 'string' || !LOCAL_TIME_PATTERN.test(value))) {
    throw new Error(`${field} must be an HH:mm local time string`);
  }
  if (field === 'defaultRestSeconds') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error('defaultRestSeconds must be an integer');
    }
    if (value < MIN_REST_SECONDS || value > MAX_REST_SECONDS) {
      throw new Error(`defaultRestSeconds must be between ${MIN_REST_SECONDS} and ${MAX_REST_SECONDS}`);
    }
  }
}

function createSettingsApplicationService({ repository }) {
  if (!repository || typeof repository.load !== 'function' || typeof repository.save !== 'function') {
    throw new Error('createSettingsApplicationService requires a repository with load/save');
  }

  return {
    getSettings() {
      const current = repository.load();
      return current ? { ...current } : { ...DEFAULT_USER_SETTINGS };
    },

    updateSettings(patch) {
      assertKnownFields(patch);
      for (const [field, value] of Object.entries(patch)) {
        assertValidValue(field, value);
      }

      const current = repository.load() || { ...DEFAULT_USER_SETTINGS };
      const next = {
        ...current,
        ...patch,
        revision: current.revision + 1
      };
      return repository.save(next);
    }
  };
}

module.exports = { createSettingsApplicationService };
