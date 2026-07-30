function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertAppDatabaseSnapshot(snapshot, { checksumRequired = true } = {}) {
  assertPlainObject(snapshot, 'AppDatabase snapshot');
  assertNonNegativeInteger(snapshot.schemaVersion, 'schemaVersion');
  if (snapshot.schemaVersion < 1) {
    throw new Error('schemaVersion must be at least 1');
  }
  assertNonNegativeInteger(snapshot.localRevision, 'localRevision');
  if (!Number.isFinite(snapshot.committedAt)) {
    throw new Error('committedAt must be a finite timestamp');
  }
  if (checksumRequired && (typeof snapshot.checksum !== 'string' || snapshot.checksum.length === 0)) {
    throw new Error('checksum must be a non-empty string');
  }
  assertPlainObject(snapshot.settings, 'settings');
  if (!Array.isArray(snapshot.plans) || !Array.isArray(snapshot.records)) {
    throw new Error('plans and records must be arrays');
  }
  assertPlainObject(snapshot.statisticsProjection, 'statisticsProjection');
  assertPlainObject(snapshot.sync, 'sync');
  if (!Array.isArray(snapshot.sync.outbox) || !Array.isArray(snapshot.sync.conflicts)) {
    throw new Error('sync outbox and conflicts must be arrays');
  }
  return snapshot;
}

module.exports = { assertAppDatabaseSnapshot, assertNonNegativeInteger, assertPlainObject };
