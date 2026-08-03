const assert = require('node:assert/strict');
const test = require('node:test');

const { StorageDouble, clone } = require('../helpers/storage-double');
const { createDefaultPlans } = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  applyWorkoutCommand,
  createWorkoutSession
} = require('../../miniprogram/domain/execution/workout-session');
const {
  createBaselineTrainingRecord
} = require('../../miniprogram/domain/execution/training-record');
const { canonicalize, computeChecksum } = require('../../miniprogram/utils/checksum');

const FIXED_NOW = 1785719340000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const SLOT_A = 'train_flow:v1:db:a';
const SLOT_B = 'train_flow:v1:db:b';
const ACTIVE = 'train_flow:v1:db:active';
const INSTALL = 'train_flow:v1:install';
const FORBIDDEN_KEY = /^(?:openid|unionid|session_?key|ownerid|token|secret|appsecret|cursor|outbox)$/i;

function loadDatabaseContract(options = {}) {
  const localDatabaseModule = require('../../miniprogram/services/local-database');
  const createLocalDatabase =
    localDatabaseModule.createLocalDatabase ||
    ((databaseOptions) => new localDatabaseModule.LocalDatabase(databaseOptions));

  assert.equal(typeof createLocalDatabase, 'function', 'LocalDatabase must expose a constructor or factory');
  const database = createLocalDatabase(options);
  for (const method of [
    'exportPortableBackup',
    'previewPortableImport',
    'applyPortableImport',
    'prepareLocalPurge',
    'applyLocalPurge'
  ]) {
    assert.equal(typeof database[method], 'function', `LocalDatabase must expose ${method}()`);
  }
  return database;
}

function createDatabase({ storage = new StorageDouble(), now = () => FIXED_NOW, ...options } = {}) {
  return {
    storage,
    database: loadDatabaseContract({ storage, now, ...options })
  };
}

function manualPlan(id, trainingDate, title = `Portable plan ${id}`) {
  const source = createDefaultPlans({ now: () => FIXED_NOW })[2];
  const manual = source.steps.find(({ kind }) => kind === 'manual');
  return {
    ...clone(source),
    id,
    trainingDate,
    title,
    templateSource: null,
    steps: [{
      ...clone(manual),
      id: `step_${id}_manual`,
      order: 1
    }]
  };
}

function completedRecord(sessionId = 'session_portable_fixture') {
  const plan = manualPlan('plan_record_fixture', '2026-08-04');
  const started = createWorkoutSession({
    plan,
    sessionId,
    originDeviceId: 'device_portable_fixture',
    commandKey: `start_${sessionId}`,
    nowMs: FIXED_NOW - 60_000
  });
  const terminal = applyWorkoutCommand(started, {
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: `complete_${sessionId}`,
    nowMs: FIXED_NOW,
    payload: { stepId: started.planSnapshot.steps[0].id }
  }).session;
  return createBaselineTrainingRecord(terminal);
}

function populate(database, overrides = {}) {
  return database.commit((draft) => {
    draft.profile = null;
    draft.settings = {
      ...draft.settings,
      soundEnabled: false,
      defaultRestSeconds: 95,
      revision: draft.settings.revision + 1
    };
    draft.plans = [
      manualPlan('plan_portable_b', '2026-08-06'),
      manualPlan('plan_portable_a', '2026-08-05')
    ];
    draft.records = [completedRecord()];
    draft.notifications = { leaked: 'device-only notification state' };
    draft.statisticsProjection = { leaked: 'device-only projection state' };
    draft.sync = {
      enabled: true,
      provider: 'fixture-provider',
      cursor: 'CURSOR_MUST_NOT_EXPORT',
      lastSyncedAt: FIXED_NOW,
      lastError: null,
      outbox: [{ opId: 'OP_MUST_NOT_EXPORT' }],
      conflicts: [{ ownerId: 'OWNER_MUST_NOT_EXPORT' }]
    };
    Object.assign(draft, clone(overrides));
  });
}

function exportFixture(overrides = {}) {
  const storage = new StorageDouble({
    [INSTALL]: { deviceId: 'device_install_fixture', createdAt: FIXED_NOW - 100_000 }
  });
  const { database } = createDatabase({ storage });
  populate(database, overrides);
  return database.exportPortableBackup();
}

