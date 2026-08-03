const { cloneAppDatabase, createAppDatabase } = require('../domain/sync/app-database');
const {
  buildImportedFields,
  createPortableBackup,
  diffCollection,
  importFieldsEqual,
  parsePortableBackup
} = require('../domain/identity-settings/portable-backup');
const { canonicalize, computeChecksum } = require('../utils/checksum');
const { assertAppDatabaseSnapshot, assertInstallMetadata } = require('../utils/validation');

const SLOT_KEYS = Object.freeze({
  a: 'train_flow:v1:db:a',
  b: 'train_flow:v1:db:b'
});
const ACTIVE_KEY = 'train_flow:v1:db:active';
const INSTALL_KEY = 'train_flow:v1:install';
const IMPORT_INTENT_KEY = 'train_flow:v1:db:import-intent';
const CLEANUP_PENDING_KEY = 'train_flow:v1:db:cleanup-pending';
const fallbackValues = new Map();

const IMPORT_INTENT_FIELDS = Object.freeze([
  'schema',
  'phase',
  'operation',
  'baselineSlot',
  'baselineRevision',
  'baselineChecksum',
  'targetSlot',
  'candidateChecksum'
]);
const CLEANUP_MARKER_FIELDS = Object.freeze([
  'schema',
  'phase',
  'emptySlot',
  'emptyRevision',
  'emptyChecksum',
  'oldSlot'
]);

function createDefaultStorage() {
  if (typeof wx !== 'undefined') {
    return {
      getStorageSync(key) {
        const value = wx.getStorageSync(key);
        if (value !== '' || typeof wx.getStorageInfoSync !== 'function') {
          return value;
        }
        const info = wx.getStorageInfoSync();
        return info && Array.isArray(info.keys) && info.keys.includes(key) ? value : undefined;
      },
      setStorageSync(key, value) {
        wx.setStorageSync(key, value);
      },
      removeStorageSync(key) {
        wx.removeStorageSync(key);
      }
    };
  }

  return {
    getStorageSync(key) {
      return fallbackValues.has(key) ? cloneAppDatabase(fallbackValues.get(key)) : undefined;
    },
    setStorageSync(key, value) {
      fallbackValues.set(key, cloneAppDatabase(value));
    },
    removeStorageSync(key) {
      fallbackValues.delete(key);
    }
  };
}

function decodeStored(value) {
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  if (value === undefined) {
    return undefined;
  }
  return cloneAppDatabase(value);
}

function validateStoredSnapshot(snapshot) {
  if (
    typeof snapshot.checksum !== 'string' ||
    snapshot.checksum.length === 0 ||
    snapshot.checksum !== computeChecksum(snapshot)
  ) {
    throw new Error('AppDatabase checksum validation failed');
  }
  assertAppDatabaseSnapshot(snapshot);
  return snapshot;
}

function normalizeExpectedRevision(expectedRevision, provided) {
  if (!provided) {
    return undefined;
  }
  let normalized = expectedRevision;
  if (expectedRevision && typeof expectedRevision === 'object') {
    if (!Object.prototype.hasOwnProperty.call(expectedRevision, 'expectedRevision')) {
      throw new Error('expectedRevision options must include expectedRevision');
    }
    normalized = expectedRevision.expectedRevision;
  }
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer');
  }
  return normalized;
}

function sameBaseline(left, right) {
  if (left.activeSlot === null && right.activeSlot === null) {
    return left.snapshot.localRevision === right.snapshot.localRevision;
  }
  return (
    left.activeSlot === right.activeSlot &&
    left.snapshot.localRevision === right.snapshot.localRevision &&
    left.snapshot.checksum === right.snapshot.checksum
  );
}

function assertWritableState(state) {
  if (!state.readFailures || state.readFailures.length === 0) {
    return;
  }
  const details = state.readFailures
    .map(({ slot, readError }) => `${slot}: ${readError.message}`)
    .join('; ');
  throw new Error(`LocalDatabase commit is unsafe while a slot is unreadable: ${details}`);
}

