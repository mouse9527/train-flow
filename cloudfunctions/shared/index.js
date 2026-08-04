const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual
} = require('node:crypto');

const GENERIC_AUTH_CODE = 'CLOUD_SYNC_UNAVAILABLE';
const GENERIC_AUTH_MESSAGE = 'Cloud sync is unavailable';
const ENTITY_TYPES = new Set(['workout_plan', 'training_record', 'user_settings']);
const ACTIONS = new Set(['upsert', 'delete']);
const MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_USER_SETTINGS = Object.freeze({
  schemaVersion: 1,
  vibrationEnabled: true,
  soundEnabled: true,
  voiceEnabled: false,
  keepScreenOn: true,
  defaultStartLocalTime: '08:35',
  recommendedEndLocalTime: '09:10',
  defaultRestSeconds: 75,
  timezone: 'Asia/Shanghai',
  cloudSyncEnabled: false,
  revision: 1
});
const SERVER_FIELDS = new Set([
  '_id',
  'ownerid',
  'openid',
  'serverrevision',
  'sourcedeviceid',
  'createdat',
  'updatedat'
]);
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cloudError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalize(value[key])}`
  )).join(',')}}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function hmacSha256(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
}

function encryptionKey(secret) {
  return createHash('sha256').update(secret).digest();
}

function assertRandomBytes(randomBytes, size) {
  const value = randomBytes(size);
  if (!Buffer.isBuffer(value) || value.length !== size) {
    throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
  }
  return value;
}

function sealCursor(payload, { secret, randomBytes }) {
  if (!validateSecret(secret)) {
    throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
  }
  const iv = assertRandomBytes(randomBytes, 12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  return `cursor_v1.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

function cursorError() {
  return cloudError('CURSOR_INVALID', 'Sync cursor is invalid');
}

function openCursor(token, { secret, ownerId }) {
  try {
    if (typeof token !== 'string' || !token.startsWith('cursor_v1.') || !validateSecret(secret)) {
      throw cursorError();
    }
    const packed = Buffer.from(token.slice('cursor_v1.'.length), 'base64url');
    if (packed.length < 29) throw cursorError();
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8'));
    if (
      !payload || Object.getPrototypeOf(payload) !== Object.prototype ||
      payload.ownerId !== ownerId ||
      !Number.isSafeInteger(payload.epoch) || payload.epoch < 1 ||
      !Number.isSafeInteger(payload.sequence) || payload.sequence < 0
    ) {
      throw cursorError();
    }
    return payload;
  } catch (_error) {
    throw cursorError();
  }
}

function purgeError() {
  return cloudError('PURGE_CONFIRMATION_INVALID', 'Purge confirmation is invalid');
}

function createPurgeToken({ secret, randomBytes }) {
  if (!validateSecret(secret)) {
    throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
  }
  const nonce = assertRandomBytes(randomBytes, 24).toString('hex');
  const signature = hmacSha256(secret, `purge-v1:${nonce}`);
  return `purge_v1.${nonce}.${signature}`;
}

function assertPurgeToken(token, secret) {
  if (typeof token !== 'string' || !validateSecret(secret)) throw purgeError();
  const match = /^purge_v1\.([a-f0-9]{48})\.([a-f0-9]{64})$/.exec(token);
  if (!match) throw purgeError();
  const expected = hmacSha256(secret, `purge-v1:${match[1]}`);
  if (!safeEqualHex(match[2], expected)) throw purgeError();
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function parseAllowedHashes(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }
  const hashes = value.split(',').map((entry) => entry.trim().toLowerCase());
  return hashes.every((entry) => /^[a-f0-9]{64}$/.test(entry)) ? hashes : [];
}

function validateSecret(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 32;
}

function genericAuthError() {
  return cloudError(GENERIC_AUTH_CODE, GENERIC_AUTH_MESSAGE);
}

function assertPlainJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw cloudError('SYNC_PAYLOAD_INVALID', 'Sync payload is invalid');
    }
    return;
  }
  if (!value || typeof value !== 'object' || ancestors.has(value)) {
    throw cloudError('SYNC_PAYLOAD_INVALID', 'Sync payload is invalid');
  }
  if (
    (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  ) {
    throw cloudError('SYNC_PAYLOAD_INVALID', 'Sync payload is invalid');
  }
  ancestors.add(value);
  for (const key of Object.keys(value)) assertPlainJson(value[key], ancestors);
  ancestors.delete(value);
}

