const {
  DEFAULT_USER_SETTINGS,
  LOCAL_TIME_PATTERN,
  MIN_REST_SECONDS,
  MAX_REST_SECONDS
} = require('../utils/constants');
const { computeChecksum } = require('../utils/checksum');
const { utf8ByteLength } = require('../domain/identity-settings/portable-backup');

const BOOLEAN_FIELDS = ['vibrationEnabled', 'soundEnabled', 'voiceEnabled', 'keepScreenOn', 'cloudSyncEnabled'];
const TIME_FIELDS = ['defaultStartLocalTime', 'recommendedEndLocalTime'];
const EDITABLE_FIELDS = new Set([...BOOLEAN_FIELDS, ...TIME_FIELDS, 'defaultRestSeconds']);

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

function assertExpectedRevision(expectedRevision, actualRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative integer');
  }
  if (expectedRevision !== actualRevision) {
    throw new Error(`Settings revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
  }
}

function createSettingsApplicationService({
  repository,
  database = null,
  wx: wxApi = null,
  clipboard = wxApi,
  now = Date.now,
  confirmationTtlMs = 5 * 60 * 1000
}) {
  if (!repository || typeof repository.load !== 'function' || typeof repository.save !== 'function') {
    throw new Error('createSettingsApplicationService requires a repository with load/save');
  }

  const exportConfirmations = new Map();
  let exportSequence = 0;

  function requireDatabase(method) {
    if (!database || typeof database[method] !== 'function') {
      throw new Error(`Settings data service requires LocalDatabase.${method}()`);
    }
    return database;
  }

  function registerExport(jsonText) {
    exportSequence += 1;
    const digest = computeChecksum(JSON.parse(jsonText));
    const expiresAt = now() + confirmationTtlMs;
    const confirmationId = `export_${exportSequence}_${computeChecksum({ digest, expiresAt }).slice(0, 20)}`;
    exportConfirmations.set(confirmationId, { digest, expiresAt, consumed: false, jsonText });
    return confirmationId;
  }

  function requireExportConfirmation(confirmationId) {
    const confirmation = exportConfirmations.get(confirmationId);
    if (!confirmation) throw new Error('Export confirmation is missing');
    if (confirmation.consumed) throw new Error('Export confirmation was already consumed');
    if (now() > confirmation.expiresAt) throw new Error('Export confirmation expired');
    return confirmation;
  }

  function writeClipboard(jsonText) {
    const target = clipboard || wxApi;
    if (!target || typeof target.setClipboardData !== 'function') {
      throw new Error('Clipboard is unavailable');
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const succeed = () => {
        if (!settled) {
          settled = true;
          resolve({ copied: true, bytes: utf8ByteLength(jsonText) });
        }
      };
      const fail = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Clipboard write failed'));
        }
      };
      try {
        const result = target.setClipboardData({ data: jsonText, success: succeed, fail });
        if (result && typeof result.then === 'function') result.then(succeed, fail);
      } catch (_error) {
        fail();
      }
    });
  }

  const service = {
    getSettings() {
      const current = repository.load();
      return current ? { ...current } : { ...DEFAULT_USER_SETTINGS };
    },

    updateSettings(patch, expectedRevision) {
      assertKnownFields(patch);
      for (const [field, value] of Object.entries(patch)) {
        assertValidValue(field, value);
      }

      const current = repository.load() || { ...DEFAULT_USER_SETTINGS };
      assertExpectedRevision(expectedRevision, current.revision);
      const next = {
        ...current,
        ...patch,
        revision: current.revision + 1
      };
      return repository.save(next, expectedRevision);
    },

    createExportPreview() {
      const exported = requireDatabase('exportPortableBackup').exportPortableBackup();
      return {
        confirmationId: registerExport(exported.jsonText),
        jsonText: exported.jsonText,
        summary: { ...exported.summary },
        privacyWarning: 'JSON 包含私人训练数据，请仅保存到你信任的位置。'
      };
    },

    copyExportToClipboard(jsonTextOrConfirmationId, optionalConfirmationId) {
      const explicitText = optionalConfirmationId !== undefined;
      const confirmationId = explicitText ? optionalConfirmationId : jsonTextOrConfirmationId;
      const confirmation = requireExportConfirmation(confirmationId);
      const jsonText = explicitText
        ? jsonTextOrConfirmationId
        : confirmation.jsonText;
      if (typeof jsonText !== 'string' || computeChecksum(JSON.parse(jsonText)) !== confirmation.digest) {
        throw new Error('Export confirmation digest mismatch');
      }
      return writeClipboard(jsonText).then((result) => {
        confirmation.consumed = true;
        confirmation.jsonText = '';
        exportConfirmations.delete(confirmationId);
        return result;
      });
    },

    previewImport(jsonText) {
      return requireDatabase('previewPortableImport').previewPortableImport(jsonText);
    },

    confirmImport(jsonText, confirmationId) {
      return requireDatabase('applyPortableImport').applyPortableImport(jsonText, confirmationId);
    },

    prepareLocalClear() {
      return requireDatabase('prepareLocalPurge').prepareLocalPurge();
    },

    confirmLocalClear(confirmationId) {
      return requireDatabase('applyLocalPurge').applyLocalPurge(confirmationId);
    },

    measureJsonBytes(jsonText) {
      return utf8ByteLength(jsonText);
    },

    clearSensitiveData() {
      exportConfirmations.clear();
    }
  };
  return service;
}

function createSettingsDataApplicationService(options) {
  return createSettingsApplicationService(options);
}

module.exports = {
  createSettingsApplicationService,
  createSettingsDataApplicationService
};