function assertExactMarkerFields(marker, fields, label) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new Error(`${label} marker identity is incomplete or unsafe`);
  }
  const keys = Object.keys(marker);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.prototype.hasOwnProperty.call(marker, field))
  ) {
    throw new Error(`${label} marker identity is incomplete or unsafe`);
  }
}

function isSlot(value, nullable = false) {
  return value === 'a' || value === 'b' || (nullable && value === null);
}

function isChecksum(value, nullable = false) {
  return (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) || (nullable && value === null);
}

function validateImportIntent(marker) {
  assertExactMarkerFields(marker, IMPORT_INTENT_FIELDS, 'Import intent');
  if (marker.schema !== 'trainflow.strict-transaction/v1') {
    throw new Error('Import intent marker schema is unsafe');
  }
  if (marker.phase !== 'prepared') {
    throw new Error(`Import intent marker phase ${marker.phase} is unsafe`);
  }
  if (!['import', 'purge'].includes(marker.operation)) {
    throw new Error('Import intent marker operation is unsafe');
  }
  if (
    !isSlot(marker.baselineSlot, true) ||
    !isSlot(marker.targetSlot) ||
    marker.targetSlot === marker.baselineSlot ||
    !Number.isSafeInteger(marker.baselineRevision) ||
    marker.baselineRevision < 0 ||
    !isChecksum(marker.baselineChecksum, marker.baselineSlot === null) ||
    !isChecksum(marker.candidateChecksum)
  ) {
    throw new Error('Import intent marker identity is incomplete or unsafe');
  }
  return marker;
}

function validateCleanupMarker(marker) {
  assertExactMarkerFields(marker, CLEANUP_MARKER_FIELDS, 'Cleanup');
  if (marker.schema !== 'trainflow.purge-cleanup/v1') {
    throw new Error('Cleanup marker schema is unsafe');
  }
  if (marker.phase !== 'cleanup-pending') {
    throw new Error(`Cleanup marker phase ${marker.phase} is unsafe`);
  }
  if (
    !isSlot(marker.emptySlot) ||
    !isSlot(marker.oldSlot, true) ||
    marker.emptySlot === marker.oldSlot ||
    !Number.isSafeInteger(marker.emptyRevision) ||
    marker.emptyRevision < 1 ||
    !isChecksum(marker.emptyChecksum)
  ) {
    throw new Error('Cleanup marker identity is incomplete or unsafe');
  }
  return marker;
}

class LocalDatabase {
  constructor({
    storage = createDefaultStorage(),
    now = Date.now,
    currentSchemaVersion = 1,
    migrations = {},
    portableMigrations = {},
    packageMigrations = portableMigrations,
    portableAppMigrations = {},
    appMigrations = portableAppMigrations,
    confirmationTtlMs = 5 * 60 * 1000
  } = {}) {
    if (!storage || typeof storage.getStorageSync !== 'function' || typeof storage.setStorageSync !== 'function') {
      throw new Error('LocalDatabase requires synchronous getStorageSync/setStorageSync storage');
    }
    if (!Number.isInteger(currentSchemaVersion) || currentSchemaVersion < 1) {
      throw new Error('currentSchemaVersion must be a positive integer');
    }
    this.storage = storage;
    this.now = now;
    this.currentSchemaVersion = currentSchemaVersion;
    this.migrations = migrations;
    this.packageMigrations = packageMigrations;
    this.portableAppMigrations = appMigrations;
    this.confirmationTtlMs = confirmationTtlMs;
    this.confirmations = new Map();
    this.confirmationSequence = 0;
  }

  readSlot(slot) {
    let stored;
    try {
      stored = this.storage.getStorageSync(SLOT_KEYS[slot]);
    } catch (error) {
      return { slot, readError: error };
    }

    try {
      if (stored === undefined) {
        return null;
      }
      const snapshot = decodeStored(stored);
      if (snapshot === null) {
        throw new Error('Stored AppDatabase snapshot is null or empty');
      }
      validateStoredSnapshot(snapshot);
      return { slot, snapshot };
    } catch (error) {
      return { slot, validationError: error };
    }
  }

