const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDefaultPlans } = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createBaselineTrainingRecord
} = require('../../miniprogram/domain/execution/training-record');
const {
  createCloudSyncHandlers,
  hmacSha256
} = require('../../cloudfunctions/shared');
const {
  COLLECTIONS,
  createCloudBaseStore
} = require('../../cloudfunctions/shared/cloudbase-runtime');
const { assertWirePayload } = require('../../cloudfunctions/shared/wire-validation');
const { mapLocalMutation } = require('../../miniprogram/domain/sync/entity-mapper');
const {
  materializeCloudFunctions
} = require('../../scripts/prepare-cloudfunctions');
const {
  createCloudSyncStoreDouble: createMemoryStore
} = require('../helpers/cloud-sync-store-double');

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

function validTrainingRecord() {
  const planSnapshot = createDefaultPlans({ now: () => NOW })[0];
  return createBaselineTrainingRecord({
    id: 'session_cloud_security',
    planSnapshot,
    trainingDate: planSnapshot.trainingDate,
    status: 'completed',
    startedAt: NOW,
    endedAt: NOW + 1000,
    elapsedActiveSeconds: 1,
    stepResults: planSnapshot.steps.map((step) => ({
      stepId: step.id,
      status: 'completed',
      completedAt: NOW + 1000,
      setResults: []
    }))
  });
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

function createCloudBaseDatabaseDouble() {
  let collections = new Map();
  let failBeforeCommit = 0;
  const queryLog = [];

  function cloneCollections(source) {
    return new Map([...source.entries()].map(([collectionName, documents]) => [
      collectionName,
      new Map([...documents.entries()].map(([id, value]) => [id, structuredClone(value)]))
    ]));
  }

  function documents(state, collectionName) {
    if (!state.has(collectionName)) state.set(collectionName, new Map());
    return state.get(collectionName);
  }

  function matchesFilter(document, filter) {
    return Object.entries(filter).every(([field, expected]) => {
      if (expected && expected.operator === 'gt') return document[field] > expected.value;
      return document[field] === expected;
    });
  }

  function createApi(state) {
    return {
      command: { gt(value) { return { operator: 'gt', value }; } },
      collection(collectionName) {
        return {
          doc(id) {
            return {
              async get() {
                const value = documents(state, collectionName).get(id);
                if (!value) {
                  const error = new Error('document not found');
                  error.code = 'DATABASE_DOCUMENT_NOT_FOUND';
                  throw error;
                }
                return { data: structuredClone(value) };
              },
              async set({ data }) {
                if (Object.prototype.hasOwnProperty.call(data, '_id')) {
                  throw new Error('CloudBase data cannot write _id');
                }
                documents(state, collectionName).set(id, structuredClone({ ...data, _id: id }));
              },
              async remove() {
                documents(state, collectionName).delete(id);
              }
            };
          },
          where(filter) {
            let order = null;
            let maximum = Number.MAX_SAFE_INTEGER;
            const query = {
              orderBy(field, direction) {
                order = { field, direction };
                return query;
              },
              limit(value) {
                maximum = value;
                return query;
              },
              async get() {
                queryLog.push({ collectionName, filter: structuredClone(filter) });
                const result = [...documents(state, collectionName).values()]
                  .filter((document) => matchesFilter(document, filter));
                if (order) {
                  const direction = order.direction === 'desc' ? -1 : 1;
                  result.sort((left, right) => direction * (left[order.field] - right[order.field]));
                }
                return { data: structuredClone(result.slice(0, maximum)) };
              }
            };
            return query;
          }
        };
      }
    };
  }

  const database = createApi(collections);
  database.runTransaction = async (work) => {
    const draft = cloneCollections(collections);
    const result = await work(createApi(draft));
    if (failBeforeCommit > 0) {
      failBeforeCommit -= 1;
      throw new Error('injected CloudBase transaction failure');
    }
    collections.clear();
    for (const [collectionName, stored] of draft.entries()) {
      collections.set(collectionName, stored);
    }
    return structuredClone(result);
  };
  database.failNextCommit = () => { failBeforeCommit += 1; };
  database.queryLog = queryLog;
  database.snapshot = () => Object.fromEntries(
    [...collections.entries()].map(([collectionName, stored]) => [
      collectionName,
      [...stored.values()].map((value) => structuredClone(value))
    ])
  );
  return database;
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

test('P1: one syncPush request rejects duplicate opIds before any transaction or response classification', async () => {
  const store = createMemoryStore();
  const { handlers } = createHandlers({ store });
  const operation = syncOperation();
  const error = await captureError(() => handlers.syncPush({
    operations: [operation, structuredClone(operation)]
  }));

  assert.equal(error.code, 'SYNC_OPERATION_INVALID');
  assert.equal(error.message, 'Sync operation is invalid');
  assert.deepEqual(store.snapshot(), {
    accounts: {}, entities: {}, operations: {}, changes: [],
    purgeConfirmations: {}, purgeReceipts: {}
  });
});

test('P1: malformed closed wire payloads fail before writes for every synced entity type', async () => {
  const plan = createDefaultPlans({ now: () => NOW })[0];
  const record = validTrainingRecord();
  let getterReads = 0;
  const accessorPlan = structuredClone(plan);
  Object.defineProperty(accessorPlan, 'title', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'must not execute';
    }
  });
  const sparsePlan = structuredClone(plan);
  sparsePlan.steps[0].alternatives = new Array(1);
  const symbolPlan = structuredClone(plan);
  symbolPlan[Symbol('private')] = true;
  const cases = [
    ['plan nested unknown', syncOperation({
      payload: { ...plan, steps: [{ ...plan.steps[0], unexpected: true }, ...plan.steps.slice(1)] }
    })],
    ['plan invalid bound', syncOperation({
      payload: { ...plan, estimatedDurationSeconds: -1 }
    })],
    ['plan accessor field', syncOperation({
      opId: `op_${'2'.repeat(64)}`,
      payload: accessorPlan
    })],
    ['plan sparse nested array', syncOperation({
      opId: `op_${'3'.repeat(64)}`,
      payload: sparsePlan
    })],
    ['plan symbol field', syncOperation({
      opId: `op_${'4'.repeat(64)}`,
      payload: symbolPlan
    })],
    ['record nested unknown', syncOperation({
      opId: `op_${'d'.repeat(64)}`,
      entityType: 'training_record',
      entityId: record.id,
      payload: {
        ...record,
        stepResults: [{ ...record.stepResults[0], unexpected: true }, ...record.stepResults.slice(1)]
      }
    })],
    ['record invalid feedback bound', syncOperation({
      opId: `op_${'e'.repeat(64)}`,
      entityType: 'training_record',
      entityId: record.id,
      payload: {
        ...record,
        feedback: {
          rpe: 11,
          weightBeforeKg: null,
          pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
          note: ''
        }
      }
    })],
    ['settings unknown field', syncOperation({
      opId: `op_${'f'.repeat(64)}`,
      entityType: 'user_settings',
      entityId: 'settings',
      payload: { soundEnabled: false, unexpected: true }
    })],
    ['settings invalid type', syncOperation({
      opId: `op_${'0'.repeat(64)}`,
      entityType: 'user_settings',
      entityId: 'settings',
      payload: { defaultRestSeconds: '75' }
    })]
  ];

  for (const [label, operation] of cases) {
    const store = createMemoryStore();
    const { handlers } = createHandlers({ store });
    const error = await captureError(() => handlers.syncPush({ operations: [operation] }));
    assert.equal(error.code, 'SYNC_PAYLOAD_INVALID', label);
    assert.equal(error.message, 'Sync payload is invalid', label);
    assert.deepEqual(store.snapshot(), {
      accounts: {}, entities: {}, operations: {}, changes: [],
      purgeConfirmations: {}, purgeReceipts: {}
    }, label);
  }
  assert.equal(getterReads, 0);
});