function parsePackage(jsonText) {
  return JSON.parse(jsonText);
}

function rewritePackage(jsonText, mutate) {
  const candidate = parsePackage(jsonText);
  mutate(candidate);
  delete candidate.checksum;
  candidate.checksum = computeChecksum(candidate);
  return JSON.stringify(candidate);
}

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail('expected operation to fail');
}

function errorSignal(error) {
  return `${error && error.code ? error.code : ''} ${error && error.message ? error.message : error}`;
}

function assertNoWrites(storage) {
  assert.deepEqual(
    storage.operations.filter(({ type }) => type === 'write' || type === 'remove'),
    [],
    'validation and preview must not write or remove storage'
  );
}

function assertPreviewRejectsWithoutMutation(database, storage, jsonText, expected) {
  const before = {
    active: storage.peek(ACTIVE),
    a: storage.peek(SLOT_A),
    b: storage.peek(SLOT_B)
  };
  storage.clearOperations();
  const error = captureError(() => database.previewPortableImport(jsonText));
  assert.match(errorSignal(error), expected);
  assertNoWrites(storage);
  assert.deepEqual(
    { active: storage.peek(ACTIVE), a: storage.peek(SLOT_A), b: storage.peek(SLOT_B) },
    before
  );
  return error;
}

function collectForbiddenPaths(value, path = '$', found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY.test(key)) found.push(`${path}.${key}`);
    collectForbiddenPaths(value[key], `${path}.${key}`, found);
  }
  return found;
}

test('[A] Attack: export 必须是固定时钟下的 canonical JSON、稳定排序、有效版本与 checksum', () => {
  const exported = exportFixture();
  const parsed = parsePackage(exported.jsonText);

  assert.equal(exported.jsonText, canonicalize(parsed));
  assert.equal(parsed.format, 'trainflow.local-backup');
  assert.equal(parsed.packageVersion, 1);
  assert.equal(parsed.appSchemaVersion, 1);
  assert.equal(parsed.exportedAt, FIXED_NOW);
  assert.match(parsed.checksum, /^[a-f0-9]{64}$/);
  assert.equal(parsed.checksum, computeChecksum(parsed));
  assert.deepEqual(parsed.data.plans.map(({ id }) => id), [
    'plan_portable_a',
    'plan_portable_b'
  ]);
  assert.deepEqual(parsed.data.records.map(({ id }) => id), [
    'record_session_portable_fixture'
  ]);
  assert.equal(exported.summary.plans, 2);
  assert.equal(exported.summary.records, 1);
  assert.equal(exported.summary.bytes, Buffer.byteLength(exported.jsonText, 'utf8'));
  assert.equal(exported.summary.checksumPrefix, parsed.checksum.slice(0, 8));
});

test('[A] Attack: export 必须闭合且递归排除 identity、sync、server、install 与运行时字段', () => {
  const parsed = parsePackage(exportFixture().jsonText);

  assert.deepEqual(Object.keys(parsed).sort(), [
    'appSchemaVersion',
    'checksum',
    'data',
    'exportedAt',
    'format',
    'packageVersion'
  ]);
  assert.deepEqual(Object.keys(parsed.data).sort(), ['plans', 'profile', 'records', 'settings']);
  assert.deepEqual(collectForbiddenPaths(parsed), []);
  for (const forbidden of [
    'install',
    'deviceId',
    'localRevision',
    'committedAt',
    'activeSession',
    'notifications',
    'statisticsProjection',
    'sync',
    'cloudSyncEnabled',
    'revision',
    'serverRevision',
    '_id'
  ]) {
    assert.equal(JSON.stringify(parsed).includes(`\"${forbidden}\"`), false, `${forbidden} leaked`);
  }
});