  readStateBase() {
    const candidates = ['a', 'b'].map((slot) => this.readSlot(slot));
    const readFailures = candidates.filter((candidate) => candidate && candidate.readError);
    const unsafeSettingsCandidate = candidates.find(
      (candidate) =>
        candidate &&
        candidate.validationError &&
        candidate.validationError.code === 'UNEXPECTED_SETTINGS_FIELD'
    );
    if (unsafeSettingsCandidate) {
      throw new Error(
        `Unsafe AppDatabase settings schema in slot ${unsafeSettingsCandidate.slot}: ${unsafeSettingsCandidate.validationError.message}`
      );
    }
    const validSnapshots = candidates.filter((candidate) => candidate && candidate.snapshot);
    const futureSnapshot = validSnapshots.find(
      ({ snapshot }) => snapshot.schemaVersion > this.currentSchemaVersion
    );
    if (futureSnapshot) {
      throw new Error(
        `Unsupported future schemaVersion ${futureSnapshot.snapshot.schemaVersion}; current is ${this.currentSchemaVersion}`
      );
    }

    const compatible = validSnapshots.filter(
      ({ snapshot }) => snapshot.schemaVersion <= this.currentSchemaVersion
    );
    if (compatible.length === 0) {
      const failures = candidates.filter(
        (candidate) => candidate && (candidate.readError || candidate.validationError)
      );
      if (failures.length > 0) {
        const details = failures
          .map((failure) => {
            const error = failure.readError || failure.validationError;
            return `${failure.slot}: ${error.message}`;
          })
          .join('; ');
        throw new Error(`Unable to read a valid AppDatabase snapshot: ${details}`);
      }
      return { activeSlot: null, snapshot: this.createInitialSnapshot(), readFailures };
    }

    const highestRevision = Math.max(
      ...compatible.map(({ snapshot }) => snapshot.localRevision)
    );
    const highestCandidates = compatible.filter(
      ({ snapshot }) => snapshot.localRevision === highestRevision
    );
    if (
      highestCandidates.length > 1 &&
      canonicalize(highestCandidates[0].snapshot) !== canonicalize(highestCandidates[1].snapshot)
    ) {
      throw new Error(
        `LocalDatabase split brain: slots share localRevision ${highestRevision} but contain divergent snapshots`
      );
    }

    const pointer = this.storage.getStorageSync(ACTIVE_KEY);
    compatible.sort((left, right) => {
      const revisionDelta = right.snapshot.localRevision - left.snapshot.localRevision;
      if (revisionDelta !== 0) {
        return revisionDelta;
      }
      if (left.slot === pointer) {
        return -1;
      }
      if (right.slot === pointer) {
        return 1;
      }
      return left.slot.localeCompare(right.slot);
    });
    const selected = compatible[0];
    return { activeSlot: selected.slot, pointer, snapshot: selected.snapshot, readFailures };
  }

  readMarker(key, validator) {
    let stored;
    try {
      stored = this.storage.getStorageSync(key);
    } catch (error) {
      throw new Error(`Unable to read durable marker ${key}: ${error.message}`);
    }
    if (stored === undefined) return null;
    let marker;
    try {
      marker = decodeStored(stored);
    } catch (error) {
      throw new Error(`Durable marker ${key} is unsafe: ${error.message}`);
    }
    return validator(marker);
  }

  readImportIntent() {
    return this.readMarker(IMPORT_INTENT_KEY, validateImportIntent);
  }

  readCleanupMarker() {
    return this.readMarker(CLEANUP_PENDING_KEY, validateCleanupMarker);
  }

  readIntentBaseline(marker) {
    if (marker.baselineSlot === null) {
      if (marker.baselineRevision !== 0 || marker.baselineChecksum !== null) {
        throw new Error('Import intent baseline identity is unsafe');
      }
      return { activeSlot: null, snapshot: this.createInitialSnapshot(), readFailures: [] };
    }
    const candidate = this.readSlot(marker.baselineSlot);
    if (
      !candidate ||
      !candidate.snapshot ||
      candidate.snapshot.localRevision !== marker.baselineRevision ||
      candidate.snapshot.checksum !== marker.baselineChecksum
    ) {
      throw new Error('Import intent baseline identity is unavailable or unsafe');
    }
    return {
      activeSlot: marker.baselineSlot,
      pointer: this.storage.getStorageSync(ACTIVE_KEY),
      snapshot: candidate.snapshot,
      readFailures: []
    };
  }

