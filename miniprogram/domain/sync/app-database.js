const { DEFAULT_USER_SETTINGS } = require('../../utils/constants');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createAppDatabase({ now = Date.now, install = null, schemaVersion = 1 } = {}) {
  return {
    schemaVersion,
    localRevision: 0,
    committedAt: now(),
    install: install ? clone(install) : null,
    profile: null,
    settings: { ...DEFAULT_USER_SETTINGS },
    plans: [],
    activeSession: null,
    notifications: {
      expiredOccurrences: [],
      pendingExpiredOccurrences: [],
      attemptedExpiredOccurrences: [],
      terminalOccurrences: []
    },
    records: [],
    statisticsProjection: {},
    sync: {
      enabled: false,
      provider: 'none',
      cursor: null,
      lastSyncedAt: null,
      lastError: null,
      outbox: [],
      conflicts: [],
      replicas: {}
    }
  };
}

module.exports = { cloneAppDatabase: clone, createAppDatabase };
