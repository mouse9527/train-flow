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
const {
  applyTrainingRecordCorrection
} = require('../../miniprogram/domain/records/training-record');
const { canonicalize, computeChecksum } = require('../../miniprogram/utils/checksum');

const FIXED_NOW = 1785719340000;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const SLOT_A = 'train_flow:v1:db:a';
const SLOT_B = 'train_flow:v1:db:b';
const ACTIVE = 'train_flow:v1:db:active';
const INSTALL = 'train_flow:v1:install';
const IMPORT_INTENT = 'train_flow:v1:db:import-intent';
const CLEANUP_PENDING = 'train_flow:v1:db:cleanup-pending';
const FORBIDDEN_KEY = /^(?:openid|unionid|session_?key|ownerid|(?:auth)?token|secret|appsecret|cursor|outbox)$/i;

function loadDatabaseContract(options = {}, requiredMethods = []) {
  const localDatabaseModule = require('../../miniprogram/services/local-database');
  const createLocalDatabase =
    localDatabaseModule.createLocalDatabase ||
    ((databaseOptions) => new localDatabaseModule.LocalDatabase(databaseOptions));

  assert.equal(typeof createLocalDatabase, 'function', 'LocalDatabase must expose a constructor or factory');
  const database = createLocalDatabase(options);
  for (const method of requiredMethods) {
    assert.equal(typeof database[method], 'function', `LocalDatabase must expose ${method}()`);
  }
  return database;
}

function createDatabase({
  storage = new StorageDouble(),
  now = () => FIXED_NOW,
  requiredMethods = [],
  ...options
} = {}) {
  return {
    storage,
    database: loadDatabaseContract({ storage, now, ...options }, requiredMethods)
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
    draft.notifications = {
      expiredOccurrences: ['device-only-expired-occurrence'],
      pendingExpiredOccurrences: ['device-only-pending-occurrence'],
      attemptedExpiredOccurrences: ['device-only-attempted-occurrence'],
      terminalOccurrences: ['device-only-terminal-occurrence']
    };
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
  const { database } = createDatabase({ storage, requiredMethods: ['exportPortableBackup'] });
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
    'serverRevision',
    '_id'
  ]) {
    assert.equal(JSON.stringify(parsed).includes(`\"${forbidden}\"`), false, `${forbidden} leaked`);
  }
  assert.equal(Object.hasOwn(parsed.data.settings, 'revision'), false, 'settings revision leaked');
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
    candidate.data.profile = cursor;
    for (let depth = 0; depth < 65; depth += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
  });
  const manyNodes = rewritePackage(source, (candidate) => {
    candidate.data.plans = Array.from({ length: 100001 }, () => null);
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
    const { database, storage } = createDatabase({
      portableMigrations: {},
      packageMigrations: {}
    });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /missing migration|IMPORT_SCHEMA_UNSUPPORTED/i);
  });

  await t.test('migration jumps a version', () => {
    const packageMigrations = {
        0(value) {
          value.packageVersion = 2;
          return value;
        }
      };
    const { database, storage } = createDatabase({ portableMigrations: packageMigrations, packageMigrations });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /exactly one|sequential|migration/i);
  });

  await t.test('migration throws', () => {
    const packageMigrations = {
        0() { throw new Error('fixture migration failed'); }
      };
    const { database, storage } = createDatabase({ portableMigrations: packageMigrations, packageMigrations });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /fixture migration failed|migration/i);
  });
});