  readCleanupSnapshot(marker) {
    const candidate = this.readSlot(marker.emptySlot);
    if (
      !candidate ||
      !candidate.snapshot ||
      candidate.snapshot.localRevision !== marker.emptyRevision ||
      candidate.snapshot.checksum !== marker.emptyChecksum
    ) {
      throw new Error('Cleanup empty snapshot checksum or identity is unsafe');
    }
    const pointer = this.storage.getStorageSync(ACTIVE_KEY);
    if (pointer !== marker.emptySlot) {
      throw new Error('Cleanup pointer no longer identifies the empty snapshot');
    }
    return {
      activeSlot: marker.emptySlot,
      pointer,
      snapshot: candidate.snapshot,
      readFailures: []
    };
  }

  restoreStoredValue(key, value) {
    if (value === undefined) {
      if (typeof this.storage.removeStorageSync !== 'function') {
        throw new Error(`Rollback cannot remove ${key}`);
      }
      this.storage.removeStorageSync(key);
      return;
    }
    this.storage.setStorageSync(key, value);
  }

  rollbackImportIntent(marker, targetPreimage) {
    const baseline = this.readIntentBaseline(marker);
    try {
      if (marker.baselineSlot === null) {
        this.restoreStoredValue(ACTIVE_KEY, undefined);
      } else {
        this.storage.setStorageSync(ACTIVE_KEY, marker.baselineSlot);
      }
      this.restoreStoredValue(SLOT_KEYS[marker.targetSlot], targetPreimage);
      this.storage.removeStorageSync(IMPORT_INTENT_KEY);
    } catch (error) {
      throw new Error(`Import rollback failed and remains pending: ${error.message}`);
    }
    return baseline;
  }

  completePendingCleanup(marker) {
    const state = this.readCleanupSnapshot(marker);
    const importIntent = this.readImportIntent();
    if (
      importIntent &&
      (
        importIntent.operation !== 'purge' ||
        importIntent.targetSlot !== marker.emptySlot ||
        importIntent.candidateChecksum !== marker.emptyChecksum
      )
    ) {
      throw new Error('Purge intent does not match cleanup identity');
    }
    try {
      if (importIntent) {
        this.storage.removeStorageSync(IMPORT_INTENT_KEY);
      }
      if (marker.oldSlot !== null) {
        const oldKey = SLOT_KEYS[marker.oldSlot];
        if (typeof this.storage.removeStorageSync === 'function') {
          this.storage.removeStorageSync(oldKey);
        } else {
          this.storage.setStorageSync(oldKey, state.snapshot);
        }
      }
      this.storage.removeStorageSync(CLEANUP_PENDING_KEY);
      return { state, cleanupPending: false };
    } catch (_error) {
      return { state, cleanupPending: true };
    }
  }

  readState() {
    const cleanup = this.readCleanupMarker();
    if (cleanup) {
      this.readCleanupSnapshot(cleanup);
      throw new Error('LocalDatabase cleanup is pending and generic commit is unsafe');
    }
    if (this.readImportIntent()) {
      throw new Error('LocalDatabase import intent rollback is pending and generic commit is unsafe');
    }
    return this.readStateBase();
  }

  createInitialSnapshot() {
    let storedInstall;
    try {
      storedInstall = this.storage.getStorageSync(INSTALL_KEY);
    } catch (error) {
      throw new Error(`Unable to read install metadata: ${error.message}`);
    }

    let install = null;
    if (storedInstall !== undefined) {
      try {
        install = decodeStored(storedInstall);
        if (install === null) {
          throw new Error('install metadata is null or empty');
        }
        assertInstallMetadata(install);
      } catch (error) {
        throw new Error(`Corrupt install metadata: ${error.message}`);
      }
    }
    const snapshot = createAppDatabase({
      now: this.now,
      install,
      schemaVersion: this.currentSchemaVersion
    });
    assertAppDatabaseSnapshot(snapshot, { checksumRequired: false });
    return snapshot;
  }

