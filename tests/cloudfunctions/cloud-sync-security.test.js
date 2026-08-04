const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { createDefaultPlans } = require('../../miniprogram/domain/planning/default-plan-factory');
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

function stateKey(...parts) {
  return JSON.stringify(parts);
}

function createMemoryStore({ retryCallbacks = 0, failBeforeCommit = 0 } = {}) {
  let state = {
    accounts: {},
    entities: {},
    operations: {},
    changes: []
  };
  let queue = Promise.resolve();

  function transactionFor(draft) {
    return {
      getAccount(ownerId) {
        return structuredClone(draft.accounts[ownerId] || null);
      },
      putAccount(account) {
        draft.accounts[account.ownerId] = structuredClone(account);
      },
      getOperation(ownerId, opId) {
        return structuredClone(draft.operations[stateKey(ownerId, opId)] || null);
      },
      putOperation(operation) {
        draft.operations[stateKey(operation.ownerId, operation.opId)] = structuredClone(operation);
      },
      getEntity(ownerId, entityType, entityId) {
        return structuredClone(draft.entities[stateKey(ownerId, entityType, entityId)] || null);
      },
      putEntity(entity) {
        draft.entities[stateKey(entity.ownerId, entity.entityType, entity.entityId)] = structuredClone(entity);
      },
      appendChange(change) {
        draft.changes.push(structuredClone(change));
      }
    };
  }

  const store = {
    async bootstrapOwner({ ownerId }) {
      const account = state.accounts[ownerId];
      return { cursor: account && account.sequence > 0 ? `memory-${account.sequence}` : null };
    },
    runTransaction(work) {
      const previous = queue;
      let release;
      queue = new Promise((resolve) => { release = resolve; });
      return previous.then(async () => {
        try {
          while (retryCallbacks > 0) {
            retryCallbacks -= 1;
            const discarded = structuredClone(state);
            await work(transactionFor(discarded));
          }
          const draft = structuredClone(state);
          const result = await work(transactionFor(draft));
          if (failBeforeCommit > 0) {
            failBeforeCommit -= 1;
            throw new Error('injected transaction failure');
          }
          state = draft;
          return structuredClone(result);
        } finally {
          release();
        }
      });
    },
    snapshot() {
      return structuredClone(state);
    }
  };
  return store;
}

