const { createTrainingRecordRepository } = require('../records/training-record-repository');
const { assertWorkoutPlan } = require('../planning/plan-validation');
const {
  DEFAULT_USER_SETTINGS,
  LOCAL_TIME_PATTERN,
  MAX_REST_SECONDS,
  MIN_REST_SECONDS,
  SETTINGS_SCHEMA_VERSION,
  TIMEZONE_PATTERN
} = require('../../utils/constants');
const { canonicalize, computeChecksum } = require('../../utils/checksum');

const BACKUP_FORMAT = 'trainflow.local-backup';
const CURRENT_PACKAGE_VERSION = 1;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 64;
const MAX_IMPORT_NODES = 100000;
const PACKAGE_FIELDS = Object.freeze([
  'format',
  'packageVersion',
  'appSchemaVersion',
  'exportedAt',
  'data',
  'checksum'
]);
const DATA_FIELDS = Object.freeze(['profile', 'settings', 'plans', 'records']);
const SETTINGS_FIELDS = Object.freeze([
  'schemaVersion',
  'vibrationEnabled',
  'soundEnabled',
  'voiceEnabled',
  'keepScreenOn',
  'defaultStartLocalTime',
  'recommendedEndLocalTime',
  'defaultRestSeconds',
  'timezone'
]);
const FORBIDDEN_FIELDS = new Set([
  'openid',
  'unionid',
  'sessionkey',
  'ownerid',
  'token',
  'authtoken',
  'secret',
  'appsecret',
  'cursor',
  'outbox',
  'proto',
  'constructor',
  'prototype'
]);

class PortableBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortableBackupError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PortableBackupError(code, message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function utf8ByteLength(value) {
  if (typeof value !== 'string') {
    fail('IMPORT_JSON_INVALID', 'Import payload must be JSON text');
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > MAX_IMPORT_BYTES) return bytes;
  }
  return bytes;
}

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, message);
  }
}

function assertExactFields(value, fields, path) {
  assertPlainObject(value, 'IMPORT_JSON_INVALID', `${path} must be an object`);
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    fail('IMPORT_UNKNOWN_FIELD', `${path} contains unknown field ${unknown}`);
  }
  const missing = fields.find((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing) {
    fail('IMPORT_DOMAIN_INVALID', `${path} requires field ${missing}`);
  }
}

function normalizedForbiddenField(field) {
  return field.replace(/_/g, '').toLowerCase();
}