  load() {
    const cleanup = this.readCleanupMarker();
    if (cleanup) {
      return cloneAppDatabase(this.completePendingCleanup(cleanup).state.snapshot);
    }
    const intent = this.readImportIntent();
    if (intent) {
      if (intent.operation === 'purge') {
        throw new Error('Purge transaction marker is incomplete; cleanup identity is required');
      }
      this.rollbackImportIntent(intent);
    }
    const state = this.readStateBase();
    if (
      state.activeSlot &&
      state.pointer !== state.activeSlot &&
      state.readFailures.length === 0
    ) {
      this.storage.setStorageSync(ACTIVE_KEY, state.activeSlot);
    }
    if (state.snapshot.schemaVersion < this.currentSchemaVersion) {
      return this.migrate(state);
    }
    return cloneAppDatabase(state.snapshot);
  }

  loadReadOnly() {
    const cleanup = this.readCleanupMarker();
    const intent = this.readImportIntent();
    let state;
    if (cleanup) {
      state = this.readCleanupSnapshot(cleanup);
    } else if (intent) {
      if (intent.operation === 'purge') {
        throw new Error('Purge transaction marker is incomplete and unsafe');
      }
      state = this.readIntentBaseline(intent);
    } else {
      state = this.readStateBase();
    }
    const snapshot = state.snapshot.schemaVersion < this.currentSchemaVersion
      ? this.migrateDraft(state.snapshot)
      : state.snapshot;
    return cloneAppDatabase(snapshot);
  }

  registerConfirmation(action, details) {
    this.confirmationSequence += 1;
    const confirmationId = `${action}_${this.confirmationSequence}_${computeChecksum({
      action,
      sequence: this.confirmationSequence,
      expiresAt: this.now() + this.confirmationTtlMs,
      ...details
    }).slice(0, 20)}`;
    const confirmation = {
      action,
      expiresAt: this.now() + this.confirmationTtlMs,
      consumed: false,
      ...details
    };
    this.confirmations.set(confirmationId, confirmation);
    return { confirmationId, confirmation };
  }

  requireConfirmation(confirmationId, action) {
    if (typeof confirmationId !== 'string' || confirmationId.length === 0) {
      throw new Error(`${action} confirmation is required`);
    }
    const confirmation = this.confirmations.get(confirmationId);
    if (!confirmation || confirmation.action !== action) {
      throw new Error(`${action} confirmation is missing or invalid`);
    }
    if (confirmation.consumed) {
      throw new Error(`${action} confirmation was already consumed and is single-use`);
    }
    if (this.now() > confirmation.expiresAt) {
      throw new Error(`${action} confirmation expired`);
    }
    return confirmation;
  }

  exportPortableBackup() {
    return createPortableBackup(this.loadReadOnly(), {
      now: this.now,
      appSchemaVersion: this.currentSchemaVersion
    });
  }

  parsePortableBackup(jsonText) {
    return parsePortableBackup(jsonText, {
      currentAppSchemaVersion: this.currentSchemaVersion,
      packageMigrations: this.packageMigrations,
      appMigrations: this.portableAppMigrations
    });
  }

  previewPortableImport(jsonText) {
    const snapshot = this.loadReadOnly();
    if (snapshot.activeSession !== null) {
      const error = new Error('Active training session must finish before import');
      error.code = 'IMPORT_ACTIVE_SESSION';
      throw error;
    }
    const parsed = this.parsePortableBackup(jsonText);
    const { confirmationId, confirmation } = this.registerConfirmation('import', {
      packageDigest: parsed.packageDigest,
      candidateDigest: parsed.candidateDigest,
      baselineLocalRevision: snapshot.localRevision
    });
    return {
      confirmationId,
      packageVersion: parsed.envelope.packageVersion,
      appSchemaVersion: parsed.envelope.appSchemaVersion,
      checksumPrefix: parsed.envelope.checksum.slice(0, 8),
      expiresAt: confirmation.expiresAt,
      baselineLocalRevision: snapshot.localRevision,
      counts: {
        plans: parsed.data.plans.length,
        records: parsed.data.records.length
      },
      changes: {
        plans: diffCollection(snapshot.plans, parsed.data.plans),
        records: diffCollection(snapshot.records, parsed.data.records)
      },
      warnings: [
        '恢复会替换本机计划、记录与偏好。',
        '导入只影响本机；不会删除云端数据，同步将保持关闭。'
      ]
    };
  }

