const {
  LOCAL_TIME_PATTERN,
  MAX_REST_SECONDS,
  MIN_REST_SECONDS,
  SETTINGS_FIELDS_BY_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  TIMEZONE_PATTERN
} = require('./constants');

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

function createValidationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
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
  if (snapshot.install !== null) {
    assertInstallMetadata(snapshot.install);
  }
  assertPlainObject(snapshot.settings, 'settings');
  assertNonNegativeInteger(snapshot.settings.schemaVersion, 'settings.schemaVersion');
  if (snapshot.settings.schemaVersion < 1) {
    throw new Error('settings.schemaVersion must be at least 1');
  }
  if (snapshot.settings.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new Error(`Unsupported settings.schemaVersion ${snapshot.settings.schemaVersion}`);
  }
  const allowedSettingsFields = SETTINGS_FIELDS_BY_SCHEMA_VERSION[snapshot.settings.schemaVersion];
  const unexpectedSettingsField = Object.keys(snapshot.settings).find(
    (field) => !allowedSettingsFields.includes(field)
  );
  if (unexpectedSettingsField) {
    throw createValidationError(
      `settings contains unexpected field ${unexpectedSettingsField}`,
      'UNEXPECTED_SETTINGS_FIELD'
    );
  }
  assertNonNegativeInteger(snapshot.settings.revision, 'settings.revision');
  if (snapshot.settings.revision < 1) {
    throw new Error('settings.revision must be at least 1');
  }
  for (const field of [
    'vibrationEnabled',
    'soundEnabled',
    'voiceEnabled',
    'keepScreenOn',
    'cloudSyncEnabled'
  ]) {
    if (typeof snapshot.settings[field] !== 'boolean') {
      throw new Error(`settings.${field} must be a boolean`);
    }
  }
  for (const field of ['defaultStartLocalTime', 'recommendedEndLocalTime']) {
    if (
      typeof snapshot.settings[field] !== 'string' ||
      !LOCAL_TIME_PATTERN.test(snapshot.settings[field])
    ) {
      throw new Error(`settings.${field} must be an HH:mm local time string`);
    }
  }
  if (
    typeof snapshot.settings.timezone !== 'string' ||
    !TIMEZONE_PATTERN.test(snapshot.settings.timezone)
  ) {
    throw new Error('settings.timezone must be UTC or an IANA timezone');
  }
  assertNonNegativeInteger(snapshot.settings.defaultRestSeconds, 'settings.defaultRestSeconds');
  if (
    snapshot.settings.defaultRestSeconds < MIN_REST_SECONDS ||
    snapshot.settings.defaultRestSeconds > MAX_REST_SECONDS
  ) {
    throw new Error(
      `settings.defaultRestSeconds must be between ${MIN_REST_SECONDS} and ${MAX_REST_SECONDS}`
    );
  }
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

function assertInstallMetadata(install) {
  assertJsonSafe(install, 'install');
  assertPlainObject(install, 'install');
  const allowedFields = new Set(['deviceId', 'createdAt']);
  const unexpectedField = Object.keys(install).find((field) => !allowedFields.has(field));
  if (unexpectedField) {
    throw new Error(`install contains unexpected field ${unexpectedField}`);
  }
  if (typeof install.deviceId !== 'string' || install.deviceId.length === 0) {
    throw new Error('install.deviceId must be a non-empty string');
  }
  if (!Number.isFinite(install.createdAt)) {
    throw new Error('install.createdAt must be a finite timestamp');
  }
  return install;
}

module.exports = {
  assertAppDatabaseSnapshot,
  assertInstallMetadata,
  assertJsonSafe,
  assertNonNegativeInteger,
  assertPlainObject
};