function isSecretField(field) {
  const normalized = field.toLowerCase();
  return SERVER_FIELDS.has(normalized) ||
    /(?:secret|password|token|credential|session_?key)$/.test(normalized);
}

function sanitizePayload(value, { root = true } = {}) {
  assertPlainJson(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item, { root: false }));
  const result = {};
  for (const [field, nested] of Object.entries(value)) {
    const lower = field.toLowerCase();
    if (PROTOTYPE_KEYS.has(lower)) {
      throw cloudError('SYNC_PAYLOAD_INVALID', 'Sync payload is invalid');
    }
    const rootTimestamp = root && (lower === 'createdat' || lower === 'updatedat');
    if (!isSecretField(field) || rootTimestamp) {
      if (!rootTimestamp) result[field] = sanitizePayload(nested, { root: false });
    }
  }
  return result;
}

function assertPayloadSize(payload) {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    throw cloudError('SYNC_PAYLOAD_TOO_LARGE', 'Sync payload is invalid');
  }
}

function normalizeOperation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw cloudError('SYNC_OPERATION_INVALID', 'Sync operation is invalid');
  }
  const operation = {
    opId: input.opId,
    deviceId: input.deviceId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    baseServerRevision: input.baseServerRevision,
    payload: input.payload
  };
  if (
    typeof operation.opId !== 'string' || !/^op_[a-f0-9]{64}$/.test(operation.opId) ||
    typeof operation.deviceId !== 'string' || operation.deviceId.length === 0 ||
    !ENTITY_TYPES.has(operation.entityType) ||
    typeof operation.entityId !== 'string' || operation.entityId.length === 0 ||
    !ACTIONS.has(operation.action) ||
    !Number.isSafeInteger(operation.baseServerRevision) || operation.baseServerRevision < 0
  ) {
    throw cloudError('SYNC_OPERATION_INVALID', 'Sync operation is invalid');
  }
  if (operation.entityType === 'user_settings' && operation.entityId !== 'settings') {
    throw cloudError('SYNC_OPERATION_INVALID', 'Sync operation is invalid');
  }
  if (operation.action === 'delete') {
    if (operation.payload !== null) {
      throw cloudError('SYNC_TOMBSTONE_PAYLOAD_INVALID', 'Sync operation is invalid');
    }
    operation.payload = null;
  } else {
    operation.payload = sanitizePayload(operation.payload);
    if (
      operation.entityType !== 'user_settings' &&
      (!operation.payload || operation.payload.id !== operation.entityId)
    ) {
      throw cloudError('SYNC_ENTITY_ID_MISMATCH', 'Sync operation is invalid');
    }
    assertPayloadSize(operation.payload);
  }
  operation.requestHash = sha256(canonicalize(operation));
  return operation;
}

function materializePayload(operation, current, timestamp) {
  if (operation.action === 'delete') return null;
  if (operation.entityType === 'user_settings') {
    const previous = current && !current.deleted ? current.payload : DEFAULT_USER_SETTINGS;
    return {
      ...cloneJson(previous),
      ...cloneJson(operation.payload),
      schemaVersion: 1,
      revision: previous.revision + 1
    };
  }
  return {
    ...cloneJson(operation.payload),
    createdAt: current && !current.deleted ? current.payload.createdAt : timestamp,
    updatedAt: timestamp
  };
}