function inspectStructure(value) {
  let nodes = 0;
  const visit = (candidate, path, depth) => {
    nodes += 1;
    if (nodes > MAX_IMPORT_NODES) {
      fail('IMPORT_TOO_COMPLEX', `Import exceeds ${MAX_IMPORT_NODES} nodes`);
    }
    if (depth > MAX_IMPORT_DEPTH) {
      fail('IMPORT_TOO_COMPLEX', `Import exceeds depth ${MAX_IMPORT_DEPTH}`);
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const key of Object.keys(candidate)) {
      if (FORBIDDEN_FIELDS.has(normalizedForbiddenField(key))) {
        fail('IMPORT_FORBIDDEN_FIELD', `Forbidden field at ${path}.${key}`);
      }
      visit(candidate[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(value, '$', 0);
}

function assertNonNegativeSafeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('IMPORT_DOMAIN_INVALID', `${path} must be a non-negative safe integer`);
  }
}

function assertPortableSettings(settings) {
  assertExactFields(settings, SETTINGS_FIELDS, 'data.settings');
  if (settings.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    fail('IMPORT_DOMAIN_INVALID', 'data.settings schemaVersion is unsupported');
  }
  for (const field of ['vibrationEnabled', 'soundEnabled', 'voiceEnabled', 'keepScreenOn']) {
    if (typeof settings[field] !== 'boolean') {
      fail('IMPORT_DOMAIN_INVALID', `data.settings.${field} must be boolean`);
    }
  }
  for (const field of ['defaultStartLocalTime', 'recommendedEndLocalTime']) {
    if (typeof settings[field] !== 'string' || !LOCAL_TIME_PATTERN.test(settings[field])) {
      fail('IMPORT_DOMAIN_INVALID', `data.settings.${field} must be HH:mm`);
    }
  }
  if (
    !Number.isSafeInteger(settings.defaultRestSeconds) ||
    settings.defaultRestSeconds < MIN_REST_SECONDS ||
    settings.defaultRestSeconds > MAX_REST_SECONDS
  ) {
    fail('IMPORT_DOMAIN_INVALID', 'data.settings.defaultRestSeconds is outside the supported range');
  }
  if (typeof settings.timezone !== 'string' || !TIMEZONE_PATTERN.test(settings.timezone)) {
    fail('IMPORT_DOMAIN_INVALID', 'data.settings.timezone is unsupported');
  }
}

function validatePlans(plans) {
  if (!Array.isArray(plans)) fail('IMPORT_DOMAIN_INVALID', 'data.plans must be an array');
  const ids = new Set();
  const activeDates = new Set();
  for (const plan of plans) {
    if (plan && typeof plan.id === 'string' && ids.has(plan.id)) {
      fail('IMPORT_DUPLICATE_PLAN_ID', 'Import contains duplicate plan identity');
    }
    try {
      assertWorkoutPlan(plan);
    } catch (_error) {
      fail('IMPORT_DOMAIN_INVALID', 'Import contains an invalid plan');
    }
    assertNonNegativeSafeInteger(plan.createdAt, 'data.plans[].createdAt');
    assertNonNegativeSafeInteger(plan.updatedAt, 'data.plans[].updatedAt');
    if (plan.updatedAt < plan.createdAt) {
      fail('IMPORT_DOMAIN_INVALID', 'data.plans[].updatedAt must not precede createdAt');
    }
    if (plan.deletedAt !== null) {
      assertNonNegativeSafeInteger(plan.deletedAt, 'data.plans[].deletedAt');
    }
    ids.add(plan.id);
    if (plan.status !== 'deleted') {
      if (activeDates.has(plan.trainingDate)) {
        fail('IMPORT_DUPLICATE_PLAN_DATE', 'Import contains duplicate active plan date');
      }
      activeDates.add(plan.trainingDate);
    }
  }
}

function validateRecords(records) {
  if (!Array.isArray(records)) fail('IMPORT_DOMAIN_INVALID', 'data.records must be an array');
  const ids = new Set();
  const sourceSessionIds = new Set();
  for (const record of records) {
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      typeof record.id !== 'string' ||
      typeof record.sourceSessionId !== 'string' ||
      record.id !== `record_${record.sourceSessionId}` ||
      ids.has(record.id) ||
      sourceSessionIds.has(record.sourceSessionId)
    ) {
      fail('IMPORT_RECORD_ID_CONFLICT', 'Import contains conflicting TrainingRecord identity');
    }
    ids.add(record.id);
    sourceSessionIds.add(record.sourceSessionId);
  }
  try {
    createTrainingRecordRepository({
      database: {
        load: () => ({ records }),
        commit() { throw new Error('read-only validation boundary'); }
      }
    }).list();
  } catch (_error) {
    fail('IMPORT_DOMAIN_INVALID', 'Import contains an invalid TrainingRecord or tombstone');
  }
}

function migrateSequentially(value, field, targetVersion, migrations, label) {
  while (value[field] < targetVersion) {
    const fromVersion = value[field];
    const migration = migrations && Object.prototype.hasOwnProperty.call(migrations, fromVersion)
      ? migrations[fromVersion]
      : null;
    if (typeof migration !== 'function') {
      fail('IMPORT_SCHEMA_UNSUPPORTED', `Missing ${label} migration from version ${fromVersion}`);
    }
    let migrated;
    try {
      migrated = migration(value);
    } catch (error) {
      fail('IMPORT_SCHEMA_UNSUPPORTED', `${label} migration failed: ${error.message}`);
    }
    value = migrated === undefined ? value : migrated;
    if (!value || value[field] !== fromVersion + 1) {
      fail('IMPORT_SCHEMA_UNSUPPORTED', `${label} migration must advance exactly one version`);
    }
  }
  return value;
}

function parsePortableBackup(jsonText, {
  currentPackageVersion = CURRENT_PACKAGE_VERSION,
  currentAppSchemaVersion = 1,
  packageMigrations = {},
  appMigrations = {}
} = {}) {
  const bytes = utf8ByteLength(jsonText);
  if (bytes > MAX_IMPORT_BYTES) {
    fail('IMPORT_TOO_LARGE', 'Import is larger than 5 MiB');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_error) {
    fail('IMPORT_JSON_INVALID', 'Import JSON cannot be parsed');
  }
  assertPlainObject(parsed, 'IMPORT_JSON_INVALID', 'Import root must be an object');
  inspectStructure(parsed);
  assertExactFields(parsed, PACKAGE_FIELDS, 'package');
  if (parsed.format !== BACKUP_FORMAT) fail('IMPORT_DOMAIN_INVALID', 'Backup format is unsupported');
  assertNonNegativeSafeInteger(parsed.packageVersion, 'package.packageVersion');
  assertNonNegativeSafeInteger(parsed.appSchemaVersion, 'package.appSchemaVersion');
  assertNonNegativeSafeInteger(parsed.exportedAt, 'package.exportedAt');
  if (typeof parsed.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.checksum)) {
    fail('IMPORT_CHECKSUM_MISMATCH', 'Backup checksum is invalid');
  }
  if (parsed.checksum !== computeChecksum(parsed)) {
    fail('IMPORT_CHECKSUM_MISMATCH', 'Backup checksum does not match its payload');
  }
  if (parsed.packageVersion > currentPackageVersion || parsed.appSchemaVersion > currentAppSchemaVersion) {
    fail('IMPORT_SCHEMA_UNSUPPORTED', 'Backup schema is newer than this app; upgrade the app first');
  }
  let normalized = clone(parsed);
  normalized = migrateSequentially(
    normalized,
    'packageVersion',
    currentPackageVersion,
    packageMigrations,
    'package'
  );
  normalized = migrateSequentially(
    normalized,
    'appSchemaVersion',
    currentAppSchemaVersion,
    appMigrations,
    'app schema'
  );
  inspectStructure(normalized);
  assertExactFields(normalized, PACKAGE_FIELDS, 'package');
  assertExactFields(normalized.data, DATA_FIELDS, 'data');
  if (normalized.data.profile !== null) {
    fail('IMPORT_DOMAIN_INVALID', 'data.profile must be null in backup version 1');
  }
  assertPortableSettings(normalized.data.settings);
  validatePlans(normalized.data.plans);
  validateRecords(normalized.data.records);
  normalized.data.plans = clone(normalized.data.plans).sort((left, right) => left.id.localeCompare(right.id));
  normalized.data.records = clone(normalized.data.records).sort((left, right) => left.id.localeCompare(right.id));
  normalized.checksum = computeChecksum(normalized);
  return {
    bytes,
    envelope: normalized,
    data: clone(normalized.data),
    packageDigest: computeChecksum(normalized),
    candidateDigest: computeChecksum(normalized.data)
  };
}