  applyPortableImport(jsonText, confirmationId) {
    const parsed = this.parsePortableBackup(jsonText);
    const confirmation = this.requireConfirmation(confirmationId, 'import');
    if (
      confirmation.packageDigest !== parsed.packageDigest ||
      confirmation.candidateDigest !== parsed.candidateDigest
    ) {
      throw new Error('Import confirmation digest mismatch');
    }
    const snapshot = this.loadReadOnly();
    if (snapshot.activeSession !== null) {
      const error = new Error('Active training session must finish before import');
      error.code = 'IMPORT_ACTIVE_SESSION';
      throw error;
    }
    if (snapshot.localRevision !== confirmation.baselineLocalRevision) {
      throw new Error('Import confirmation baseline revision changed');
    }
    const fields = buildImportedFields(snapshot, parsed);
    confirmation.consumed = true;
    if (importFieldsEqual(snapshot, fields)) {
      return { applied: false, reason: 'already_current' };
    }
    const committed = this.commitStrictFields(fields, snapshot.localRevision, 'import').snapshot;
    return { applied: true, snapshot: committed };
  }

  prepareLocalPurge() {
    const snapshot = this.loadReadOnly();
    if (snapshot.activeSession !== null) {
      throw new Error('Active session must finish before local data can be cleared');
    }
    const counts = { plans: snapshot.plans.length, records: snapshot.records.length };
    const hasPendingSync = Boolean(
      snapshot.sync &&
      (snapshot.sync.enabled || (Array.isArray(snapshot.sync.outbox) && snapshot.sync.outbox.length > 0))
    );
    const { confirmationId, confirmation } = this.registerConfirmation('purge', {
      baselineLocalRevision: snapshot.localRevision,
      baselineChecksum: snapshot.checksum || null,
      candidateDigest: computeChecksum({ counts, hasPendingSync })
    });
    const warnings = ['仅清除本机数据；不会删除云端数据。'];
    if (hasPendingSync) warnings.unshift('未同步变更会从本机移除。');
    return {
      confirmationId,
      expiresAt: confirmation.expiresAt,
      counts,
      hasPendingSync,
      warnings
    };
  }

  applyLocalPurge(confirmationId) {
    const confirmation = this.requireConfirmation(confirmationId, 'purge');
    const snapshot = this.loadReadOnly();
    if (snapshot.activeSession !== null) {
      throw new Error('Active session must finish before local data can be cleared');
    }
    const counts = { plans: snapshot.plans.length, records: snapshot.records.length };
    const hasPendingSync = Boolean(
      snapshot.sync &&
      (snapshot.sync.enabled || (Array.isArray(snapshot.sync.outbox) && snapshot.sync.outbox.length > 0))
    );
    if (
      snapshot.localRevision !== confirmation.baselineLocalRevision ||
      (snapshot.checksum || null) !== confirmation.baselineChecksum ||
      computeChecksum({ counts, hasPendingSync }) !== confirmation.candidateDigest
    ) {
      throw new Error('Local purge confirmation baseline changed');
    }
    confirmation.consumed = true;
    const empty = createAppDatabase({
      now: this.now,
      install: snapshot.install,
      schemaVersion: this.currentSchemaVersion
    });
    const fields = {
      profile: empty.profile,
      settings: empty.settings,
      plans: empty.plans,
      activeSession: empty.activeSession,
      notifications: empty.notifications,
      records: empty.records,
      statisticsProjection: empty.statisticsProjection,
      sync: empty.sync
    };
    const committed = this.commitStrictFields(fields, snapshot.localRevision, 'purge');
    const marker = this.readCleanupMarker();
    const cleanup = this.completePendingCleanup(marker);
    return {
      purged: true,
      snapshot: committed.snapshot,
      cleanupPending: cleanup.cleanupPending
    };
  }