test('[A] Attack: 5 MiB 上限必须按 UTF-8 byte 精确判定，不能按 JS 字符数', () => {
  const source = exportFixture().jsonText;
  const exact = `${source}${' '.repeat(MAX_IMPORT_BYTES - Buffer.byteLength(source, 'utf8'))}`;
  const multibyteOverflow = `${exact.slice(0, -1)}训`;
  assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_IMPORT_BYTES);
  assert.equal(Buffer.byteLength(multibyteOverflow, 'utf8'), MAX_IMPORT_BYTES + 2);

  const { database, storage } = createDatabase();
  const preview = database.previewPortableImport(exact);
  assert.equal(preview.packageVersion, 1);
  assertNoWrites(storage);
  assertPreviewRejectsWithoutMutation(database, storage, multibyteOverflow, /IMPORT_TOO_LARGE|too large|5\s*MiB/i);
});

test('[A] Attack: 深度 64 与节点 100000 是闭合边界，超一必须零写拒绝', () => {
  const source = exportFixture().jsonText;
  const deep = rewritePackage(source, (candidate) => {
    let cursor = {};
    candidate.extra = cursor;
    for (let depth = 0; depth < 65; depth += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
  });
  const manyNodes = rewritePackage(source, (candidate) => {
    candidate.extra = Array.from({ length: 100001 }, () => null);
  });
  const { database, storage } = createDatabase();

  assertPreviewRejectsWithoutMutation(database, storage, deep, /IMPORT_(?:DEPTH|STRUCTURE|TOO_COMPLEX)|depth|64/i);
  assertPreviewRejectsWithoutMutation(database, storage, manyNodes, /IMPORT_(?:NODE|STRUCTURE|TOO_COMPLEX)|node|100000/i);
});

test('[A] Attack: malformed、null/array root、未知字段、future version、checksum 损坏全部零写', async (t) => {
  const source = exportFixture().jsonText;
  const cases = [
    ['malformed', '{"format":', /IMPORT_JSON_INVALID|JSON|parse/i],
    ['null root', 'null', /IMPORT_JSON_INVALID|root|object/i],
    ['array root', '[]', /IMPORT_JSON_INVALID|root|object/i],
    ['unknown root field', rewritePackage(source, (value) => { value.extra = true; }), /IMPORT_UNKNOWN_FIELD|unknown|unexpected/i],
    ['future package', rewritePackage(source, (value) => { value.packageVersion = 99; }), /IMPORT_SCHEMA_UNSUPPORTED|future|packageVersion|升级/i],
    ['future app schema', rewritePackage(source, (value) => { value.appSchemaVersion = 99; }), /IMPORT_SCHEMA_UNSUPPORTED|future|appSchemaVersion|升级/i],
    ['checksum mismatch', source.replace(/"checksum":"[a-f0-9]{64}"/, '"checksum":"0000000000000000000000000000000000000000000000000000000000000000"'), /IMPORT_CHECKSUM_MISMATCH|checksum/i]
  ];

  for (const [name, jsonText, expected] of cases) {
    await t.test(name, () => {
      const { database, storage } = createDatabase();
      assertPreviewRejectsWithoutMutation(database, storage, jsonText, expected);
    });
  }
});

test('[A] Attack: 任意层级大小写变体的 secret/prototype-pollution key 必须 fail closed 且不回显值', async (t) => {
  const source = exportFixture().jsonText;
  const secretValue = 'PRIVATE_VALUE_MUST_NOT_ECHO_71f9';
  for (const key of ['ownerId', 'OpenID', 'session_key', 'authToken', 'AppSecret', 'cursor', 'outbox', '__proto__', 'constructor', 'prototype']) {
    await t.test(key, () => {
      const candidate = parsePackage(source);
      const raw = JSON.stringify(candidate).replace(
        '"settings":{',
        `"settings":{"${key}":"${secretValue}",`
      );
      const parsed = JSON.parse(raw);
      parsed.checksum = computeChecksum(parsed);
      const jsonText = JSON.stringify(parsed);
      const { database, storage } = createDatabase();
      const error = assertPreviewRejectsWithoutMutation(
        database,
        storage,
        jsonText,
        /IMPORT_FORBIDDEN_FIELD|forbidden|dangerous|prototype/i
      );
      assert.equal(errorSignal(error).includes(secretValue), false, 'error must not echo secret value');
    });
  }
});

test('[A] Attack: package migration 必须逐版，缺失、跳级或抛错均零写', async (t) => {
  const source = exportFixture().jsonText;
  const legacy = rewritePackage(source, (value) => { value.packageVersion = 0; });

  await t.test('missing migration', () => {
    const { database, storage } = createDatabase({ portableMigrations: {} });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /missing migration|IMPORT_SCHEMA_UNSUPPORTED/i);
  });

  await t.test('migration jumps a version', () => {
    const { database, storage } = createDatabase({
      portableMigrations: {
        0(value) {
          value.packageVersion = 2;
          return value;
        }
      }
    });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /exactly one|sequential|migration/i);
  });

  await t.test('migration throws', () => {
    const { database, storage } = createDatabase({
      portableMigrations: {
        0() { throw new Error('fixture migration failed'); }
      }
    });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /fixture migration failed|migration/i);
  });
});