function portableSettingsFromSnapshot(settings) {
  const portable = {};
  for (const field of SETTINGS_FIELDS) portable[field] = settings[field];
  assertPortableSettings(portable);
  return portable;
}

function createPortableBackup(snapshot, { now = Date.now, appSchemaVersion = 1 } = {}) {
  if (snapshot.profile !== null) {
    fail('EXPORT_DOMAIN_INVALID', 'Backup version 1 supports only a null profile');
  }
  validatePlans(snapshot.plans);
  validateRecords(snapshot.records);
  const envelope = {
    format: BACKUP_FORMAT,
    packageVersion: CURRENT_PACKAGE_VERSION,
    appSchemaVersion,
    exportedAt: now(),
    data: {
      profile: null,
      settings: portableSettingsFromSnapshot(snapshot.settings),
      plans: clone(snapshot.plans).sort((left, right) => left.id.localeCompare(right.id)),
      records: clone(snapshot.records).sort((left, right) => left.id.localeCompare(right.id))
    }
  };
  assertNonNegativeSafeInteger(envelope.exportedAt, 'package.exportedAt');
  envelope.checksum = computeChecksum(envelope);
  const jsonText = canonicalize(envelope);
  return {
    jsonText,
    summary: {
      plans: envelope.data.plans.length,
      records: envelope.data.records.length,
      bytes: utf8ByteLength(jsonText),
      checksumPrefix: envelope.checksum.slice(0, 8)
    }
  };
}

