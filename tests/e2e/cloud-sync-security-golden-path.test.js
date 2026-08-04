const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { createCloudSyncHandlers } = require('../../cloudfunctions/shared');
const authEntry = require('../../cloudfunctions/authBootstrap');
const pushEntry = require('../../cloudfunctions/syncPush');
const pullEntry = require('../../cloudfunctions/syncPull');
const purgeEntry = require('../../cloudfunctions/accountPurge');
const {
  assertBootstrapResult,
  assertPullResult,
  assertPushResult,
  assertPurgeResult
} = require('../../miniprogram/services/remote-sync-provider');
const { createCloudSyncStoreDouble } = require('../helpers/cloud-sync-store-double');

const NOW = 1785816000000;
const OPENID = 'openid-e2e-owner';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('golden path: public cloud functions bootstrap, push, pull and purge one isolated account', async () => {
  const store = createCloudSyncStoreDouble();
  const handlers = createCloudSyncHandlers({
    getTrustedContext: () => ({ OPENID }),
    store,
    env: {
      TRAINFLOW_ALLOWED_OPENID_SHA256: sha256(OPENID),
      TRAINFLOW_OWNER_HMAC_KEY: 'e2e-owner-hmac-key-with-at-least-32-bytes',
      TRAINFLOW_CURSOR_HMAC_KEY: 'e2e-cursor-hmac-key-with-at-least-32-bytes',
      TRAINFLOW_PURGE_HMAC_KEY: 'e2e-purge-hmac-key-with-at-least-32-bytes',
      TRAINFLOW_PURGE_TTL_SECONDS: '300'
    },
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 0x4c),
    logger: { info() {}, warn() {}, error() {} }
  });
  const runtime = { createHandlers: () => handlers };
  const bootstrap = authEntry.createMain(() => runtime);
  const push = pushEntry.createMain(() => runtime);
  const pull = pullEntry.createMain(() => runtime);
  const purge = purgeEntry.createMain(() => runtime);

  assertBootstrapResult(await bootstrap({ deviceId: 'device-e2e', schemaVersion: 1 }));
  assertPullResult(await pull({ cursor: null, limit: 10 }));

  const operation = {
    opId: `op_${'e'.repeat(64)}`,
    deviceId: 'device-e2e',
    entityType: 'user_settings',
    entityId: 'settings',
    action: 'upsert',
    baseServerRevision: 0,
    payload: { soundEnabled: false },
    createdAt: NOW - 1,
    attemptCount: 0,
    lastAttemptAt: null
  };
  const pushed = await push({ operations: [operation] });
  assertPushResult(pushed);
  assert.equal(pushed.accepted.length, 1);

  const pulled = await pull({ cursor: null, limit: 10 });
  assertPullResult(pulled);
  assert.equal(pulled.changes.length, 1);
  assert.equal(pulled.changes[0].payload.soundEnabled, false);

  const prepared = await purge({ action: 'prepare', deviceId: 'device-e2e' });
  const receipt = await purge({
    action: 'confirm',
    deviceId: 'device-e2e',
    confirmationToken: prepared.confirmationToken
  });
  assertPurgeResult(receipt);
  assert.deepEqual(receipt, { purgedAt: NOW });
  assert.equal(Object.keys(store.snapshot().entities).length, 0);
  assert.equal(Object.keys(store.snapshot().operations).length, 0);
  assert.equal(store.snapshot().changes.length, 0);
});
