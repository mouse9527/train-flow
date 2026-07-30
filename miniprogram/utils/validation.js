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

function assertJsonSafe(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`${path} contains non-JSON value ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} contains a circular reference and is not JSON serializable`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${path} contains symbol keys that are not JSON serializable`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error(`${path}[${index}] is a sparse JSON array entry`);
      }
      assertJsonSafe(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    for (const key of Object.keys(value)) {
      assertJsonSafe(value[key], `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
  return value;
}

function assertAppDatabaseSnapshot(snapshot, { checksumRequired = true } = {}) {
  assertJsonSafe(snapshot);
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

module.exports = {
  assertAppDatabaseSnapshot,
  assertJsonSafe,
  assertNonNegativeInteger,
  assertPlainObject
};