function expandPortableSettings(portable, currentSettings) {
  const currentPortable = portableSettingsFromSnapshot(currentSettings);
  const changed = canonicalize(currentPortable) !== canonicalize(portable);
  if (changed && currentSettings.revision >= Number.MAX_SAFE_INTEGER) {
    fail('IMPORT_DOMAIN_INVALID', 'Settings revision cannot advance safely');
  }
  return {
    ...clone(portable),
    cloudSyncEnabled: false,
    revision: changed ? currentSettings.revision + 1 : currentSettings.revision
  };
}

function emptyRuntimeMetadata() {
  return {
    notifications: {
      expiredOccurrences: [],
      pendingExpiredOccurrences: [],
      attemptedExpiredOccurrences: [],
      terminalOccurrences: []
    },
    sync: {
      enabled: false,
      provider: 'none',
      cursor: null,
      lastSyncedAt: null,
      lastError: null,
      outbox: [],
      conflicts: []
    }
  };
}

function buildImportedFields(currentSnapshot, parsed) {
  const runtime = emptyRuntimeMetadata();
  return {
    profile: null,
    settings: expandPortableSettings(parsed.data.settings, currentSnapshot.settings || DEFAULT_USER_SETTINGS),
    plans: clone(parsed.data.plans),
    records: clone(parsed.data.records),
    activeSession: null,
    notifications: runtime.notifications,
    statisticsProjection: {
      dirty: true,
      reason: 'portable-import',
      sourceChecksum: parsed.envelope.checksum
    },
    sync: runtime.sync
  };
}

function importFieldsEqual(snapshot, fields) {
  return canonicalize({
    profile: snapshot.profile,
    settings: snapshot.settings,
    plans: snapshot.plans,
    records: snapshot.records,
    activeSession: snapshot.activeSession,
    notifications: snapshot.notifications,
    statisticsProjection: snapshot.statisticsProjection,
    sync: snapshot.sync
  }) === canonicalize(fields);
}

function diffCollection(current, candidate) {
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  const candidateById = new Map(candidate.map((entry) => [entry.id, entry]));
  const result = { added: 0, changed: 0, unchanged: 0, removed: 0 };
  for (const [id, entry] of candidateById) {
    if (!currentById.has(id)) result.added += 1;
    else if (canonicalize(currentById.get(id)) === canonicalize(entry)) result.unchanged += 1;
    else result.changed += 1;
  }
  for (const id of currentById.keys()) {
    if (!candidateById.has(id)) result.removed += 1;
  }
  return result;
}

module.exports = {
  BACKUP_FORMAT,
  CURRENT_PACKAGE_VERSION,
  MAX_IMPORT_BYTES,
  PortableBackupError,
  buildImportedFields,
  createPortableBackup,
  diffCollection,
  emptyRuntimeMetadata,
  importFieldsEqual,
  parsePortableBackup,
  utf8ByteLength
};