test('[A] Attack: 重复 plan id、active date 与 step id 不得静默覆盖', async (t) => {
  const source = exportFixture().jsonText;
  const cases = [
    ['plan id', (value) => { value.data.plans[1].id = value.data.plans[0].id; }, /IMPORT_DUPLICATE_PLAN_ID|duplicate.*plan/i],
    ['active date', (value) => { value.data.plans[1].trainingDate = value.data.plans[0].trainingDate; }, /IMPORT_DUPLICATE_PLAN_DATE|duplicate.*date/i],
    ['step id', (value) => { value.data.plans[0].steps.push(clone(value.data.plans[0].steps[0])); }, /IMPORT_DOMAIN_INVALID|step.*unique|duplicate.*step/i]
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const { database, storage } = createDatabase();
      assertPreviewRejectsWithoutMutation(database, storage, rewritePackage(source, mutate), expected);
    });
  }
});

test('[A] Attack: 重复 record id/sourceSessionId 与二者 identity mismatch 必须硬冲突', async (t) => {
  const source = exportFixture().jsonText;
  const cases = [
    ['duplicate record id', (value) => { value.data.records.push(clone(value.data.records[0])); }, /IMPORT_RECORD_ID_CONFLICT|duplicate.*record/i],
    ['duplicate sourceSessionId', (value) => {
      const duplicate = clone(value.data.records[0]);
      duplicate.id = 'record_another_id';
      value.data.records.push(duplicate);
    }, /IMPORT_RECORD_ID_CONFLICT|sourceSessionId|identity/i],
    ['identity mismatch', (value) => { value.data.records[0].id = 'record_wrong_session'; }, /IMPORT_RECORD_ID_CONFLICT|sourceSessionId|identity/i]
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, () => {
      const { database, storage } = createDatabase();
      assertPreviewRejectsWithoutMutation(database, storage, rewritePackage(source, mutate), expected);
    });
  }
});

test('[A] Attack: settings、plan、record/tombstone 必须复用严格 domain validator', async (t) => {
  const source = exportFixture().jsonText;
  const cases = [
    ['settings range', (value) => { value.data.settings.defaultRestSeconds = 601; }],
    ['settings finite number', (value) => { value.data.settings.defaultRestSeconds = null; }],
    ['plan closed schema', (value) => { value.data.plans[0].unexpected = true; }],
    ['record immutable terminal source', (value) => { value.data.records[0].endedAt += 1; }],
    ['record closed schema', (value) => { value.data.records[0].unexpected = true; }],
    ['invalid tombstone', (value) => {
      value.data.records[0] = {
        id: value.data.records[0].id,
        sourceSessionId: value.data.records[0].sourceSessionId,
        deletedAt: FIXED_NOW
      };
    }]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const { database, storage } = createDatabase();
      assertPreviewRejectsWithoutMutation(
        database,
        storage,
        rewritePackage(source, mutate),
        /IMPORT_DOMAIN_INVALID|domain|settings|plan|record|tombstone/i
      );
    });
  }
});