function syncOperation({
  opId = `op_${'1'.repeat(64)}`,
  deviceId = 'device-cloud-security',
  entityType = 'workout_plan',
  entityId = 'plan_20260803_builtin',
  action = 'upsert',
  baseServerRevision = 0,
  payload = createDefaultPlans({ now: () => NOW })[0],
  createdAt = NOW - 1000,
  attemptCount = 0,
  lastAttemptAt = null,
  ...hostile
} = {}) {
  return {
    opId,
    deviceId,
    entityType,
    entityId,
    action,
    baseServerRevision,
    payload,
    createdAt,
    attemptCount,
    lastAttemptAt,
    ...hostile
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

test('AC2/AC3: syncPush ignores forged server facts and atomically writes entity, receipt and change', async () => {
  const store = createMemoryStore({ retryCallbacks: 1 });
  const { handlers } = createHandlers({ store });
  const plan = createDefaultPlans({ now: () => NOW })[0];
  const operation = syncOperation({
    ownerId: 'forged-owner',
    openId: DENIED_OPENID,
    serverRevision: 99,
    updatedAt: 1,
    payload: {
      ...plan,
      ownerId: 'payload-forged-owner',
      serverRevision: 77,
      createdAt: 1,
      updatedAt: 2,
      secret: 'must-be-stripped',
      steps: plan.steps.map((step, index) => index === 0
        ? { ...step, accessToken: 'nested-secret' }
        : step)
    }
  });

  const result = await handlers.syncPush({
    operations: [operation],
    ownerId: 'request-forged-owner',
    serverTime: 1
  });

  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(Object.keys(result.accepted[0]), [
    'opId', 'entityType', 'entityId', 'serverRevision', 'payloadHash'
  ]);
  const snapshot = store.snapshot();
  assert.equal(Object.keys(snapshot.entities).length, 1);
  assert.equal(Object.keys(snapshot.operations).length, 1);
  assert.equal(snapshot.changes.length, 1, 'transaction callback retry must not duplicate change feed rows');
  const entity = Object.values(snapshot.entities)[0];
  assert.match(entity.ownerId, /^owner_[a-f0-9]{64}$/);
  assert.equal(entity.serverRevision, 1);
  assert.equal(entity.createdAt, NOW);
  assert.equal(entity.updatedAt, NOW);
  assert.equal(entity.sourceDeviceId, operation.deviceId);
  assert.equal(entity.payload.ownerId, undefined);
  assert.equal(entity.payload.serverRevision, undefined);
  assert.equal(entity.payload.createdAt, NOW, 'domain timestamps are re-derived by the server');
  assert.equal(entity.payload.updatedAt, NOW, 'domain timestamps are re-derived by the server');
  assert.equal(entity.payload.secret, undefined);
  assert.equal(entity.payload.steps[0].accessToken, undefined);
});

test('AC3: duplicate opId replays one receipt, excludes retry metadata from identity and rejects changed intent', async () => {
  const store = createMemoryStore();
  const { handlers } = createHandlers({ store });
  const first = syncOperation();
  const accepted = await handlers.syncPush({ operations: [first] });
  const replay = await handlers.syncPush({
    operations: [{ ...first, createdAt: NOW + 2000, attemptCount: 7, lastAttemptAt: NOW + 3000 }]
  });
  const changed = await handlers.syncPush({
    operations: [{ ...first, payload: { ...first.payload, title: 'Changed intent' } }]
  });

  assert.deepEqual(replay, accepted);
  assert.deepEqual(changed.accepted, []);
  assert.deepEqual(changed.conflicts, []);
  assert.deepEqual(changed.rejected, [{ opId: first.opId, code: 'IDEMPOTENCY_CONFLICT' }]);
  const snapshot = store.snapshot();
  assert.equal(Object.keys(snapshot.entities).length, 1);
  assert.equal(Object.keys(snapshot.operations).length, 1);
  assert.equal(snapshot.changes.length, 1);
});

test('AC3: concurrent same-base writes accept exactly one and return one owner-scoped conflict', async () => {
  const store = createMemoryStore();
  const { handlers } = createHandlers({ store });
  const first = syncOperation({ opId: `op_${'2'.repeat(64)}` });
  const second = syncOperation({
    opId: `op_${'3'.repeat(64)}`,
    payload: { ...first.payload, title: 'Concurrent edit' }
  });

  const results = await Promise.all([
    handlers.syncPush({ operations: [first] }),
    handlers.syncPush({ operations: [second] })
  ]);

  assert.equal(results.flatMap(({ accepted }) => accepted).length, 1);
  const conflicts = results.flatMap((result) => result.conflicts);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].remote.serverRevision, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(conflicts[0].remote, 'ownerId'), true);
  assert.match(conflicts[0].remote.ownerId, /^owner_[a-f0-9]{64}$/);
  const snapshot = store.snapshot();
  assert.equal(Object.keys(snapshot.entities).length, 1);
  assert.equal(Object.keys(snapshot.operations).length, 1);
  assert.equal(snapshot.changes.length, 1);
});

test('AC3: transaction failure leaves entity, receipt and change feed all absent', async () => {
  const store = createMemoryStore({ failBeforeCommit: 1 });
  const { handlers } = createHandlers({ store });
  const error = await captureError(() => handlers.syncPush({ operations: [syncOperation()] }));

  assert.match(error.message, /transaction failure/);
  assert.deepEqual(store.snapshot(), {
    accounts: {}, entities: {}, operations: {}, changes: []
  });
});

test('AC2/AC3: delete writes a server-timed tombstone and stale delete cannot erase a newer revision', async () => {
  const store = createMemoryStore();
  const { handlers } = createHandlers({ store });
  const upsert = syncOperation({ opId: `op_${'4'.repeat(64)}` });
  await handlers.syncPush({ operations: [upsert] });
  const staleDelete = syncOperation({
    opId: `op_${'5'.repeat(64)}`,
    action: 'delete',
    payload: null,
    baseServerRevision: 0
  });
  const stale = await handlers.syncPush({ operations: [staleDelete] });
  assert.equal(stale.accepted.length, 0);
  assert.equal(stale.conflicts.length, 1);

  const freshDelete = { ...staleDelete, opId: `op_${'6'.repeat(64)}`, baseServerRevision: 1 };
  const accepted = await handlers.syncPush({ operations: [freshDelete] });
  assert.equal(accepted.accepted[0].serverRevision, 2);
  const entity = Object.values(store.snapshot().entities)[0];
  assert.equal(entity.deleted, true);
  assert.equal(entity.payload, null);
  assert.equal(entity.deletedAt, NOW);
  assert.equal(entity.updatedAt, NOW);
});