test('P1: deployable wire validation stays aligned with client mutation validators', () => {
  const plan = createDefaultPlans({ now: () => NOW })[0];
  const record = validTrainingRecord();
  const validCases = [
    ['workout_plan', plan.id, plan],
    ['training_record', record.id, record],
    ['user_settings', 'settings', { soundEnabled: false, defaultRestSeconds: 90 }]
  ];
  for (const [entityType, entityId, payload] of validCases) {
    assert.doesNotThrow(() => mapLocalMutation({ entityType, entityId, action: 'upsert', payload }));
    assert.doesNotThrow(() => assertWirePayload(entityType, payload));
  }

  const malformedCases = [
    ['workout_plan', plan.id, { ...plan, unknown: true }],
    ['workout_plan', plan.id, { ...plan, steps: [{ ...plan.steps[0], order: 0 }, ...plan.steps.slice(1)] }],
    ['training_record', record.id, { ...record, stepResults: [{ ...record.stepResults[0], unknown: true }, ...record.stepResults.slice(1)] }],
    ['training_record', record.id, { ...record, completedStepCount: -1 }],
    ['user_settings', 'settings', { timezone: 'not a timezone' }],
    ['user_settings', 'settings', { defaultRestSeconds: 601 }]
  ];
  for (const [entityType, entityId, payload] of malformedCases) {
    assert.throws(() => mapLocalMutation({ entityType, entityId, action: 'upsert', payload }));
    assert.throws(() => assertWirePayload(entityType, payload));
  }
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

test('AC2: prototype-pollution keys are rejected at every payload depth', async () => {
  for (const maliciousPayload of [
    JSON.parse(`{"id":"plan_cloud_security","__proto__":{"polluted":"yes"}}`),
    { id: 'plan_cloud_security', nested: { constructor: { prototype: { polluted: 'yes' } } } },
    { id: 'plan_cloud_security', nested: { prototype: { polluted: 'yes' } } }
  ]) {
    const store = createMemoryStore();
    const { handlers } = createHandlers({ store });
    const error = await captureError(() => handlers.syncPush({
      operations: [syncOperation({ entityId: 'plan_cloud_security', payload: maliciousPayload })]
    }));

    assert.equal(error.code, 'SYNC_PAYLOAD_INVALID');
    assert.equal(error.message, 'Sync payload is invalid');
    assert.deepEqual(store.snapshot(), {
      accounts: {}, entities: {}, operations: {}, changes: [],
      purgeConfirmations: {}, purgeReceipts: {}
    });
    assert.equal({}.polluted, undefined);
  }
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

test('AC4: non-monotonic store change sequences fail closed without issuing a regressed cursor', async () => {
  const store = createMemoryStore();
  const { handlers } = createHandlers({ store });
  const first = syncOperation({ opId: `op_${'b'.repeat(64)}` });
  await handlers.syncPush({ operations: [first] });
  await handlers.syncPush({ operations: [{
    ...first,
    opId: `op_${'c'.repeat(64)}`,
    baseServerRevision: 1,
    payload: { ...first.payload, title: 'Revision two' }
  }] });
  const listChanges = store.listChanges.bind(store);
  store.listChanges = async (input) => {
    const page = await listChanges(input);
    return { ...page, changes: page.changes.reverse() };
  };

  const error = await captureError(() => handlers.syncPull({ cursor: null, limit: 2 }));
  assert.equal(error.code, 'CURSOR_INVALID');
  assert.equal(error.message, 'Sync cursor is invalid');
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
  const wrongDeviceReplay = await captureError(() => ownerOne.handlers.accountPurge({
    action: 'confirm',
    deviceId: 'device-other',
    confirmationToken: prepared.confirmationToken
  }));
  assert.equal(wrongDeviceReplay.code, 'PURGE_CONFIRMATION_INVALID');
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
  clock = prepared.expiresAt;

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

test('AC4: CloudBase purge receipts enforce device binding and exact-expiry semantics', async () => {
  const store = createCloudBaseStore(createCloudBaseDatabaseDouble());
  const confirmation = {
    ownerId: 'owner_cloudbase_test',
    deviceId: 'device-one',
    purpose: 'account_purge',
    tokenHash: sha256('confirmation-one'),
    issuedAt: NOW,
    expiresAt: NOW + 300000
  };
  await store.preparePurge(confirmation);
  const exactExpiry = await captureError(() => store.confirmPurge({
    ownerId: confirmation.ownerId,
    deviceId: confirmation.deviceId,
    purpose: confirmation.purpose,
    tokenHash: confirmation.tokenHash,
    now: confirmation.expiresAt
  }));
  assert.equal(exactExpiry.code, 'PURGE_CONFIRMATION_INVALID');

  const fresh = { ...confirmation, tokenHash: sha256('confirmation-two') };
  await store.preparePurge(fresh);
  assert.deepEqual(await store.confirmPurge({
    ownerId: fresh.ownerId,
    deviceId: fresh.deviceId,
    purpose: fresh.purpose,
    tokenHash: fresh.tokenHash,
    now: NOW + 1
  }), { purgedAt: NOW + 1 });
  const wrongDeviceReplay = await captureError(() => store.confirmPurge({
    ownerId: fresh.ownerId,
    deviceId: 'device-other',
    purpose: fresh.purpose,
    tokenHash: fresh.tokenHash,
    now: NOW + 2
  }));
  assert.equal(wrongDeviceReplay.code, 'PURGE_CONFIRMATION_INVALID');
});

test('QA: production CloudBase adapter preserves transactions, owner filters, tombstones and purge isolation', async () => {
  const database = createCloudBaseDatabaseDouble();
  const store = createCloudBaseStore(database);
  const ownerOne = createHandlers({ store });
  const ownerTwo = createHandlers({
    store,
    openId: DENIED_OPENID,
    allowedOpenId: DENIED_OPENID,
    randomBytes: (size) => Buffer.alloc(size, 0x66)
  });
  await ownerOne.handlers.authBootstrap({ deviceId: 'device-one', schemaVersion: 1 });
  await ownerTwo.handlers.authBootstrap({ deviceId: 'device-two', schemaVersion: 1 });

  const firstPlan = createDefaultPlans({ now: () => NOW })[0];
  const secondPlan = {
    ...structuredClone(firstPlan),
    id: 'plan_cloudbase_owner_two',
    title: 'Owner two plan'
  };
  assert.equal((await ownerOne.handlers.syncPush({
    operations: [syncOperation({ payload: firstPlan })]
  })).accepted.length, 1);
  assert.equal((await ownerTwo.handlers.syncPush({
    operations: [syncOperation({
      opId: `op_${'a'.repeat(64)}`,
      entityId: secondPlan.id,
      payload: secondPlan
    })]
  })).accepted.length, 1);

  const ownerOnePage = await ownerOne.handlers.syncPull({ cursor: null, limit: 10 });
  assert.equal(ownerOnePage.changes.length, 1);
  assert.equal(ownerOnePage.changes[0].entityId, firstPlan.id);
  assert.match(ownerOnePage.nextCursor, /^cursor_v1\./);

  database.failNextCommit();
  const rollbackPlan = { ...structuredClone(firstPlan), id: 'plan_cloudbase_rollback' };
  const rollback = await captureError(() => ownerOne.handlers.syncPush({
    operations: [syncOperation({
      opId: `op_${'b'.repeat(64)}`,
      entityId: rollbackPlan.id,
      payload: rollbackPlan
    })]
  }));
  assert.match(rollback.message, /injected CloudBase transaction failure/);
  assert.equal((await ownerOne.handlers.syncPull({ cursor: null, limit: 10 })).changes.length, 1);

  const deleted = await ownerOne.handlers.syncPush({
    operations: [syncOperation({
      opId: `op_${'c'.repeat(64)}`,
      action: 'delete',
      payload: null,
      baseServerRevision: 1
    })]
  });
  assert.equal(deleted.accepted[0].serverRevision, 2);
  const tombstonePage = await ownerOne.handlers.syncPull({ cursor: null, limit: 10 });
  assert.equal(tombstonePage.changes.length, 1);
  assert.equal(tombstonePage.changes[0].deleted, true);
  assert.equal(tombstonePage.changes[0].payload, null);

  const prepared = await ownerOne.handlers.accountPurge({
    action: 'prepare',
    deviceId: 'device-one'
  });
  await ownerOne.handlers.accountPurge({
    action: 'confirm',
    deviceId: 'device-one',
    confirmationToken: prepared.confirmationToken
  });

  const ownerTwoPage = await ownerTwo.handlers.syncPull({ cursor: null, limit: 10 });
  assert.equal(ownerTwoPage.changes.length, 1);
  assert.equal(ownerTwoPage.changes[0].entityId, secondPlan.id);
  const ownerOneId = `owner_${hmacSha256('test-only-owner-hmac-key-with-32-bytes', ALLOWED_OPENID)}`;
  const ownerTwoId = `owner_${hmacSha256('test-only-owner-hmac-key-with-32-bytes', DENIED_OPENID)}`;
  const snapshot = database.snapshot();
  for (const collectionName of [COLLECTIONS.entities, COLLECTIONS.operations, COLLECTIONS.changes]) {
    assert.equal((snapshot[collectionName] || []).some(({ ownerId }) => ownerId === ownerOneId), false);
    assert.equal((snapshot[collectionName] || []).some(({ ownerId }) => ownerId === ownerTwoId), true);
  }
  const ownerAccounts = new Map(snapshot[COLLECTIONS.accounts].map((account) => [account.ownerId, account]));
  assert.equal(ownerAccounts.get(ownerOneId).status, 'purged');
  assert.equal(ownerAccounts.get(ownerTwoId).status, 'active');
  for (const query of database.queryLog.filter(({ collectionName }) => (
    [COLLECTIONS.entities, COLLECTIONS.operations, COLLECTIONS.changes].includes(collectionName)
  ))) {
    assert.equal(typeof query.filter.ownerId, 'string', query.collectionName);
  }
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

test('QA: public push, pull and purge handlers expose one auth failure shape without touching storage', async () => {
  const publicHandlers = [
    ['syncPush', require('../../cloudfunctions/syncPush'), { operations: [] }],
    ['syncPull', require('../../cloudfunctions/syncPull'), { cursor: null, limit: 1 }],
    ['accountPurge', require('../../cloudfunctions/accountPurge'), { action: 'prepare', deviceId: 'device-auth' }]
  ];
  const scenarios = [
    ['denied', () => ({ OPENID: DENIED_OPENID }), sha256(ALLOWED_OPENID)],
    ['missing', () => ({}), sha256(ALLOWED_OPENID)],
    ['misconfigured', () => ({ OPENID: ALLOWED_OPENID }), 'not-a-valid-hash']
  ];
  const observed = [];

  for (const [functionName, entry, event] of publicHandlers) {
    for (const [scenario, getTrustedContext, allowedHashes] of scenarios) {
      let storageTouches = 0;
      const store = new Proxy({}, {
        get() {
          storageTouches += 1;
          return async () => { throw new Error('storage must not be reached'); };
        }
      });
      const handlers = createCloudSyncHandlers({
        getTrustedContext,
        store,
        env: {
          TRAINFLOW_ALLOWED_OPENID_SHA256: allowedHashes,
          TRAINFLOW_OWNER_HMAC_KEY: 'test-only-owner-hmac-key-with-32-bytes',
          TRAINFLOW_CURSOR_HMAC_KEY: 'test-only-cursor-hmac-key-with-32-bytes',
          TRAINFLOW_PURGE_HMAC_KEY: 'test-only-purge-hmac-key-with-32-bytes',
          TRAINFLOW_PURGE_TTL_SECONDS: '300'
        },
        now: () => NOW,
        randomBytes: (size) => Buffer.alloc(size, 0x55),
        logger: { info() {}, warn() {}, error() {} }
      });
      const main = entry.createMain(() => ({ createHandlers: () => handlers }));
      const error = await captureError(() => main(event));
      observed.push({ functionName, scenario, code: error.code, message: error.message });
      assert.equal(storageTouches, 0, `${functionName}/${scenario}`);
      assert.doesNotMatch(JSON.stringify(error), /openid|allowlist|hash|owner|device-auth/i);
    }
  }
  assert.equal(observed.length, 9);
  for (const result of observed) {
    assert.equal(result.code, 'CLOUD_SYNC_UNAVAILABLE');
    assert.equal(result.message, 'Cloud sync is unavailable');
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
      assert.deepEqual(packageJson.overrides, {
        axios: '1.19.0',
        'lodash.unset': '4.18.0'
      });
      const packageLock = JSON.parse(fs.readFileSync(path.resolve(
        __dirname,
        '../../cloudfunctions',
        functionName,
        'package-lock.json'
      ), 'utf8'));
      assert.equal(packageLock.packages['node_modules/wx-server-sdk'].version, '4.0.2');
      assert.equal(
        packageLock.packages['node_modules/@cloudbase/node-sdk'].version,
        '3.17.2'
      );
      assert.equal(packageLock.packages['node_modules/axios'].version, '1.19.0');
      assert.equal(packageLock.packages['node_modules/lodash.unset'].version, '4.18.0');
      const sharedDigest = sha256(fs.readFileSync(path.join(packageRoot, '_shared', 'index.js')));
      assert.equal(sharedDigest, report.fileDigests['index.js']);
      assert.equal(
        sha256(fs.readFileSync(path.join(packageRoot, '_shared', 'cloudbase-runtime.js'))),
        report.fileDigests['cloudbase-runtime.js']
      );
      assert.equal(
        sha256(fs.readFileSync(path.join(packageRoot, '_shared', 'wire-validation.js'))),
        report.fileDigests['wire-validation.js']
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
  const sensitiveCollectionPattern = new RegExp(
    `collection\\s*\\(\\s*['"](?:${Object.values(COLLECTIONS)
      .map((collectionName) => collectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})['"]\\s*\\)`
  );
  assert.doesNotMatch(combined, /wx\.cloud\.database\s*\(/);
  assert.doesNotMatch(combined, sensitiveCollectionPattern);

  const cloudRoot = path.resolve(__dirname, '../../cloudfunctions');
  const cloudStack = [cloudRoot];
  const cloudSources = [];
  while (cloudStack.length > 0) {
    const current = cloudStack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '_shared') continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) cloudStack.push(target);
      else if (entry.name.endsWith('.js')) cloudSources.push(fs.readFileSync(target, 'utf8'));
    }
  }
  assert.doesNotMatch(`${combined}\n${cloudSources.join('\n')}`, /\.watch\s*\(/);
});

test('AC5: database rules deny every sensitive collection and example env contains names without values', () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const rules = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'cloudbase/database.rules.json'),
    'utf8'
  ));
  assert.equal(rules.schema, 'trainflow.cloudbase-database-rules/v1');
  const expectedCollections = Object.values(COLLECTIONS).sort();
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
