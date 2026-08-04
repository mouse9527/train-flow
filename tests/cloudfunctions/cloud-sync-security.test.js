const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDefaultPlans } = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createCloudSyncHandlers
} = require('../../cloudfunctions/shared');
const {
  materializeCloudFunctions
} = require('../../scripts/prepare-cloudfunctions');

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
    changes: [],
    purgeConfirmations: {},
    purgeReceipts: {}
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
    async listChanges({ ownerId, epoch, afterSequence, limit }) {
      const account = state.accounts[ownerId] || null;
      if (!account || account.status !== 'active' || account.epoch !== epoch) {
        const error = new Error('cursor unavailable');
        error.code = 'CURSOR_INVALID';
        throw error;
      }
      const raw = state.changes
        .filter((change) => (
          change.ownerId === ownerId &&
          change.epoch === epoch &&
          change.sequence > afterSequence
        ))
        .sort((left, right) => left.sequence - right.sequence);
      return {
        changes: structuredClone(raw.slice(0, limit)),
        hasMore: raw.length > limit
      };
    },
    async getOwnerSyncState(ownerId) {
      const account = state.accounts[ownerId] || null;
      return account ? {
        status: account.status,
        epoch: account.epoch,
        sequence: account.sequence
      } : null;
    },
    async preparePurge(confirmation) {
      state.purgeConfirmations[stateKey(confirmation.ownerId, confirmation.tokenHash)] =
        structuredClone(confirmation);
    },
    async confirmPurge({ ownerId, deviceId, purpose, tokenHash, now }) {
      const key = stateKey(ownerId, tokenHash);
      const receipt = state.purgeReceipts[key] || null;
      if (receipt) return structuredClone(receipt);
      const confirmation = state.purgeConfirmations[key] || null;
      if (
        !confirmation || confirmation.deviceId !== deviceId ||
        confirmation.purpose !== purpose || confirmation.expiresAt < now
      ) {
        const error = new Error('confirmation invalid');
        error.code = 'PURGE_CONFIRMATION_INVALID';
        throw error;
      }
      const account = state.accounts[ownerId] || {
        ownerId, status: 'active', epoch: 1, sequence: 0, createdAt: now, updatedAt: now
      };
      account.status = 'purging';
      account.epoch += 1;
      account.updatedAt = now;
      state.accounts[ownerId] = account;
      for (const keyName of Object.keys(state.entities)) {
        if (JSON.parse(keyName)[0] === ownerId) delete state.entities[keyName];
      }
      for (const keyName of Object.keys(state.operations)) {
        if (JSON.parse(keyName)[0] === ownerId) delete state.operations[keyName];
      }
      state.changes = state.changes.filter((change) => change.ownerId !== ownerId);
      delete state.purgeConfirmations[key];
      const result = { purgedAt: now };
      state.purgeReceipts[key] = result;
      account.status = 'purged';
      return structuredClone(result);
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
  allowedOpenId = ALLOWED_OPENID,
  env = {},
  store = createBootstrapStore(),
  logger = { info() {}, warn() {}, error() {} },
  now = () => NOW,
  randomBytes = (size) => Buffer.alloc(size, 0x2a)
} = {}) {
  return {
    store,
    handlers: createCloudSyncHandlers({
      getTrustedContext: () => openId === null ? {} : { OPENID: openId },
      store,
      env: {
        TRAINFLOW_ALLOWED_OPENID_SHA256: sha256(allowedOpenId),
        TRAINFLOW_OWNER_HMAC_KEY: 'test-only-owner-hmac-key-with-32-bytes',
        TRAINFLOW_CURSOR_HMAC_KEY: 'test-only-cursor-hmac-key-with-32-bytes',
        TRAINFLOW_PURGE_HMAC_KEY: 'test-only-purge-hmac-key-with-32-bytes',
        TRAINFLOW_PURGE_TTL_SECONDS: '300',
        ...env
      },
      now,
      randomBytes,
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
    accounts: {}, entities: {}, operations: {}, changes: [],
    purgeConfirmations: {}, purgeReceipts: {}
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

test('AC4: syncPull uses an opaque owner-bound cursor, coalesces a raw page and advances across every raw change', async () => {
  const store = createMemoryStore();
  const { handlers } = createHandlers({ store });
  const first = syncOperation({ opId: `op_${'7'.repeat(64)}` });
  await handlers.syncPush({ operations: [first] });
  await handlers.syncPush({ operations: [{
    ...first,
    opId: `op_${'8'.repeat(64)}`,
    baseServerRevision: 1,
    payload: { ...first.payload, title: 'Server revision two' }
  }] });
  await handlers.syncPush({ operations: [syncOperation({
    opId: `op_${'9'.repeat(64)}`,
    entityId: 'plan_second_entity',
    payload: { ...first.payload, id: 'plan_second_entity', title: 'Second entity' }
  })] });

  const firstPage = await handlers.syncPull({ cursor: null, limit: 2, ownerId: 'forged' });
  assert.equal(firstPage.changes.length, 1, 'two raw revisions of one entity coalesce to the latest envelope');
  assert.equal(firstPage.changes[0].serverRevision, 2);
  assert.equal(firstPage.hasMore, true);
  assert.match(firstPage.nextCursor, /^cursor_v1\./);
  assert.doesNotMatch(firstPage.nextCursor, /owner_|openid|\b2\b/);

  const secondPage = await handlers.syncPull({ cursor: firstPage.nextCursor, limit: 2 });
  assert.equal(secondPage.changes.length, 1);
  assert.equal(secondPage.changes[0].entityId, 'plan_second_entity');
  assert.equal(secondPage.hasMore, false);
  assert.notEqual(secondPage.nextCursor, firstPage.nextCursor);
});

test('AC4: tampered and cross-owner cursors fail closed while the other owner cannot read changes', async () => {
  const store = createMemoryStore();
  const ownerOne = createHandlers({ store });
  await ownerOne.handlers.syncPush({ operations: [syncOperation()] });
  const page = await ownerOne.handlers.syncPull({ cursor: null, limit: 1 });
  const tampered = `${page.nextCursor.slice(0, -1)}${page.nextCursor.endsWith('A') ? 'B' : 'A'}`;
  const ownerTwo = createHandlers({
    store,
    openId: DENIED_OPENID,
    allowedOpenId: DENIED_OPENID
  });

  for (const invoke of [
    () => ownerOne.handlers.syncPull({ cursor: tampered, limit: 1 }),
    () => ownerTwo.handlers.syncPull({ cursor: page.nextCursor, limit: 1 })
  ]) {
    const error = await captureError(invoke);
    assert.equal(error.code, 'CURSOR_INVALID');
    assert.equal(error.message, 'Sync cursor is invalid');
  }
});

test('AC4: accountPurge prepare/confirm is short-lived, owner/device bound, replay-safe and isolated', async () => {
  const store = createMemoryStore();
  let clock = NOW;
  const ownerOne = createHandlers({ store, now: () => clock });
  const ownerTwo = createHandlers({
    store,
    openId: DENIED_OPENID,
    allowedOpenId: DENIED_OPENID,
    now: () => clock,
    randomBytes: (size) => Buffer.alloc(size, 0x3b)
  });
  await ownerOne.handlers.syncPush({ operations: [syncOperation()] });
  await ownerTwo.handlers.syncPush({ operations: [syncOperation({ opId: `op_${'a'.repeat(64)}` })] });

  const prepared = await ownerOne.handlers.accountPurge({
    action: 'prepare',
    deviceId: 'device-cloud-security'
  });
  assert.deepEqual(Object.keys(prepared), ['confirmationToken', 'expiresAt']);
  assert.match(prepared.confirmationToken, /^purge_v1\./);
  assert.equal(prepared.expiresAt, NOW + 300000);
  assert.doesNotMatch(prepared.confirmationToken, /owner_|openid|device-cloud/);

  const crossOwner = await captureError(() => ownerTwo.handlers.accountPurge({
    action: 'confirm',
    deviceId: 'device-cloud-security',
    confirmationToken: prepared.confirmationToken
  }));
  assert.equal(crossOwner.code, 'PURGE_CONFIRMATION_INVALID');

  const receipt = await ownerOne.handlers.accountPurge({
    action: 'confirm',
    deviceId: 'device-cloud-security',
    confirmationToken: prepared.confirmationToken
  });
  assert.deepEqual(receipt, { purgedAt: NOW });
  assert.deepEqual(await ownerOne.handlers.accountPurge({
    action: 'confirm',
    deviceId: 'device-cloud-security',
    confirmationToken: prepared.confirmationToken
  }), receipt);
  const snapshot = store.snapshot();
  assert.equal(Object.keys(snapshot.entities).length, 1, 'other owner entity remains');
  assert.equal(Object.keys(snapshot.operations).length, 1, 'other owner receipt remains');
  assert.equal(snapshot.changes.length, 1, 'other owner change feed remains');
});

test('AC4: expired or wrongly bound purge confirmation performs no deletion', async () => {
  const store = createMemoryStore();
  let clock = NOW;
  const { handlers } = createHandlers({ store, now: () => clock });
  await handlers.syncPush({ operations: [syncOperation()] });
  const prepared = await handlers.accountPurge({ action: 'prepare', deviceId: 'device-one' });
  clock = prepared.expiresAt + 1;

  for (const deviceId of ['device-two', 'device-one']) {
    const error = await captureError(() => handlers.accountPurge({
      action: 'confirm',
      deviceId,
      confirmationToken: prepared.confirmationToken
    }));
    assert.equal(error.code, 'PURGE_CONFIRMATION_INVALID');
  }
  assert.equal(Object.keys(store.snapshot().entities).length, 1);
});

test('AC1/AC5: all four public cloud entrypoints lazily obtain trusted runtime and expose only their named handler', async () => {
  for (const functionName of ['authBootstrap', 'syncPush', 'syncPull', 'accountPurge']) {
    const entry = require(`../../cloudfunctions/${functionName}`);
    const calls = [];
    let loads = 0;
    const main = entry.createMain(() => {
      loads += 1;
      return {
        createHandlers() {
          return {
            [functionName]: async (event) => {
              calls.push(structuredClone(event));
              return { functionName };
            }
          };
        }
      };
    });

    assert.equal(loads, 0, 'CloudBase SDK/context must not load at module evaluation time');
    assert.deepEqual(await main({ requestId: 'public-entry' }), { functionName });
    assert.equal(loads, 1);
    assert.deepEqual(calls, [{ requestId: 'public-entry' }]);
  }
});

test('AC5: materialized CloudBase function packages are self-contained and match canonical shared source', () => {
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trainflow-cloud-pack-'));
  try {
    const report = materializeCloudFunctions({
      projectRoot: path.resolve(__dirname, '../..'),
      targetRoot
    });
    assert.deepEqual(report.functions, ['accountPurge', 'authBootstrap', 'syncPull', 'syncPush']);
    assert.match(report.sharedDigest, /^[a-f0-9]{64}$/);
    for (const functionName of report.functions) {
      const packageRoot = path.join(targetRoot, functionName);
      const entrySource = fs.readFileSync(path.join(packageRoot, 'index.js'), 'utf8');
      assert.doesNotMatch(entrySource, /require\(['"]\.\.\/shared/);
      assert.match(entrySource, /\.\/_shared\/cloudbase-runtime/);
      const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      assert.equal(packageJson.dependencies['wx-server-sdk'], '4.0.2');
      const sharedDigest = sha256(fs.readFileSync(path.join(packageRoot, '_shared', 'index.js')));
      assert.equal(sharedDigest, report.fileDigests['index.js']);
      assert.equal(
        sha256(fs.readFileSync(path.join(packageRoot, '_shared', 'cloudbase-runtime.js'))),
        report.fileDigests['cloudbase-runtime.js']
      );
    }
  } finally {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('AC5: client source cannot bypass cloud functions with direct sensitive collection access', () => {
  const clientRoot = path.resolve(__dirname, '../../miniprogram');
  const stack = [clientRoot];
  const sources = [];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.name.endsWith('.js')) sources.push(fs.readFileSync(target, 'utf8'));
    }
  }
  const combined = sources.join('\n');
  assert.doesNotMatch(combined, /wx\.cloud\.database\s*\(/);
  assert.doesNotMatch(combined, /collection\s*\(\s*['"]tf_(?:accounts|entities|operations|changes|purge_receipts)['"]\s*\)/);
});

test('AC5: database rules deny every sensitive collection and example env contains names without values', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const rules = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'cloudbase/database.rules.json'),
    'utf8'
  ));
  assert.equal(rules.schema, 'trainflow.cloudbase-database-rules/v1');
  const expectedCollections = [
    'tf_accounts',
    'tf_changes',
    'tf_entities',
    'tf_operations',
    'tf_purge_confirmations',
    'tf_purge_receipts'
  ];
  assert.deepEqual(Object.keys(rules.collections).sort(), expectedCollections);
  for (const collectionName of expectedCollections) {
    assert.deepEqual(rules.collections[collectionName], { read: false, write: false });
  }

  const envLines = fs.readFileSync(path.join(projectRoot, '.env.example'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(envLines, [
    'TRAINFLOW_ALLOWED_OPENID_SHA256=',
    'TRAINFLOW_OWNER_HMAC_KEY=',
    'TRAINFLOW_CURSOR_HMAC_KEY=',
    'TRAINFLOW_PURGE_HMAC_KEY=',
    'TRAINFLOW_PURGE_TTL_SECONDS='
  ]);
  assert.equal(envLines.every((line) => line.endsWith('=')), true);
});

test('AC5: repository ignores local secrets/generated bundles and documents an auditable CloudBase deploy path', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const ignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
  for (const pattern of [
    '.env', '.env.*', '!.env.example', 'cloudbaserc.local.json',
    'project.private.config.json', 'cloudfunctions/*/_shared/'
  ]) {
    assert.match(ignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  const rootPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(rootPackage.scripts['cloud:prepare'], 'node scripts/prepare-cloudfunctions.js');
  const guide = fs.readFileSync(path.join(projectRoot, 'cloudfunctions/README.md'), 'utf8');
  for (const phrase of [
    'npm run cloud:prepare',
    'TRAINFLOW_ALLOWED_OPENID_SHA256',
    'ownerId + entityType + entityId',
    'ownerId + opId',
    'ownerId + epoch + sequence',
    'read: false',
    'write: false',
    'prepare',
    'confirm'
  ]) {
    assert.match(guide, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