function accountFor(ownerId, current, timestamp) {
  if (current) return current;
  return {
    ownerId,
    status: 'active',
    epoch: 1,
    sequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function applyOperation({ store, ownerId, operation, timestamp }) {
  return store.runTransaction(async (transaction) => {
    const existing = await transaction.getOperation(ownerId, operation.opId);
    if (existing) {
      if (existing.requestHash !== operation.requestHash) {
        return { kind: 'rejected', value: { opId: operation.opId, code: 'IDEMPOTENCY_CONFLICT' } };
      }
      return { kind: 'accepted', value: existing.receipt };
    }
    const current = await transaction.getEntity(ownerId, operation.entityType, operation.entityId);
    const currentRevision = current ? current.serverRevision : 0;
    if (operation.baseServerRevision !== currentRevision) {
      if (current) {
        return { kind: 'conflict', value: { opId: operation.opId, remote: current } };
      }
      return { kind: 'rejected', value: { opId: operation.opId, code: 'STALE_REVISION' } };
    }
    const account = accountFor(ownerId, await transaction.getAccount(ownerId), timestamp);
    if (account.status !== 'active') {
      return { kind: 'rejected', value: { opId: operation.opId, code: 'ACCOUNT_UNAVAILABLE' } };
    }
    const serverRevision = currentRevision + 1;
    const payload = materializePayload(operation, current, timestamp);
    const envelope = {
      ownerId,
      entityType: operation.entityType,
      entityId: operation.entityId,
      serverRevision,
      schemaVersion: 1,
      payload,
      deleted: operation.action === 'delete',
      deletedAt: operation.action === 'delete' ? timestamp : null,
      createdAt: current ? current.createdAt : timestamp,
      updatedAt: timestamp,
      sourceDeviceId: operation.deviceId
    };
    const receipt = {
      opId: operation.opId,
      entityType: operation.entityType,
      entityId: operation.entityId,
      serverRevision,
      payloadHash: sha256(canonicalize(payload))
    };
    account.sequence += 1;
    account.updatedAt = timestamp;
    await transaction.putAccount(account);
    await transaction.putEntity(envelope);
    await transaction.putOperation({
      ownerId,
      opId: operation.opId,
      requestHash: operation.requestHash,
      receipt
    });
    await transaction.appendChange({
      ownerId,
      epoch: account.epoch,
      sequence: account.sequence,
      envelope
    });
    return { kind: 'accepted', value: receipt };
  });
}

function authenticate({ getTrustedContext, env }) {
  let context;
  try {
    context = getTrustedContext();
  } catch (_error) {
    throw genericAuthError();
  }
  const openId = context && typeof context.OPENID === 'string' ? context.OPENID : '';
  const allowedHashes = parseAllowedHashes(env.TRAINFLOW_ALLOWED_OPENID_SHA256);
  const ownerKey = env.TRAINFLOW_OWNER_HMAC_KEY;
  if (openId.length === 0 || allowedHashes.length === 0 || !validateSecret(ownerKey)) {
    throw genericAuthError();
  }
  const callerHash = sha256(openId);
  if (!allowedHashes.some((allowedHash) => safeEqualHex(callerHash, allowedHash))) {
    throw genericAuthError();
  }
  return `owner_${hmacSha256(ownerKey, openId)}`;
}

function assertBootstrapInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw cloudError('CLOUD_SYNC_REQUEST_INVALID', 'Cloud sync request is invalid');
  }
  if (typeof event.deviceId !== 'string' || event.deviceId.length === 0 || event.schemaVersion !== 1) {
    throw cloudError('CLOUD_SYNC_REQUEST_INVALID', 'Cloud sync request is invalid');
  }
  return {
    deviceId: event.deviceId,
    schemaVersion: event.schemaVersion
  };
}