test('[A] Attack: preview 在 stale pointer 下仍必须严格零写，不能顺手修 pointer', () => {
  const source = exportFixture().jsonText;
  const { database, storage } = createDatabase();
  database.commit((draft) => { draft.settings.soundEnabled = false; });
  database.commit((draft) => { draft.settings.vibrationEnabled = false; });
  const newest = storage.peek(ACTIVE);
  const stale = newest === 'a' ? 'b' : 'a';
  storage.seed(ACTIVE, stale);
  storage.clearOperations();

  const preview = database.previewPortableImport(source);

  assert.ok(preview.confirmationId);
  assert.equal(storage.peek(ACTIVE), stale);
  assertNoWrites(storage);
});

test('[A] Attack: confirmation 必须绑定 normalized digest、baseline、TTL 与 single-use', async (t) => {
  const source = exportFixture().jsonText;

  await t.test('semantic TOCTOU replacement', () => {
    const { database, storage } = createDatabase();
    const preview = database.previewPortableImport(source);
    const replacement = rewritePackage(source, (value) => {
      value.data.settings.soundEnabled = !value.data.settings.soundEnabled;
    });
    storage.clearOperations();
    const error = captureError(() => database.applyPortableImport(replacement, preview.confirmationId));
    assert.match(errorSignal(error), /digest|confirmation|TOCTOU|mismatch/i);
    assertNoWrites(storage);
  });

  await t.test('equivalent raw JSON normalizes to the same candidate', () => {
    const { database } = createDatabase();
    const preview = database.previewPortableImport(source);
    const reformatted = JSON.stringify(parsePackage(source), null, 2);
    const result = database.applyPortableImport(reformatted, preview.confirmationId);
    assert.equal(result.applied, true);
  });

  await t.test('baseline changes after preview', () => {
    const { database, storage } = createDatabase();
    const preview = database.previewPortableImport(source);
    database.commit((draft) => { draft.settings.soundEnabled = !draft.settings.soundEnabled; });
    storage.clearOperations();
    const error = captureError(() => database.applyPortableImport(source, preview.confirmationId));
    assert.match(errorSignal(error), /baseline|revision|confirmation/i);
    assertNoWrites(storage);
  });

  await t.test('expired confirmation', () => {
    let now = FIXED_NOW;
    const { database, storage } = createDatabase({ now: () => now, confirmationTtlMs: 300000 });
    const preview = database.previewPortableImport(source);
    now += 300001;
    storage.clearOperations();
    const error = captureError(() => database.applyPortableImport(source, preview.confirmationId));
    assert.match(errorSignal(error), /expired|TTL|confirmation/i);
    assertNoWrites(storage);
  });

  await t.test('single use', () => {
    const { database, storage } = createDatabase();
    const preview = database.previewPortableImport(source);
    database.applyPortableImport(source, preview.confirmationId);
    storage.clearOperations();
    const error = captureError(() => database.applyPortableImport(source, preview.confirmationId));
    assert.match(errorSignal(error), /consumed|single.?use|confirmation/i);
    assertNoWrites(storage);
  });
});

test('[A] Attack: activeSession 必须在 preview 与 apply 两阶段阻断且零写', async (t) => {
  const source = exportFixture().jsonText;
  const activeSession = createWorkoutSession({
    plan: manualPlan('plan_active_guard', '2026-08-07'),
    sessionId: 'session_active_guard',
    originDeviceId: 'device_active_guard',
    commandKey: 'start_active_guard',
    nowMs: FIXED_NOW
  });

  await t.test('preview guard', () => {
    const { database, storage } = createDatabase();
    database.commit((draft) => { draft.activeSession = clone(activeSession); });
    storage.clearOperations();
    const error = captureError(() => database.previewPortableImport(source));
    assert.match(errorSignal(error), /IMPORT_ACTIVE_SESSION|active.?session|训练/i);
    assertNoWrites(storage);
  });

  await t.test('apply guard', () => {
    const { database, storage } = createDatabase();
    const preview = database.previewPortableImport(source);
    database.commit((draft) => { draft.activeSession = clone(activeSession); });
    storage.clearOperations();
    const error = captureError(() => database.applyPortableImport(source, preview.confirmationId));
    assert.match(errorSignal(error), /IMPORT_ACTIVE_SESSION|active.?session|训练/i);
    assertNoWrites(storage);
  });
});
