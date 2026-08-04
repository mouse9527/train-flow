const {
  createHash,
  createHmac,
  timingSafeEqual
} = require('node:crypto');

const GENERIC_AUTH_CODE = 'CLOUD_SYNC_UNAVAILABLE';
const GENERIC_AUTH_MESSAGE = 'Cloud sync is unavailable';

function cloudError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmacSha256(key, value) {
  return createHmac('sha256', key).update(value).digest('hex');
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
    (randomBytes !== undefined && typeof randomBytes !== 'function')
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
    }
  };
}

module.exports = {
  createCloudSyncHandlers,
  hmacSha256,
  sha256
};
