const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  createCloudSyncHandlers
} = require('../../cloudfunctions/shared');

const NOW = 1785816000000;
const ALLOWED_OPENID = 'openid-test-allowed';
const DENIED_OPENID = 'openid-test-denied';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createBootstrapStore() {
  const calls = [];
  return {
    calls,
    async bootstrapOwner(input) {
      calls.push(structuredClone(input));
      return { cursor: null };
    }
  };
}

function createHandlers({
  openId = ALLOWED_OPENID,
  env = {},
  store = createBootstrapStore(),
  logger = { info() {}, warn() {}, error() {} }
} = {}) {
  return {
    store,
    handlers: createCloudSyncHandlers({
      getTrustedContext: () => openId === null ? {} : { OPENID: openId },
      store,
      env: {
        TRAINFLOW_ALLOWED_OPENID_SHA256: sha256(ALLOWED_OPENID),
        TRAINFLOW_OWNER_HMAC_KEY: 'test-only-owner-hmac-key-with-32-bytes',
        TRAINFLOW_CURSOR_HMAC_KEY: 'test-only-cursor-hmac-key-with-32-bytes',
        TRAINFLOW_PURGE_HMAC_KEY: 'test-only-purge-hmac-key-with-32-bytes',
        TRAINFLOW_PURGE_TTL_SECONDS: '300',
        ...env
      },
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 0x2a),
      logger
    })
  };
}

function captureError(invoke) {
  return Promise.resolve()
    .then(invoke)
    .then(
      () => null,
      (error) => error
    );
}

test('AC1: authBootstrap derives one opaque owner from trusted context and ignores forged identity fields', async () => {
  const { handlers, store } = createHandlers();

  const result = await handlers.authBootstrap({
    deviceId: 'device-cloud-security',
    schemaVersion: 1,
    ownerId: 'forged-owner',
    openId: DENIED_OPENID,
    serverRevision: 999,
    createdAt: 1
  });

  assert.deepEqual(result, { cursor: null, serverTime: NOW });
  assert.equal(store.calls.length, 1);
  assert.match(store.calls[0].ownerId, /^owner_[a-f0-9]{64}$/);
  assert.notEqual(store.calls[0].ownerId, 'forged-owner');
  assert.deepEqual(store.calls[0], {
    ownerId: store.calls[0].ownerId,
    deviceId: 'device-cloud-security',
    schemaVersion: 1,
    now: NOW
  });
});

test('AC1: denied, missing and misconfigured identity paths are indistinguishable and reveal no allowlist detail', async () => {
  const attempts = [
    createHandlers({ openId: DENIED_OPENID }),
    createHandlers({ openId: null }),
    createHandlers({ env: { TRAINFLOW_ALLOWED_OPENID_SHA256: '' } })
  ];

  const errors = [];
  for (const { handlers, store } of attempts) {
    errors.push(await captureError(() => handlers.authBootstrap({
      deviceId: 'device-denied',
      schemaVersion: 1
    })));
    assert.equal(store.calls.length, 0);
  }

  for (const error of errors) {
    assert.equal(error.code, 'CLOUD_SYNC_UNAVAILABLE');
    assert.equal(error.message, 'Cloud sync is unavailable');
    assert.doesNotMatch(JSON.stringify(error), /openid|allowlist|allowed|hash|owner/i);
  }
});

test('AC1/AC5: security logs expose only stable metadata and never identity, token or request payload', async () => {
  const entries = [];
  const logger = {
    info(event) { entries.push(event); },
    warn(event) { entries.push(event); },
    error(event) { entries.push(event); }
  };
  const { handlers } = createHandlers({ openId: DENIED_OPENID, logger });
  await captureError(() => handlers.authBootstrap({
    deviceId: 'device-private-value',
    schemaVersion: 1,
    payload: { note: 'private-health-note' },
    confirmationToken: 'private-token'
  }));

  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /openid-test|device-private|private-health|private-token/i);
  assert.doesNotMatch(serialized, /OPENID|ownerId|allowlist|payload|token|cursor/i);
  assert.match(serialized, /CLOUD_SYNC_UNAVAILABLE/);
});