function createCloudSyncHandlers({
  getTrustedContext,
  store,
  env,
  now = Date.now,
  randomBytes,
  logger = console
} = {}) {
  if (
    typeof getTrustedContext !== 'function' ||
    !store || typeof store !== 'object' ||
    !env || typeof env !== 'object' || Array.isArray(env) ||
    typeof now !== 'function' ||
    typeof randomBytes !== 'function'
  ) {
    throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
  }

  async function withOwner(functionName, work) {
    let ownerId;
    try {
      ownerId = authenticate({ getTrustedContext, env });
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn({ functionName, code: GENERIC_AUTH_CODE });
      }
      throw error;
    }
    return work(ownerId);
  }

  return {
    authBootstrap(event) {
      return withOwner('authBootstrap', async (ownerId) => {
        if (typeof store.bootstrapOwner !== 'function') {
          throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
        }
        const input = assertBootstrapInput(event);
        const serverTime = now();
        const state = await store.bootstrapOwner({
          ownerId,
          deviceId: input.deviceId,
          schemaVersion: input.schemaVersion,
          now: serverTime
        });
        return {
          cursor: state && typeof state.cursor === 'string' ? state.cursor : null,
          serverTime
        };
      });
    },

    syncPush(event) {
      return withOwner('syncPush', async (ownerId) => {
        if (!event || typeof event !== 'object' || !Array.isArray(event.operations)) {
          throw cloudError('CLOUD_SYNC_REQUEST_INVALID', 'Cloud sync request is invalid');
        }
        if (typeof store.runTransaction !== 'function') {
          throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
        }
        const result = { accepted: [], rejected: [], conflicts: [] };
        for (const input of event.operations) {
          const operation = normalizeOperation(input);
          const classification = await applyOperation({
            store,
            ownerId,
            operation,
            timestamp: now()
          });
          const collection = {
            accepted: 'accepted',
            rejected: 'rejected',
            conflict: 'conflicts'
          }[classification.kind];
          result[collection].push(classification.value);
        }
        return result;
      });
    },

    syncPull(event) {
      return withOwner('syncPull', async (ownerId) => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          throw cloudError('CLOUD_SYNC_REQUEST_INVALID', 'Cloud sync request is invalid');
        }
        const limit = event.limit === undefined ? 50 : event.limit;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw cloudError('CLOUD_SYNC_REQUEST_INVALID', 'Cloud sync request is invalid');
        }
        if (
          typeof store.getOwnerSyncState !== 'function' ||
          typeof store.listChanges !== 'function'
        ) {
          throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
        }
        const state = await store.getOwnerSyncState(ownerId);
        if (!state || state.status !== 'active') throw cursorError();
        const position = event.cursor === null || event.cursor === undefined
          ? { ownerId, epoch: state.epoch, sequence: 0 }
          : openCursor(event.cursor, {
              secret: env.TRAINFLOW_CURSOR_HMAC_KEY,
              ownerId
            });
        if (position.epoch !== state.epoch || position.sequence > state.sequence) {
          throw cursorError();
        }
        let page;
        try {
          page = await store.listChanges({
            ownerId,
            epoch: position.epoch,
            afterSequence: position.sequence,
            limit
          });
        } catch (_error) {
          throw cursorError();
        }
        const rawChanges = page && Array.isArray(page.changes) ? page.changes : [];
        const latestByEntity = new Map();
        let previousSequence = position.sequence;
        for (const change of rawChanges) {
          if (
            !change || change.ownerId !== ownerId || change.epoch !== position.epoch ||
            !Number.isSafeInteger(change.sequence) || change.sequence <= previousSequence ||
            change.sequence > state.sequence ||
            !change.envelope || change.envelope.ownerId !== ownerId
          ) {
            throw cursorError();
          }
          previousSequence = change.sequence;
          latestByEntity.set(
            JSON.stringify([change.envelope.entityType, change.envelope.entityId]),
            change
          );
        }
        const changes = [...latestByEntity.values()]
          .sort((left, right) => left.sequence - right.sequence)
          .map(({ envelope }) => cloneJson(envelope));
        const nextSequence = rawChanges.length > 0
          ? rawChanges[rawChanges.length - 1].sequence
          : position.sequence;
        const nextCursor = nextSequence === 0 ? null : sealCursor({
          ownerId,
          epoch: position.epoch,
          sequence: nextSequence
        }, {
          secret: env.TRAINFLOW_CURSOR_HMAC_KEY,
          randomBytes
        });
        return {
          changes,
          nextCursor,
          hasMore: Boolean(page && page.hasMore)
        };
      });
    },

    accountPurge(event) {
      return withOwner('accountPurge', async (ownerId) => {
        if (
          !event || typeof event !== 'object' || Array.isArray(event) ||
          typeof event.deviceId !== 'string' || event.deviceId.length === 0
        ) {
          throw purgeError();
        }
        const secret = env.TRAINFLOW_PURGE_HMAC_KEY;
        if (event.action === 'prepare') {
          if (typeof store.preparePurge !== 'function') {
            throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
          }
          const ttlSeconds = Number(env.TRAINFLOW_PURGE_TTL_SECONDS);
          if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) {
            throw cloudError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
          }
          const issuedAt = now();
          const confirmationToken = createPurgeToken({ secret, randomBytes });
          const expiresAt = issuedAt + ttlSeconds * 1000;
          await store.preparePurge({
            ownerId,
            deviceId: event.deviceId,
            purpose: 'account_purge',
            tokenHash: sha256(confirmationToken),
            issuedAt,
            expiresAt
          });
          return { confirmationToken, expiresAt };
        }
        if (event.action === 'confirm' && typeof store.confirmPurge === 'function') {
          try {
            assertPurgeToken(event.confirmationToken, secret);
            const receipt = await store.confirmPurge({
              ownerId,
              deviceId: event.deviceId,
              purpose: 'account_purge',
              tokenHash: sha256(event.confirmationToken),
              now: now()
            });
            if (!receipt || !Number.isSafeInteger(receipt.purgedAt) || receipt.purgedAt < 0) {
              throw purgeError();
            }
            return { purgedAt: receipt.purgedAt };
          } catch (_error) {
            throw purgeError();
          }
        }
        throw purgeError();
      });
    }
  };
}

module.exports = {
  createCloudSyncHandlers,
  canonicalize,
  hmacSha256,
  sha256
};