  commitStrictFields(fields, expectedRevision, operation) {
    const state = this.readState();
    assertWritableState(state);
    if (state.snapshot.localRevision !== expectedRevision) {
      throw new Error(`LocalDatabase revision conflict: expected ${expectedRevision}, actual ${state.snapshot.localRevision}`);
    }
    const latestState = this.readStateBase();
    assertWritableState(latestState);
    if (!sameBaseline(state, latestState)) {
      throw new Error('LocalDatabase strict transaction baseline changed concurrently');
    }
    const targetSlot = state.activeSlot === 'a' ? 'b' : 'a';
    const targetKey = SLOT_KEYS[targetSlot];
    const targetPreimage = this.storage.getStorageSync(targetKey);
    const draft = cloneAppDatabase(state.snapshot);
    Object.assign(draft, cloneAppDatabase(fields));
    assertAppDatabaseSnapshot(draft, { checksumRequired: false });
    const payload = {
      ...draft,
      localRevision: state.snapshot.localRevision + 1,
      committedAt: this.now()
    };
    delete payload.checksum;
    assertAppDatabaseSnapshot(payload, { checksumRequired: false });
    const candidate = { ...payload, checksum: computeChecksum(payload) };
    const intent = {
      schema: 'trainflow.strict-transaction/v1',
      phase: 'prepared',
      operation,
      baselineSlot: state.activeSlot,
      baselineRevision: state.snapshot.localRevision,
      baselineChecksum: state.activeSlot === null ? null : state.snapshot.checksum,
      targetSlot,
      candidateChecksum: candidate.checksum
    };
    let pointerWritten = false;
    try {
      this.storage.setStorageSync(IMPORT_INTENT_KEY, intent);
      if (canonicalize(decodeStored(this.storage.getStorageSync(IMPORT_INTENT_KEY))) !== canonicalize(intent)) {
        throw new Error('Strict transaction intent read-back mismatch');
      }
      this.storage.setStorageSync(targetKey, candidate);
      const readBack = decodeStored(this.storage.getStorageSync(targetKey));
      validateStoredSnapshot(readBack);
      if (canonicalize(readBack) !== canonicalize(candidate)) {
        throw new Error('Strict transaction candidate read-back mismatch');
      }
      this.storage.setStorageSync(ACTIVE_KEY, targetSlot);
      pointerWritten = true;
      if (this.storage.getStorageSync(ACTIVE_KEY) !== targetSlot) {
        throw new Error('Strict transaction pointer read-back mismatch');
      }
      if (operation === 'purge') {
        const cleanup = {
          schema: 'trainflow.purge-cleanup/v1',
          phase: 'cleanup-pending',
          emptySlot: targetSlot,
          emptyRevision: candidate.localRevision,
          emptyChecksum: candidate.checksum,
          oldSlot: state.activeSlot
        };
        this.storage.setStorageSync(CLEANUP_PENDING_KEY, cleanup);
        if (canonicalize(decodeStored(this.storage.getStorageSync(CLEANUP_PENDING_KEY))) !== canonicalize(cleanup)) {
          throw new Error('Purge cleanup marker read-back mismatch');
        }
      }
      this.storage.removeStorageSync(IMPORT_INTENT_KEY);
      return { snapshot: cloneAppDatabase(candidate), oldSlot: state.activeSlot };
    } catch (error) {
      if (operation === 'purge' && this.storage.getStorageSync(CLEANUP_PENDING_KEY) !== undefined) {
        throw error;
      }
      try {
        this.rollbackImportIntent(intent, targetPreimage);
      } catch (rollbackError) {
        throw new Error(`${error.message}; ${rollbackError.message}`);
      }
      if (pointerWritten) {
        throw new Error(`Strict transaction pointer failed and rolled back: ${error.message}`);
      }
      throw error;
    }
  }

  migrate(state) {
    const draft = this.migrateDraft(state.snapshot);
    return this.commitSnapshot(state, draft);
  }