test('[A] Attack: app schema migration 缺失、跳级或抛错同样必须零写', async (t) => {
  const source = exportFixture().jsonText;
  const legacy = rewritePackage(source, (value) => { value.appSchemaVersion = 0; });

  await t.test('missing app migration', () => {
    const { database, storage } = createDatabase({
      portableAppMigrations: {},
      appMigrations: {}
    });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /missing.*app.*migration|IMPORT_SCHEMA_UNSUPPORTED/i);
  });

  await t.test('app migration jumps a version', () => {
    const appMigrations = {
      0(value) {
        value.appSchemaVersion = 2;
        return value;
      }
    };
    const { database, storage } = createDatabase({ portableAppMigrations: appMigrations, appMigrations });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /exactly one|sequential|app.*migration/i);
  });

  await t.test('app migration throws', () => {
    const appMigrations = {
      0() { throw new Error('fixture app migration failed'); }
    };
    const { database, storage } = createDatabase({ portableAppMigrations: appMigrations, appMigrations });
    assertPreviewRejectsWithoutMutation(database, storage, legacy, /fixture app migration failed|app.*migration/i);
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

function createTargetDatabase({
  title = 'PRIVATE_OLD_PLAN_TITLE_4b1c',
  settings = {},
  sync = {},
  now = () => FIXED_NOW,
  options = {}
} = {}) {
  const storage = new StorageDouble({
    [INSTALL]: { deviceId: 'device_target_install', createdAt: FIXED_NOW - 500_000 }
  });
  const { database } = createDatabase({ storage, now, ...options });
  database.commit((draft) => {
    draft.settings = {
      ...draft.settings,
      revision: 7,
      vibrationEnabled: false,
      soundEnabled: true,
      defaultRestSeconds: 45,
      ...clone(settings)
    };
    draft.plans = [manualPlan('plan_old_private', '2026-07-31', title)];
    draft.records = [completedRecord('session_old_private')];
    draft.statisticsProjection = { oldPrivateProjection: true };
    draft.notifications = {
      expiredOccurrences: ['plan_old_private'],
      pendingExpiredOccurrences: [],
      attemptedExpiredOccurrences: [],
      terminalOccurrences: []
    };
    draft.sync = {
      ...draft.sync,
      ...clone(sync)
    };
  });
  return { database, storage };
}

function durableState(storage) {
  return {
    [SLOT_A]: storage.peek(SLOT_A),
    [SLOT_B]: storage.peek(SLOT_B),
    [ACTIVE]: storage.peek(ACTIVE),
    [INSTALL]: storage.peek(INSTALL),
    [IMPORT_INTENT]: storage.peek(IMPORT_INTENT),
    [CLEANUP_PENDING]: storage.peek(CLEANUP_PENDING)
  };
}

function seedDurableState(state) {
  const compact = {};
  for (const [key, value] of Object.entries(state)) {
    if (value !== undefined) compact[key] = clone(value);
  }
  return new StorageDouble(compact);
}

function replayMutations(initialState, operations) {
  const storage = seedDurableState(initialState);
  for (const operation of operations) {
    if (operation.type === 'write') storage.seed(operation.key, operation.value);
    if (operation.type === 'remove') storage.values.delete(operation.key);
  }
  storage.clearOperations();
  return storage;
}

function mutationOperations(storage) {
  return storage.operations.filter(({ type }) => type === 'write' || type === 'remove');
}

function inactiveSlotKey(storage) {
  return storage.peek(ACTIVE) === 'a' ? SLOT_B : SLOT_A;
}

function assertPortableState(snapshot, packageData) {
  assert.equal(snapshot.profile, null);
  assert.deepEqual(snapshot.plans, packageData.plans);
  assert.deepEqual(snapshot.records, packageData.records);
  const { revision, cloudSyncEnabled, ...portableSettings } = snapshot.settings;
  assert.deepEqual(portableSettings, packageData.settings);
  assert.equal(cloudSyncEnabled, false);
}

function assertRuntimeMetadataRebuilt(snapshot, expectedInstall) {
  assert.deepEqual(snapshot.install, expectedInstall);
  assert.equal(snapshot.activeSession, null);
  assert.deepEqual(snapshot.notifications, {
    expiredOccurrences: [],
    pendingExpiredOccurrences: [],
    attemptedExpiredOccurrences: [],
    terminalOccurrences: []
  });
  assert.equal(snapshot.statisticsProjection.dirty, true);
  assert.match(String(snapshot.statisticsProjection.reason || snapshot.statisticsProjection.source), /import/i);
  assert.deepEqual(snapshot.sync, {
    enabled: false,
    provider: 'none',
    cursor: null,
    lastSyncedAt: null,
    lastError: null,
    outbox: [],
    conflicts: []
  });
}

test('[B] Attack: apply 只允许一次 A/B candidate+pointer commit，并保留 install、重建运行元数据', () => {
  const source = exportFixture();
  const packageData = parsePackage(source.jsonText).data;
  const { database, storage } = createTargetDatabase();
  const before = database.load();
  const preview = database.previewPortableImport(source.jsonText);
  storage.clearOperations();

  const result = database.applyPortableImport(source.jsonText, preview.confirmationId);
  const mutations = mutationOperations(storage);
  const slotWrites = mutations.filter(({ type, key }) => type === 'write' && [SLOT_A, SLOT_B].includes(key));
  const pointerWrites = mutations.filter(({ type, key }) => type === 'write' && key === ACTIVE);

  assert.equal(result.applied, true);
  assert.equal(slotWrites.length, 1, 'import must write exactly one inactive candidate slot');
  assert.equal(pointerWrites.length, 1, 'import must switch the active pointer exactly once');
  assert.equal(result.snapshot.localRevision, before.localRevision + 1);
  assert.equal(result.snapshot.settings.revision, before.settings.revision + 1);
  assertPortableState(result.snapshot, packageData);
  assertRuntimeMetadataRebuilt(result.snapshot, before.install);
  assert.equal(storage.peek(IMPORT_INTENT), undefined, 'successful import must clear strict intent');
});

test('[B] Attack: 相同 package 连续三次恢复时后两次 already_current、settings revision 稳定且零写', () => {
  const source = exportFixture();
  const { database, storage } = createTargetDatabase();
  const firstPreview = database.previewPortableImport(source.jsonText);
  const first = database.applyPortableImport(source.jsonText, firstPreview.confirmationId);
  const stableRevision = first.snapshot.settings.revision;
  const stableLocalRevision = first.snapshot.localRevision;

  for (let attempt = 2; attempt <= 3; attempt += 1) {
    const preview = database.previewPortableImport(source.jsonText);
    storage.clearOperations();
    const replay = database.applyPortableImport(source.jsonText, preview.confirmationId);
    assert.deepEqual(replay, { applied: false, reason: 'already_current' });
    assertNoWrites(storage);
    const snapshot = database.load();
    assert.equal(snapshot.settings.revision, stableRevision);
    assert.equal(snapshot.localRevision, stableLocalRevision);
  }
});

test('[B] Attack: 仅 plans/records 变化而 portable settings 相同时必须保留现有 settings revision', () => {
  const source = exportFixture();
  const portableSettings = parsePackage(source.jsonText).data.settings;
  const { database } = createTargetDatabase({ settings: portableSettings });
  const before = database.load();
  const preview = database.previewPortableImport(source.jsonText);

  const result = database.applyPortableImport(source.jsonText, preview.confirmationId);

  assert.equal(result.applied, true);
  assert.equal(result.snapshot.settings.revision, before.settings.revision);
});

test('[B] Attack: confirmation 同时绑定 packageDigest 与 candidateDigest，envelope metadata 替换也必须零写', async (t) => {
  const source = exportFixture().jsonText;
  const cases = [
    ['exportedAt replacement', (value) => { value.exportedAt += 1; }],
    ['portable candidate replacement', (value) => { value.data.settings.voiceEnabled = !value.data.settings.voiceEnabled; }]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const { database, storage } = createTargetDatabase();
      const preview = database.previewPortableImport(source);
      const replacement = rewritePackage(source, mutate);
      storage.clearOperations();
      const error = captureError(() => database.applyPortableImport(replacement, preview.confirmationId));
      assert.match(errorSignal(error), /packageDigest|candidateDigest|digest|confirmation|mismatch/i);
      assertNoWrites(storage);
    });
  }

  await t.test('raw checksum is revalidated at apply', () => {
    const { database, storage } = createTargetDatabase();
    const preview = database.previewPortableImport(source);
    const damaged = source.replace(/"title":"Portable plan/, '"title":"Changed after checksum');
    storage.clearOperations();
    const error = captureError(() => database.applyPortableImport(damaged, preview.confirmationId));
    assert.match(errorSignal(error), /IMPORT_CHECKSUM_MISMATCH|checksum/i);
    assertNoWrites(storage);
  });
});

test('[B] Attack: preview 面对旧 AppDatabase schema 只能内存迁移，不能落盘 migration/pointer/intent', () => {
  const source = exportFixture().jsonText;
  const target = createTargetDatabase();
  const storage = target.storage;
  const before = durableState(storage);
  const migrations = {
    1(snapshot) {
      snapshot.schemaVersion = 2;
      return snapshot;
    }
  };
  const portableAppMigrations = {
    1(candidate) {
      candidate.appSchemaVersion = 2;
      return candidate;
    }
  };
  const { database } = createDatabase({
    storage,
    currentSchemaVersion: 2,
    migrations,
    portableAppMigrations,
    appMigrations: portableAppMigrations
  });
  storage.clearOperations();

  const preview = database.previewPortableImport(source);

  assert.ok(preview.confirmationId);
  assertNoWrites(storage);
  assert.deepEqual(durableState(storage), before);
});

test('[B] Attack: storage-full、read-back 损坏/抛错、pointer write 失败必须保持旧 truth', async (t) => {
  const source = exportFixture().jsonText;
  const cases = [
    ['storage full', (storage, target) => storage.failNextWrite(target, new Error('storage full'))],
    ['write then throw', (storage, target) => storage.failNextWrite(
      target,
      new Error('write completed then process failed'),
      { persistBeforeThrow: true }
    )],
    ['read-back corrupt', (storage, target) => storage.transformNextRead(
      target,
      (snapshot) => ({ ...snapshot, localRevision: snapshot.localRevision + 100 }),
      { mutateStored: true, afterWrites: 1 }
    )],
    ['read-back throws', (storage, target) => storage.failNextRead(
      target,
      new Error('read-back unavailable'),
      { afterWrites: 1 }
    )],
    ['pointer write', (storage) => storage.failNextWrite(ACTIVE, new Error('pointer write failed'))],
    ['pointer write then throw', (storage) => storage.failNextWrite(
      ACTIVE,
      new Error('pointer persisted then process failed'),
      { persistBeforeThrow: true }
    )]
  ];

  for (const [name, inject] of cases) {
    await t.test(name, () => {
      const { database, storage } = createTargetDatabase();
      const preview = database.previewPortableImport(source);
      const beforeSnapshot = database.load();
      const beforeStorage = durableState(storage);
      const target = inactiveSlotKey(storage);
      inject(storage, target);
      const error = captureError(() => database.applyPortableImport(source, preview.confirmationId));
      assert.match(errorSignal(error), /storage|write|read.?back|pointer|rollback|failed|unavailable|corrupt/i);
      assert.deepEqual(storage.peek(ACTIVE), beforeStorage[ACTIVE]);
      assert.deepEqual(storage.peek(SLOT_A), beforeStorage[SLOT_A]);
      assert.deepEqual(storage.peek(SLOT_B), beforeStorage[SLOT_B], 'candidate/preimage must be rolled back');
      assert.equal(storage.peek(IMPORT_INTENT), undefined, 'completed rollback must clear intent');
      assert.deepEqual(database.load(), beforeSnapshot);
    });
  }
});

test('[B] Attack: strict import intent 的每个持久化 crash prefix 重启后只能恢复 baseline，不得选 higher candidate', () => {
  const source = exportFixture().jsonText;
  const successful = createTargetDatabase();
  const initial = durableState(successful.storage);
  const baseline = successful.database.load();
  const preview = successful.database.previewPortableImport(source);
  successful.storage.clearOperations();
  const imported = successful.database.applyPortableImport(source, preview.confirmationId).snapshot;
  const mutations = mutationOperations(successful.storage);
  const intentWriteIndex = mutations.findIndex(({ type, key }) => type === 'write' && key === IMPORT_INTENT);
  const intentClearIndex = mutations.findIndex(({ type, key }) => type === 'remove' && key === IMPORT_INTENT);
  assert.ok(intentWriteIndex >= 0, 'strict import must persist an intent marker before candidate write');
  assert.ok(intentClearIndex > intentWriteIndex, 'strict import must clear intent only after completion');

  for (let index = intentWriteIndex; index < intentClearIndex; index += 1) {
    const storage = replayMutations(initial, mutations.slice(0, index + 1));
    const { database } = createDatabase({ storage });
    const recovered = database.load();
    assert.deepEqual(recovered, baseline, `crash prefix ${index} must recover baseline truth`);
    assert.equal(storage.peek(ACTIVE), initial[ACTIVE]);
    assert.deepEqual(storage.peek(inactiveSlotKey(storage)), initial[inactiveSlotKey(storage)]);
    assert.equal(storage.peek(IMPORT_INTENT), undefined);
  }

  const completedStorage = replayMutations(initial, mutations);
  const completed = createDatabase({ storage: completedStorage }).database.load();
  assert.deepEqual(completed, imported);
});

test('[B] Attack: 已存在的 import intent 若 unknown phase 或 identity 不完整必须 fail closed', async (t) => {
  const source = exportFixture().jsonText;
  const successful = createTargetDatabase();
  const initial = durableState(successful.storage);
  const preview = successful.database.previewPortableImport(source);
  successful.storage.clearOperations();
  successful.database.applyPortableImport(source, preview.confirmationId);
  const mutations = mutationOperations(successful.storage);
  const candidateIndex = mutations.findIndex(({ type, key }) => type === 'write' && [SLOT_A, SLOT_B].includes(key));
  const prefix = mutations.slice(0, candidateIndex + 1);
  const validInterrupted = replayMutations(initial, prefix);
  const marker = validInterrupted.peek(IMPORT_INTENT);
  assert.ok(marker && typeof marker === 'object', 'strict import marker must be structured identity data');

  await t.test('unknown phase', () => {
    const storage = seedDurableState(durableState(validInterrupted));
    storage.seed(IMPORT_INTENT, { ...marker, phase: 'UNKNOWN_PHASE' });
    const { database } = createDatabase({ storage });
    assert.throws(() => database.load(), /phase|intent|marker|unsafe/i);
  });

  await t.test('incomplete identity', () => {
    const keys = Object.keys(marker).filter((key) => key !== 'phase');
    assert.ok(keys.length > 0, 'intent marker must bind baseline/target identity');
    const damaged = clone(marker);
    delete damaged[keys[0]];
    const storage = seedDurableState(durableState(validInterrupted));
    storage.seed(IMPORT_INTENT, damaged);
    const { database } = createDatabase({ storage });
    assert.throws(() => database.load(), /identity|intent|marker|incomplete|unsafe/i);
  });
});

test('[B] Attack: pending import intent 下 generic commit 必须阻断，不能掩盖未决 rollback', () => {
  const source = exportFixture().jsonText;
  const successful = createTargetDatabase();
  const initial = durableState(successful.storage);
  const preview = successful.database.previewPortableImport(source);
  successful.storage.clearOperations();
  successful.database.applyPortableImport(source, preview.confirmationId);
  const mutations = mutationOperations(successful.storage);
  const candidateIndex = mutations.findIndex(({ type, key }) => type === 'write' && [SLOT_A, SLOT_B].includes(key));
  const storage = replayMutations(initial, mutations.slice(0, candidateIndex + 1));
  const { database } = createDatabase({ storage });

  assert.throws(
    () => database.commit((draft) => { draft.settings.soundEnabled = !draft.settings.soundEnabled; }),
    /pending|intent|rollback|unsafe/i
  );
});

test('[B] Attack: local purge prepare 零写、双确认、active session 阻断、pending sync 警告且绝不调用云端', async (t) => {
  let remoteCalls = 0;
  const remoteSyncProvider = new Proxy({}, {
    get() {
      return () => { remoteCalls += 1; };
    }
  });
  const { database, storage } = createTargetDatabase({
    sync: {
      enabled: true,
      provider: 'fixture-provider',
      outbox: [{ opId: 'pending-op' }]
    },
    options: { remoteSyncProvider }
  });
  storage.clearOperations();

  const preview = database.prepareLocalPurge();

  assertNoWrites(storage);
  assert.equal(preview.counts.plans, 1);
  assert.equal(preview.counts.records, 1);
  assert.equal(preview.hasPendingSync, true);
  assert.ok(preview.warnings.some((warning) => /未同步|pending sync/i.test(warning)));
  assert.ok(preview.warnings.some((warning) => /不会删除云端|cloud.*not.*delete/i.test(warning)));
  assert.throws(() => database.applyLocalPurge(), /confirmation/i);
  assert.throws(() => database.applyLocalPurge('wrong-confirmation'), /confirmation/i);
  assertNoWrites(storage);
  assert.equal(remoteCalls, 0);

  await t.test('active session blocks both phases', () => {
    const active = createWorkoutSession({
      plan: manualPlan('plan_purge_active', '2026-08-08'),
      sessionId: 'session_purge_active',
      originDeviceId: 'device_purge_active',
      commandKey: 'start_purge_active',
      nowMs: FIXED_NOW
    });
    database.commit((draft) => { draft.activeSession = active; });
    storage.clearOperations();
    assert.throws(() => database.prepareLocalPurge(), /active.?session|训练/i);
    assertNoWrites(storage);
  });

  await t.test('active session appearing after preview blocks apply', () => {
    const target = createTargetDatabase();
    const prepared = target.database.prepareLocalPurge();
    const active = createWorkoutSession({
      plan: manualPlan('plan_purge_apply_guard', '2026-08-09'),
      sessionId: 'session_purge_apply_guard',
      originDeviceId: 'device_purge_apply_guard',
      commandKey: 'start_purge_apply_guard',
      nowMs: FIXED_NOW
    });
    target.database.commit((draft) => { draft.activeSession = active; });
    target.storage.clearOperations();
    assert.throws(
      () => target.database.applyLocalPurge(prepared.confirmationId),
      /active.?session|训练/i
    );
    assertNoWrites(target.storage);
  });
});

test('[B] Attack: confirmed local purge 以 empty snapshot 为唯一 truth，保留 install、清空本机且不碰云端', () => {
  let remoteCalls = 0;
  const remoteSyncProvider = { purge() { remoteCalls += 1; }, push() { remoteCalls += 1; } };
  const { database, storage } = createTargetDatabase({ options: { remoteSyncProvider } });
  const install = database.load().install;
  const preview = database.prepareLocalPurge();
  storage.clearOperations();

  const result = database.applyLocalPurge(preview.confirmationId);

  assert.equal(result.purged, true);
  assert.deepEqual(result.snapshot.install, install);
  assert.equal(result.snapshot.profile, null);
  assert.deepEqual(result.snapshot.plans, []);
  assert.deepEqual(result.snapshot.records, []);
  assert.equal(result.snapshot.activeSession, null);
  assert.deepEqual(result.snapshot.notifications, {
    expiredOccurrences: [],
    pendingExpiredOccurrences: [],
    attemptedExpiredOccurrences: [],
    terminalOccurrences: []
  });
  assert.deepEqual(result.snapshot.statisticsProjection, {});
  assert.equal(result.snapshot.settings.revision, 1);
  assert.deepEqual(result.snapshot.sync, {
    enabled: false,
    provider: 'none',
    cursor: null,
    lastSyncedAt: null,
    lastError: null,
    outbox: [],
    conflicts: []
  });
  assert.equal(remoteCalls, 0);
  assert.deepEqual(database.load(), result.snapshot);
});

test('[B] Attack: old slot cleanup 失败必须保留非敏感 marker，重启重试且永不复活旧数据', () => {
  const privateTitle = 'PRIVATE_PURGE_TITLE_MUST_NOT_ENTER_MARKER_82aa';
  const { database, storage } = createTargetDatabase({ title: privateTitle });
  const oldSlot = storage.peek(ACTIVE);
  const oldKey = oldSlot === 'a' ? SLOT_A : SLOT_B;
  const preview = database.prepareLocalPurge();
  storage.failNextRemove(oldKey, new Error('old slot cleanup failed'));

  const result = database.applyLocalPurge(preview.confirmationId);
  const marker = storage.peek(CLEANUP_PENDING);

  assert.equal(result.purged, true);
  assert.equal(result.cleanupPending, true);
  assert.ok(marker && typeof marker === 'object');
  assert.equal(JSON.stringify(marker).includes(privateTitle), false);
  assert.equal(/plans|records|settings|profile|payload|data|note|title/i.test(JSON.stringify(marker)), false);
  assert.equal(storage.peek(ACTIVE) === oldSlot, false, 'empty slot must remain active truth');
  assert.ok(storage.peek(oldKey), 'failed old slot cleanup remains physically present only');

  const restarted = createDatabase({ storage }).database;
  const empty = restarted.load();
  assert.deepEqual(empty.plans, []);
  assert.deepEqual(empty.records, []);
  assert.equal(storage.peek(oldKey), undefined);
  assert.equal(storage.peek(CLEANUP_PENDING), undefined);
  assert.equal(storage.peek(ACTIVE) === oldSlot, false);
});

test('[B] Attack: cleanup marker clear 失败必须幂等保留，重启清理不得 fallback 已删旧槽', () => {
  const { database, storage } = createTargetDatabase();
  const oldSlot = storage.peek(ACTIVE);
  const oldKey = oldSlot === 'a' ? SLOT_A : SLOT_B;
  const preview = database.prepareLocalPurge();
  storage.failNextRemove(CLEANUP_PENDING, new Error('marker clear failed'));

  const result = database.applyLocalPurge(preview.confirmationId);

  assert.equal(result.purged, true);
  assert.equal(result.cleanupPending, true);
  assert.equal(storage.peek(oldKey), undefined);
  assert.ok(storage.peek(CLEANUP_PENDING));
  const restarted = createDatabase({ storage }).database;
  const empty = restarted.load();
  assert.deepEqual(empty.plans, []);
  assert.deepEqual(empty.records, []);
  assert.equal(storage.peek(CLEANUP_PENDING), undefined);
  assert.equal(storage.peek(ACTIVE) === oldSlot, false);
});

test('[B] Attack: pending cleanup 时 generic commit 必须先安全清理或明确阻断', () => {
  const { database, storage } = createTargetDatabase();
  const oldSlot = storage.peek(ACTIVE);
  const oldKey = oldSlot === 'a' ? SLOT_A : SLOT_B;
  const preview = database.prepareLocalPurge();
  storage.failNextRemove(oldKey, new Error('old slot cleanup failed'));
  database.applyLocalPurge(preview.confirmationId);
  assert.ok(storage.peek(CLEANUP_PENDING));

  const restarted = createDatabase({ storage }).database;
  let blocked = false;
  try {
    restarted.commit((draft) => { draft.settings.soundEnabled = false; });
  } catch (error) {
    blocked = true;
    assert.match(errorSignal(error), /cleanup|pending|unsafe/i);
  }
  if (!blocked) {
    assert.equal(storage.peek(CLEANUP_PENDING), undefined);
    assert.equal(storage.peek(oldKey), undefined);
  }
});

test('[B] Attack: purge candidate/pointer/cleanup/remove 各 crash prefix 重启时只能 empty truth 或 fail closed', () => {
  const successful = createTargetDatabase();
  const initial = durableState(successful.storage);
  const preview = successful.database.prepareLocalPurge();
  successful.storage.clearOperations();
  const purged = successful.database.applyLocalPurge(preview.confirmationId).snapshot;
  const mutations = mutationOperations(successful.storage);
  const emptyWriteIndex = mutations.findIndex(({ type, key }) => type === 'write' && [SLOT_A, SLOT_B].includes(key));
  const pointerIndex = mutations.findIndex(({ type, key }) => type === 'write' && key === ACTIVE);
  const cleanupWriteIndex = mutations.findIndex(({ type, key }) => type === 'write' && key === CLEANUP_PENDING);
  const cleanupRemoveIndex = mutations.findIndex(({ type, key }) => type === 'remove' && key === CLEANUP_PENDING);
  assert.ok(emptyWriteIndex >= 0);
  assert.ok(pointerIndex > emptyWriteIndex);
  assert.ok(cleanupWriteIndex > pointerIndex, 'cleanup identity becomes durable after empty pointer');
  assert.ok(cleanupRemoveIndex > cleanupWriteIndex);

  for (const index of [emptyWriteIndex, pointerIndex]) {
    const storage = replayMutations(initial, mutations.slice(0, index + 1));
    const { database } = createDatabase({ storage });
    assert.throws(() => database.load(), /purge|cleanup|marker|incomplete|unsafe/i);
    if (index >= pointerIndex) {
      assert.equal(storage.peek(ACTIVE), mutations[pointerIndex].value, 'fail closed must not revive old pointer');
    }
  }

  for (let index = cleanupWriteIndex; index <= cleanupRemoveIndex; index += 1) {
    const storage = replayMutations(initial, mutations.slice(0, index + 1));
    const { database } = createDatabase({ storage });
    const recovered = database.load();
    assert.deepEqual(recovered, purged);
    assert.deepEqual(recovered.plans, []);
    assert.deepEqual(recovered.records, []);
    assert.equal(storage.peek(ACTIVE) === initial[ACTIVE], false);
  }
});

test('[B] Attack: cleanup marker 或 empty identity 损坏必须 fail closed，绝不 fallback 旧敏感槽', async (t) => {
  function interruptedPurge() {
    const target = createTargetDatabase();
    const oldSlot = target.storage.peek(ACTIVE);
    const oldKey = oldSlot === 'a' ? SLOT_A : SLOT_B;
    const preview = target.database.prepareLocalPurge();
    target.storage.failNextRemove(oldKey, new Error('keep old slot for recovery attack'));
    target.database.applyLocalPurge(preview.confirmationId);
    return { ...target, oldSlot, oldKey };
  }

  await t.test('unknown cleanup phase', () => {
    const { storage, oldSlot } = interruptedPurge();
    const marker = storage.peek(CLEANUP_PENDING);
    storage.seed(CLEANUP_PENDING, { ...marker, phase: 'UNKNOWN_PHASE' });
    const { database } = createDatabase({ storage });
    assert.throws(() => database.load(), /cleanup|phase|marker|unsafe/i);
    assert.equal(storage.peek(ACTIVE) === oldSlot, false);
  });

  await t.test('empty snapshot checksum corruption', () => {
    const { storage, oldSlot } = interruptedPurge();
    const emptySlot = storage.peek(ACTIVE);
    const emptyKey = emptySlot === 'a' ? SLOT_A : SLOT_B;
    const damaged = storage.peek(emptyKey);
    damaged.checksum = '0'.repeat(64);
    storage.seed(emptyKey, damaged);
    const { database } = createDatabase({ storage });
    assert.throws(() => database.load(), /cleanup|empty|checksum|unsafe/i);
    assert.equal(storage.peek(ACTIVE) === oldSlot, false);
  });
});

function multiStepManualPlan(id, trainingDate, title = `Multi-step ${id}`) {
  const source = manualPlan(id, trainingDate, title);
  const template = source.steps[0];
  return {
    ...source,
    steps: [
      { ...clone(template), id: `step_${id}_zeta`, order: 10, name: 'First business step' },
      { ...clone(template), id: `step_${id}_alpha`, order: 20, name: 'Second business step' }
    ]
  };
}

function completedRecordForPlan(plan, sessionId) {
  let session = createWorkoutSession({
    plan,
    sessionId,
    originDeviceId: `device_${sessionId}`,
    commandKey: `start_${sessionId}`,
    nowMs: FIXED_NOW - 120_000
  });
  for (const [index, step] of session.planSnapshot.steps.entries()) {
    session = applyWorkoutCommand(session, {
      type: 'complete_step',
      expectedSessionRevision: session.sessionRevision,
      commandKey: `complete_${sessionId}_${index}`,
      nowMs: FIXED_NOW - 60_000 + index * 1_000,
      payload: { stepId: step.id }
    }).session;
  }
  return createBaselineTrainingRecord(session);
}

function correctedRecord(record, { note, weightBeforeKg = 54321.1, pain = true } = {}) {
  return applyTrainingRecordCorrection(record, {
    expectedRevision: record.revision,
    commandKey: `correct_${record.sourceSessionId}_${record.revision}`,
    nowMs: record.updatedAt + 10_000,
    actualCorrections: [],
    feedback: {
      rpe: 8,
      weightBeforeKg,
      pain: {
        knee: pain,
        lowerBack: false,
        ankleOrToe: false,
        dizziness: false
      },
      note
    }
  });
}

function tombstoneFrom(record, commandKey = `delete_${record.sourceSessionId}`) {
  const deletedAt = record.updatedAt + 20_000;
  return {
    id: record.id,
    sourceSessionId: record.sourceSessionId,
    sourceSessionFingerprint: record.sourceSessionFingerprint,
    status: record.status,
    trainingDate: record.trainingDate,
    createdAt: record.createdAt,
    updatedAt: deletedAt,
    revision: record.revision + 1,
    deletedAt,
    processedDeletionCommands: [{
      key: commandKey,
      fingerprint: computeChecksum({ commandKey, recordId: record.id, deletedAt }),
      resultRevision: record.revision + 1
    }]
  };
}

test('[F1] Attack: real preview 必须准确给出双集合四桶变化、版本/baseline/counts、隐私安全 warning 且零写', () => {
  const privateNote = 'PRIVATE_PREVIEW_NOTE_4f3a';
  const privatePainToken = 'PRIVATE_PREVIEW_PAIN_KNEE_739b';
  const unchangedPlan = manualPlan('plan_preview_unchanged', '2026-08-10');
  const currentChangedPlan = manualPlan('plan_preview_changed', '2026-08-11', 'Current changed plan');
  const incomingChangedPlan = manualPlan('plan_preview_changed', '2026-08-11', 'Incoming changed plan');
  const removedPlan = manualPlan('plan_preview_removed', '2026-08-12');
  const addedPlan = manualPlan('plan_preview_added', '2026-08-13');

  const unchangedRecord = completedRecordForPlan(
    manualPlan('plan_record_preview_unchanged', '2026-08-14'),
    'session_preview_unchanged'
  );
  const currentChangedRecord = correctedRecord(
    completedRecordForPlan(
      manualPlan('plan_record_preview_changed', '2026-08-15', 'Current record source'),
      'session_preview_changed'
    ),
    { note: 'current note', weightBeforeKg: 70.1, pain: false }
  );
  const incomingChangedRecord = correctedRecord(
    completedRecordForPlan(
      manualPlan('plan_record_preview_changed', '2026-08-15', 'Incoming record source'),
      'session_preview_changed'
    ),
    { note: `${privateNote} ${privatePainToken}`, weightBeforeKg: 54321.1, pain: true }
  );
  const removedRecord = completedRecordForPlan(
    manualPlan('plan_record_preview_removed', '2026-08-16'),
    'session_preview_removed'
  );
  const addedRecord = correctedRecord(
    completedRecordForPlan(
      manualPlan('plan_record_preview_added', '2026-08-17'),
      'session_preview_added'
    ),
    { note: 'PRIVATE_ADDED_RECORD_NOTE_0d91', weightBeforeKg: 12345.6, pain: true }
  );

  const source = createDatabase();
  source.database.commit((draft) => {
    draft.plans = [addedPlan, incomingChangedPlan, clone(unchangedPlan)];
    draft.records = [addedRecord, incomingChangedRecord, clone(unchangedRecord)];
  });
  const exported = source.database.exportPortableBackup();
  const incoming = parsePackage(exported.jsonText);

  const target = createDatabase();
  target.database.commit((draft) => {
    draft.plans = [removedPlan, currentChangedPlan, clone(unchangedPlan)];
    draft.records = [removedRecord, currentChangedRecord, clone(unchangedRecord)];
  });
  const baseline = target.database.load().localRevision;
  target.storage.clearOperations();

  const preview = target.database.previewPortableImport(exported.jsonText);
  const serialized = JSON.stringify(preview);

  assert.equal(preview.packageVersion, 1);
  assert.equal(preview.appSchemaVersion, 1);
  assert.equal(preview.checksumPrefix, incoming.checksum.slice(0, 8));
  assert.equal(preview.baselineLocalRevision, baseline);
  assert.deepEqual(preview.counts, { plans: 3, records: 3 });
  assert.deepEqual(preview.changes, {
    plans: { added: 1, changed: 1, unchanged: 1, removed: 1 },
    records: { added: 1, changed: 1, unchanged: 1, removed: 1 }
  });
  assert.ok(preview.warnings.some((warning) => /替换.*本机|本机.*替换/.test(warning)));
  assert.ok(preview.warnings.some((warning) => /同步.*关闭|不会删除云端|云端.*不.*删除/.test(warning)));
  for (const secret of [privateNote, privatePainToken, '54321.1', 'PRIVATE_ADDED_RECORD_NOTE_0d91', '12345.6']) {
    assert.equal(serialized.includes(secret), false, `preview leaked ${secret}`);
  }
  assertNoWrites(target.storage);
});

test('[F1] Attack: export→preview→apply→export 必须保留合法 tombstone 与 nested business order，仅排序实体集合', () => {
  const orderedPlan = multiStepManualPlan('plan_roundtrip_order', '2026-08-18');
  const activeRecord = correctedRecord(
    completedRecordForPlan(orderedPlan, 'session_roundtrip_order'),
    { note: 'ROUNDTRIP_PRIVATE_NOTE_275e', weightBeforeKg: 82.5, pain: true }
  );
  const deletedRecord = tombstoneFrom(
    completedRecordForPlan(
      manualPlan('plan_roundtrip_deleted', '2026-08-19'),
      'session_roundtrip_deleted'
    )
  );
  const otherPlan = manualPlan('plan_roundtrip_alpha', '2026-08-20');
  const source = createDatabase();
  source.database.commit((draft) => {
    draft.plans = [orderedPlan, otherPlan];
    draft.records = [activeRecord, deletedRecord];
  });

  const firstExport = source.database.exportPortableBackup();
  const firstData = parsePackage(firstExport.jsonText).data;
  const target = createTargetDatabase();
  const preview = target.database.previewPortableImport(firstExport.jsonText);
  const applied = target.database.applyPortableImport(firstExport.jsonText, preview.confirmationId);
  const secondData = parsePackage(target.database.exportPortableBackup().jsonText).data;

  assert.equal(applied.applied, true);
  assert.equal(canonicalize(secondData), canonicalize(firstData));
  assert.deepEqual(firstData.plans.map(({ id }) => id), [
    'plan_roundtrip_alpha',
    'plan_roundtrip_order'
  ]);
  assert.deepEqual(firstData.records.map(({ id }) => id), [
    'record_session_roundtrip_deleted',
    'record_session_roundtrip_order'
  ]);
  const roundTripPlan = secondData.plans.find(({ id }) => id === orderedPlan.id);
  const roundTripRecord = secondData.records.find(({ id }) => id === activeRecord.id);
  assert.deepEqual(roundTripPlan.steps.map(({ id }) => id), [
    'step_plan_roundtrip_order_zeta',
    'step_plan_roundtrip_order_alpha'
  ]);
  assert.deepEqual(roundTripRecord.planSnapshot.steps.map(({ id }) => id), [
    'step_plan_roundtrip_order_zeta',
    'step_plan_roundtrip_order_alpha'
  ]);
  assert.deepEqual(roundTripRecord.stepResults.map(({ stepId }) => stepId), [
    'step_plan_roundtrip_order_zeta',
    'step_plan_roundtrip_order_alpha'
  ]);
  assert.equal(secondData.records.find(({ id }) => id === deletedRecord.id).deletedAt, deletedRecord.deletedAt);
});

test('[F1] Attack: portable plan 时间戳必须是非负 safe integer，非法值以精确 domain code 零写拒绝', async (t) => {
  const source = exportFixture().jsonText;
  const cases = [
    ['negative createdAt', (plan) => { plan.createdAt = -1; }],
    ['fractional updatedAt', (plan) => { plan.updatedAt = plan.createdAt + 0.5; }],
    ['negative deletedAt', (plan) => { plan.deletedAt = -1; }],
    ['unsafe createdAt', (plan) => { plan.createdAt = Number.MAX_SAFE_INTEGER + 1; }],
    ['updatedAt before createdAt', (plan) => { plan.updatedAt = plan.createdAt - 1; }]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const candidate = rewritePackage(source, (value) => mutate(value.data.plans[0]));
      const { database, storage } = createDatabase();
      storage.clearOperations();
      const error = captureError(() => database.previewPortableImport(candidate));
      assert.equal(error.code, 'IMPORT_DOMAIN_INVALID');
      assertNoWrites(storage);
    });
  }
});