  migrateDraft(snapshot) {
    const draft = cloneAppDatabase(snapshot);
    while (draft.schemaVersion < this.currentSchemaVersion) {
      const fromVersion = draft.schemaVersion;
      if (!Object.prototype.hasOwnProperty.call(this.migrations, fromVersion)) {
        throw new Error(`Missing migration from schemaVersion ${fromVersion}`);
      }
      const migration = this.migrations[fromVersion];
      if (typeof migration !== 'function') {
        throw new Error(`Missing migration from schemaVersion ${fromVersion}`);
      }
      const migrated = migration(draft);
      const next = migrated === undefined ? draft : migrated;
      if (!next || next.schemaVersion !== fromVersion + 1) {
        throw new Error(`Migration from schemaVersion ${fromVersion} must advance exactly one version`);
      }
      if (next !== draft) {
        Object.keys(draft).forEach((key) => delete draft[key]);
        Object.assign(draft, cloneAppDatabase(next));
      }
    }
    return draft;
  }

  commit(mutator, expectedRevision) {
    if (typeof mutator !== 'function') {
      throw new Error('LocalDatabase commit requires a mutator function');
    }
    const state = this.readState();
    assertWritableState(state);
    const normalizedExpectedRevision = normalizeExpectedRevision(
      expectedRevision,
      arguments.length >= 2
    );
    if (
      normalizedExpectedRevision !== undefined &&
      normalizedExpectedRevision !== state.snapshot.localRevision
    ) {
      throw new Error(
        `LocalDatabase revision conflict: expected ${normalizedExpectedRevision}, actual ${state.snapshot.localRevision}`
      );
    }
    if (state.snapshot.localRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('LocalDatabase localRevision overflow: no safe revision remains');
    }

    const draft =
      state.snapshot.schemaVersion < this.currentSchemaVersion
        ? this.migrateDraft(state.snapshot)
        : cloneAppDatabase(state.snapshot);
    mutator(draft);
    return this.commitSnapshot(state, draft);
  }

  commitSnapshot(state, draft) {
    assertWritableState(state);
    if (state.snapshot.localRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('LocalDatabase localRevision overflow: no safe revision remains');
    }
    assertAppDatabaseSnapshot(draft, { checksumRequired: false });
    const latestState = this.readState();
    assertWritableState(latestState);
    if (!sameBaseline(state, latestState)) {
      throw new Error(
        `LocalDatabase revision conflict: expected ${state.snapshot.localRevision}, actual ${latestState.snapshot.localRevision}; concurrent baseline changed from ${state.activeSlot || 'empty'}/${state.snapshot.checksum || 'empty'} to ${latestState.activeSlot || 'empty'}/${latestState.snapshot.checksum || 'empty'}`
      );
    }
    const targetSlot = state.activeSlot === 'a' ? 'b' : 'a';
    const nextPayload = {
      ...cloneAppDatabase(draft),
      localRevision: state.snapshot.localRevision + 1,
      committedAt: this.now()
    };
    delete nextPayload.checksum;
    assertAppDatabaseSnapshot(nextPayload, { checksumRequired: false });
    const nextSnapshot = {
      ...nextPayload,
      checksum: computeChecksum(nextPayload)
    };

    this.storage.setStorageSync(SLOT_KEYS[targetSlot], nextSnapshot);
    const readBack = decodeStored(this.storage.getStorageSync(SLOT_KEYS[targetSlot]));
    try {
      validateStoredSnapshot(readBack);
    } catch (error) {
      throw new Error(`LocalDatabase read-back validation failed: ${error.message}`);
    }
    if (
      readBack.localRevision !== nextSnapshot.localRevision ||
      readBack.schemaVersion !== nextSnapshot.schemaVersion ||
      readBack.checksum !== nextSnapshot.checksum
    ) {
      throw new Error('LocalDatabase read-back validation mismatch');
    }
    this.storage.setStorageSync(ACTIVE_KEY, targetSlot);
    return cloneAppDatabase(readBack);
  }
}

function createLocalDatabase(options) {
  return new LocalDatabase(options);
}

module.exports = { LocalDatabase, createLocalDatabase };
