const assert = require('node:assert/strict');
const test = require('node:test');

const { StorageDouble, clone } = require('../helpers/storage-double');

const SLOT_A = 'train_flow:v1:db:a';
const SLOT_B = 'train_flow:v1:db:b';
const ACTIVE = 'train_flow:v1:db:active';
const FIXED_NOW = 1785719340000;

function loadChecksumContract() {
  const checksumModule = require('../../miniprogram/utils/checksum');
  const computeChecksum = checksumModule.computeChecksum || checksumModule.calculateChecksum;

  assert.equal(typeof computeChecksum, 'function', 'checksum utility must expose computeChecksum');
  return { computeChecksum };
}

function loadDatabaseContract() {
  const localDatabaseModule = require('../../miniprogram/services/local-database');
  const createLocalDatabase =
    localDatabaseModule.createLocalDatabase ||
    ((options) => new localDatabaseModule.LocalDatabase(options));

  assert.equal(typeof createLocalDatabase, 'function', 'LocalDatabase must expose a constructor or factory');
  return { createLocalDatabase };
}

function createDatabase(storage, options = {}) {
  const { createLocalDatabase } = loadDatabaseContract();
  return createLocalDatabase({ storage, now: () => FIXED_NOW, ...options });
}

function makeSnapshot(overrides = {}) {
  const { computeChecksum } = loadChecksumContract();
  const payload = {
    schemaVersion: 1,
    localRevision: 1,
    committedAt: FIXED_NOW - 1000,
    install: { deviceId: 'device_fixture', createdAt: FIXED_NOW - 5000 },
    profile: null,
    settings: {
      schemaVersion: 1,
      revision: 1,
      vibrationEnabled: true,
      soundEnabled: true,
      voiceEnabled: false,
      keepScreenOn: true,
      defaultStartLocalTime: '08:35',
      recommendedEndLocalTime: '09:10',
      defaultRestSeconds: 75,
      timezone: 'Asia/Shanghai',
      cloudSyncEnabled: false
    },
    plans: [],
    activeSession: null,
    records: [],
    statisticsProjection: {},
    sync: {
      enabled: false,
      provider: 'none',
      cursor: null,
      lastSyncedAt: null,
      lastError: null,
      outbox: [],
      conflicts: []
    },
    ...clone(overrides)
  };
  delete payload.checksum;
  return { ...payload, checksum: computeChecksum(payload) };
}

function decodeStored(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function seedPair({ active = 'a', a, b }) {
  return new StorageDouble({
    [SLOT_A]: a,
    [SLOT_B]: b,
    [ACTIVE]: active
  });
}

test('Attack: 对象 key 插入顺序和 checksum 自身变化不得改变 canonical checksum，数组顺序必须参与校验', () => {
  const { computeChecksum } = loadChecksumContract();
  const left = {
    schemaVersion: 1,
    localRevision: 7,
    checksum: 'old-left',
    nested: { z: 3, a: 1 },
    records: [{ id: 'record-b' }, { id: 'record-a' }]
  };
  const samePayloadDifferentKeyOrder = {
    records: [{ id: 'record-b' }, { id: 'record-a' }],
    nested: { a: 1, z: 3 },
    checksum: 'old-right',
    localRevision: 7,
    schemaVersion: 1
  };
  const reorderedBusinessArray = {
    ...samePayloadDifferentKeyOrder,
    records: [...samePayloadDifferentKeyOrder.records].reverse()
  };

  assert.equal(computeChecksum(left), computeChecksum(samePayloadDifferentKeyOrder));
  assert.notEqual(computeChecksum(left), computeChecksum(reorderedBusinessArray));
});

test('Attack: A/B commit 必须先写非活动槽、读回验证，再切 pointer，并把领域数据与 outbox 放进同一快照', () => {
  const oldA = makeSnapshot({ localRevision: 10, records: [{ id: 'old-record' }] });
  const oldB = makeSnapshot({ localRevision: 9 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.clearOperations();

  database.commit((draft) => {
    draft.records.push({ id: 'record-atomic' });
    draft.sync.outbox.push({ opId: 'op-atomic', kind: 'record.upsert' });
  });

  const storedB = decodeStored(storage.peek(SLOT_B));
  const { computeChecksum } = loadChecksumContract();
  assert.equal(storage.peek(ACTIVE), 'b');
  assert.deepEqual(storage.peek(SLOT_A), oldA, 'active snapshot must remain untouched until pointer switch');
  assert.equal(storedB.localRevision, 11);
  assert.equal(storedB.committedAt, FIXED_NOW);
  assert.equal(storedB.records.at(-1).id, 'record-atomic');
  assert.equal(storedB.sync.outbox.at(-1).opId, 'op-atomic');
  assert.equal(storedB.checksum, computeChecksum(storedB));

  const writeSlotIndex = storage.operations.findIndex(
    ({ type, key }) => type === 'write' && key === SLOT_B
  );
  const readBackIndex = storage.operations.findIndex(
    ({ type, key }, index) => index > writeSlotIndex && type === 'read' && key === SLOT_B
  );
  const switchPointerIndex = storage.operations.findIndex(
    ({ type, key }, index) => index > readBackIndex && type === 'write' && key === ACTIVE
  );
  assert.ok(writeSlotIndex >= 0, 'inactive slot must be written');
  assert.ok(readBackIndex > writeSlotIndex, 'inactive slot must be read back after writing');
  assert.ok(switchPointerIndex > readBackIndex, 'pointer switch must be the final commit step');
});

test('Attack: repeated commits 必须严格交替 A/B 槽并保持单调 localRevision 与业务数组顺序', () => {
  const storage = seedPair({
    active: 'a',
    a: makeSnapshot({ localRevision: 20 }),
    b: makeSnapshot({ localRevision: 19 })
  });
  const database = createDatabase(storage);

  for (const id of ['first', 'second', 'third']) {
    database.commit((draft) => {
      draft.records.push({ id });
    });
  }

  const finalA = decodeStored(storage.peek(SLOT_A));
  const finalB = decodeStored(storage.peek(SLOT_B));
  const loaded = database.load();
  assert.equal(storage.peek(ACTIVE), 'b');
  assert.equal(finalA.localRevision, 22);
  assert.equal(finalB.localRevision, 23);
  assert.deepEqual(loaded.records.map(({ id }) => id), ['first', 'second', 'third']);
});

test('Attack: pointer 为垃圾值时 startup 必须选择最高 revision 的有效槽，并且只修 pointer', () => {
  const a = makeSnapshot({ localRevision: 30, records: [{ id: 'older' }] });
  const b = makeSnapshot({ localRevision: 31, records: [{ id: 'survivor' }] });
  const storage = seedPair({ active: 'corrupted-pointer', a, b });
  const database = createDatabase(storage);
  storage.clearOperations();

  const loaded = database.load();

  assert.equal(loaded.localRevision, 31);
  assert.equal(loaded.records[0].id, 'survivor');
  assert.deepEqual(storage.peek(SLOT_A), a);
  assert.deepEqual(storage.peek(SLOT_B), b);
  storage.assertOnlyKeysWritten([ACTIVE]);
  assert.equal(storage.peek(ACTIVE), 'b');
});

test('Attack: pointer 指向较旧但有效的槽时也不能相信 pointer，必须提升到最高有效 revision', () => {
  const storage = seedPair({
    active: 'a',
    a: makeSnapshot({ localRevision: 40, records: [{ id: 'stale-pointer-target' }] }),
    b: makeSnapshot({ localRevision: 41, records: [{ id: 'newer-survivor' }] })
  });
  const database = createDatabase(storage);
  storage.clearOperations();

  const loaded = database.load();

  assert.equal(loaded.localRevision, 41);
  assert.equal(loaded.records[0].id, 'newer-survivor');
  storage.assertOnlyKeysWritten([ACTIVE]);
  assert.equal(storage.peek(ACTIVE), 'b');
});

test('Attack: active slot checksum 被篡改时必须回退到另一有效槽，不能覆盖幸存快照', () => {
  const damagedA = makeSnapshot({ localRevision: 51, records: [{ id: 'tampered' }] });
  damagedA.records[0].id = 'changed-after-checksum';
  const survivorB = makeSnapshot({ localRevision: 50, records: [{ id: 'survivor' }] });
  const storage = seedPair({ active: 'a', a: damagedA, b: survivorB });
  const database = createDatabase(storage);
  storage.clearOperations();

  const loaded = database.load();

  assert.equal(loaded.localRevision, 50);
  assert.equal(loaded.records[0].id, 'survivor');
  assert.deepEqual(storage.peek(SLOT_B), survivorB);
  storage.assertOnlyKeysWritten([ACTIVE]);
  assert.equal(storage.peek(ACTIVE), 'b');
});

test('Attack: active slot 是截断 JSON 或不可解析垃圾时必须隔离坏槽并恢复另一有效快照', () => {
  const survivorB = makeSnapshot({ localRevision: 55, records: [{ id: 'survivor' }] });
  const storage = seedPair({ active: 'a', a: '{"schemaVersion":1,"localRevision":56', b: survivorB });
  const database = createDatabase(storage);
  storage.clearOperations();

  const loaded = database.load();

  assert.equal(loaded.localRevision, 55);
  assert.equal(loaded.records[0].id, 'survivor');
  assert.equal(storage.peek(SLOT_A), '{"schemaVersion":1,"localRevision":56');
  assert.deepEqual(storage.peek(SLOT_B), survivorB);
  storage.assertOnlyKeysWritten([ACTIVE]);
  assert.equal(storage.peek(ACTIVE), 'b');
});

test('Attack: mutator 在内存阶段抛错时不得产生任何 slot 或 pointer 写入', () => {
  const oldA = makeSnapshot({ localRevision: 58, records: [{ id: 'durable-old' }] });
  const oldB = makeSnapshot({ localRevision: 57 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.clearOperations();

  assert.throws(
    () =>
      database.commit((draft) => {
        draft.records.push({ id: 'partial-memory-change' });
        throw new Error('domain invariant rejected mutation');
      }),
    /domain invariant rejected mutation/
  );
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: storage-full 写非活动槽失败时，旧 pointer 与旧快照必须保持可读且完全不变', () => {
  const oldA = makeSnapshot({ localRevision: 60, records: [{ id: 'durable-old' }] });
  const oldB = makeSnapshot({ localRevision: 59 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.failNextWrite(SLOT_B, new Error('storage full'));

  assert.throws(
    () => database.commit((draft) => draft.records.push({ id: 'must-not-appear' })),
    /storage full/i
  );
  assert.equal(storage.peek(ACTIVE), 'a');
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.deepEqual(database.load(), oldA);
});

test('Attack: 写入后读回内容静默损坏时必须拒绝切 pointer，并从旧槽恢复', () => {
  const oldA = makeSnapshot({ localRevision: 70, records: [{ id: 'durable-old' }] });
  const storage = seedPair({
    active: 'a',
    a: oldA,
    b: makeSnapshot({ localRevision: 69 })
  });
  const database = createDatabase(storage);
  storage.transformNextRead(
    SLOT_B,
    (snapshot) => ({ ...decodeStored(snapshot), localRevision: 999 }),
    { mutateStored: true, afterWrites: 1 }
  );

  assert.throws(
    () => database.commit((draft) => draft.records.push({ id: 'corrupted-write' })),
    /checksum|read.?back|validation|corrupt/i
  );
  assert.equal(storage.peek(ACTIVE), 'a');
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(database.load(), oldA);
});

test('Attack: 写入成功但 read-back API 抛错时不得切 pointer，旧快照仍须原样保留', () => {
  const oldA = makeSnapshot({ localRevision: 80, records: [{ id: 'durable-old' }] });
  const storage = seedPair({
    active: 'a',
    a: oldA,
    b: makeSnapshot({ localRevision: 79 })
  });
  const database = createDatabase(storage);
  storage.failNextRead(SLOT_B, new Error('read-back unavailable'), { afterWrites: 1 });

  assert.throws(
    () => database.commit((draft) => draft.records.push({ id: 'uncertain-write' })),
    /read-back unavailable/i
  );
  assert.equal(storage.peek(ACTIVE), 'a');
  assert.deepEqual(storage.peek(SLOT_A), oldA);
});

test('Attack: future schema 必须明确拒绝，不能降级、迁移或写坏任何槽位', () => {
  const future = makeSnapshot({ schemaVersion: 99, localRevision: 90 });
  const fallback = makeSnapshot({ schemaVersion: 1, localRevision: 89 });
  const storage = seedPair({ active: 'a', a: future, b: fallback });
  const database = createDatabase(storage, { currentSchemaVersion: 3, migrations: {} });
  storage.clearOperations();

  assert.throws(() => database.load(), /future|unsupported|schemaVersion|升级/i);
  assert.deepEqual(storage.peek(SLOT_A), future);
  assert.deepEqual(storage.peek(SLOT_B), fallback);
  assert.equal(storage.peek(ACTIVE), 'a');
  storage.assertOnlyKeysWritten([]);
});

test('Attack: migration 必须逐版本执行且成功后只提交一次；再次启动不得重复迁移', () => {
  const calls = [];
  const oldA = makeSnapshot({ schemaVersion: 1, localRevision: 100, migrationTrail: [] });
  const storage = seedPair({
    active: 'a',
    a: oldA,
    b: makeSnapshot({ schemaVersion: 1, localRevision: 99 })
  });
  const migrations = {
    1(snapshot) {
      calls.push(`v${snapshot.schemaVersion}-to-v2`);
      snapshot.migrationTrail.push('v2');
      snapshot.schemaVersion = 2;
      return snapshot;
    },
    2(snapshot) {
      calls.push(`v${snapshot.schemaVersion}-to-v3`);
      snapshot.migrationTrail.push('v3');
      snapshot.schemaVersion = 3;
      return snapshot;
    }
  };
  const database = createDatabase(storage, { currentSchemaVersion: 3, migrations });

  const firstLoad = database.load();
  assert.deepEqual(calls, ['v1-to-v2', 'v2-to-v3']);
  assert.equal(firstLoad.schemaVersion, 3);
  assert.equal(firstLoad.localRevision, 101);
  assert.deepEqual(firstLoad.migrationTrail, ['v2', 'v3']);
  assert.deepEqual(storage.peek(SLOT_A), oldA, 'old valid slot must survive until migration commits');

  storage.clearOperations();
  const secondLoad = database.load();
  assert.equal(secondLoad.schemaVersion, 3);
  assert.deepEqual(secondLoad.migrationTrail, ['v2', 'v3']);
  assert.deepEqual(calls, ['v1-to-v2', 'v2-to-v3'], 'migration must be idempotent across restart');
  storage.assertOnlyKeysWritten([]);
});

test('Attack: 中间版本 migration 抛错时必须回滚 pointer 并保留旧有效槽，不得返回半迁移数据', () => {
  const oldA = makeSnapshot({ schemaVersion: 1, localRevision: 110, migrationTrail: [] });
  const storage = seedPair({
    active: 'a',
    a: oldA,
    b: makeSnapshot({ schemaVersion: 1, localRevision: 109 })
  });
  const database = createDatabase(storage, {
    currentSchemaVersion: 3,
    migrations: {
      1(snapshot) {
        snapshot.migrationTrail.push('v2');
        snapshot.schemaVersion = 2;
        return snapshot;
      },
      2(snapshot) {
        snapshot.migrationTrail.push('partial-v3');
        throw new Error('v2 to v3 migration failed');
      }
    }
  });

  assert.throws(() => database.load(), /v2 to v3 migration failed/);
  assert.equal(storage.peek(ACTIVE), 'a');
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.equal(decodeStored(storage.peek(SLOT_A)).migrationTrail.length, 0);
  assert.equal(storage.writesFor(ACTIVE).length, 0);
});

test('Attack: 未先调用 load() 就在旧 schema 上 commit 时，也必须先完成逐版本迁移再应用业务 mutator', () => {
  const calls = [];
  const oldA = makeSnapshot({
    schemaVersion: 1,
    localRevision: 120,
    migrationTrail: [],
    records: [{ id: 'before-direct-commit' }]
  });
  const storage = seedPair({
    active: 'a',
    a: oldA,
    b: makeSnapshot({ schemaVersion: 1, localRevision: 119 })
  });
  const database = createDatabase(storage, {
    currentSchemaVersion: 3,
    migrations: {
      1(snapshot) {
        calls.push('v1-to-v2');
        snapshot.migrationTrail.push('v2');
        snapshot.schemaVersion = 2;
        return snapshot;
      },
      2(snapshot) {
        calls.push('v2-to-v3');
        snapshot.migrationTrail.push('v3');
        snapshot.schemaVersion = 3;
        return snapshot;
      }
    }
  });

  const committed = database.commit((draft) => {
    draft.records.push({ id: 'after-direct-commit' });
  });

  assert.deepEqual(calls, ['v1-to-v2', 'v2-to-v3']);
  assert.equal(committed.schemaVersion, 3);
  assert.equal(committed.localRevision, 121);
  assert.deepEqual(committed.migrationTrail, ['v2', 'v3']);
  assert.deepEqual(
    committed.records.map(({ id }) => id),
    ['before-direct-commit', 'after-direct-commit']
  );
  assert.deepEqual(storage.peek(SLOT_A), oldA, 'direct commit migration must retain the old valid slot');
});

test('Attack: 两个 slot 的 storage read 同时抛错时必须中止启动，不能把暂时不可读误判为全新数据库', () => {
  const oldA = makeSnapshot({ localRevision: 130, records: [{ id: 'durable-a' }] });
  const oldB = makeSnapshot({ localRevision: 129, records: [{ id: 'durable-b' }] });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.failNextRead(SLOT_A, new Error('slot a temporarily unavailable'));
  storage.failNextRead(SLOT_B, new Error('slot b temporarily unavailable'));
  storage.clearOperations();

  assert.throws(() => database.load(), /storage|read|unavailable/i);
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: localRevision 到达 MAX_SAFE_INTEGER 时必须拒绝继续提交，不能产生无法单调递增的 revision', () => {
  const maxSafe = Number.MAX_SAFE_INTEGER;
  const oldA = makeSnapshot({ localRevision: maxSafe, records: [{ id: 'last-safe-revision' }] });
  const oldB = makeSnapshot({ localRevision: maxSafe - 1 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.clearOperations();

  assert.throws(
    () => database.commit((draft) => draft.records.push({ id: 'must-not-overflow' })),
    /revision|safe|overflow/i
  );
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: 最终 pointer 写失败时旧快照必须保留；重启后应按最高有效 revision 接管已校验候选槽', () => {
  const oldA = makeSnapshot({ localRevision: 140, records: [{ id: 'old-active' }] });
  const oldB = makeSnapshot({ localRevision: 139 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.failNextWrite(ACTIVE, new Error('pointer write unavailable'));

  assert.throws(
    () => database.commit((draft) => draft.records.push({ id: 'verified-candidate' })),
    /pointer write unavailable/i
  );
  assert.equal(storage.peek(ACTIVE), 'a');
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  const candidateB = decodeStored(storage.peek(SLOT_B));
  assert.equal(candidateB.localRevision, 141);
  assert.equal(candidateB.records.at(-1).id, 'verified-candidate');

  const recovered = database.load();
  assert.equal(recovered.localRevision, 141);
  assert.equal(recovered.records.at(-1).id, 'verified-candidate');
  assert.equal(storage.peek(ACTIVE), 'b');
  assert.deepEqual(storage.peek(SLOT_A), oldA, 'pointer recovery must not overwrite the prior snapshot');
});

test('Attack: mutator 写入 undefined 时必须拒绝提交，不能经 JSON clone 静默变成 null', () => {
  const oldA = makeSnapshot({ localRevision: 150, records: [{ id: 'durable-record' }] });
  const oldB = makeSnapshot({ localRevision: 149 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.clearOperations();

  assert.throws(
    () =>
      database.commit((draft) => {
        draft.records.push(undefined);
      }),
    /undefined|JSON|serializable|record|validation/i
  );
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: 两实例在 mutator 内交错提交时 expectedRevision 必须在最终落盘前再次校验，不能覆盖已成功提交者', () => {
  const oldA = makeSnapshot({ localRevision: 160, records: [{ id: 'base' }] });
  const storage = seedPair({
    active: 'a',
    a: oldA,
    b: makeSnapshot({ localRevision: 159 })
  });
  const outerDatabase = createDatabase(storage);
  const innerDatabase = createDatabase(storage);
  let outerError = null;

  try {
    outerDatabase.commit(
      (outerDraft) => {
        innerDatabase.commit(
          (innerDraft) => innerDraft.records.push({ id: 'inner-winner' }),
          160
        );
        outerDraft.records.push({ id: 'stale-outer' });
      },
      160
    );
  } catch (error) {
    outerError = error;
  }

  assert.match(
    outerError && outerError.message,
    /revision conflict: expected 160, actual 161/i,
    'outer commit must detect that another instance committed after its initial revision check'
  );
  const persisted = innerDatabase.load();
  assert.equal(persisted.localRevision, 161);
  assert.deepEqual(persisted.records.map(({ id }) => id), ['base', 'inner-winner']);
});

test('Attack: 空数据库初始化时 now() 返回非有限值必须失败，不能暴露 committedAt=null 的伪快照', () => {
  const storage = new StorageDouble();
  const database = createDatabase(storage, { now: () => Number.NaN });

  assert.throws(() => database.load(), /committedAt|finite|timestamp|now/i);
  storage.assertOnlyKeysWritten([]);
  assert.equal(storage.peek(SLOT_A), undefined);
  assert.equal(storage.peek(SLOT_B), undefined);
  assert.equal(storage.peek(ACTIVE), undefined);
});

test('Attack: storage 返回内部引用时，调用者修改 load/commit 返回对象也不得篡改持久快照', () => {
  class ReferenceStorage {
    constructor(initial) {
      this.values = new Map(Object.entries(initial));
    }

    getStorageSync(key) {
      return this.values.get(key);
    }

    setStorageSync(key, value) {
      this.values.set(key, value);
    }
  }

  const storage = new ReferenceStorage({
    [SLOT_A]: makeSnapshot({ localRevision: 170, records: [{ id: 'durable' }] }),
    [SLOT_B]: makeSnapshot({ localRevision: 169 }),
    [ACTIVE]: 'a'
  });
  const database = createDatabase(storage);

  const loaded = database.load();
  loaded.records.push({ id: 'load-alias-attack' });
  assert.deepEqual(database.load().records.map(({ id }) => id), ['durable']);

  const committed = database.commit((draft) => draft.records.push({ id: 'committed' }));
  committed.records.push({ id: 'commit-alias-attack' });
  assert.deepEqual(database.load().records.map(({ id }) => id), ['durable', 'committed']);
});

test('Attack: load 修复 stale pointer 的 setStorageSync 失败时不得改槽；重试后仍能选择最高 revision 并完成修复', () => {
  const oldA = makeSnapshot({ localRevision: 180, records: [{ id: 'old-pointer-target' }] });
  const newerB = makeSnapshot({ localRevision: 181, records: [{ id: 'newest' }] });
  const storage = seedPair({ active: 'a', a: oldA, b: newerB });
  const database = createDatabase(storage);
  storage.failNextWrite(ACTIVE, new Error('pointer repair unavailable'));

  assert.throws(() => database.load(), /pointer repair unavailable/i);
  assert.equal(storage.peek(ACTIVE), 'a');
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), newerB);

  const recovered = database.load();
  assert.equal(recovered.localRevision, 181);
  assert.equal(recovered.records[0].id, 'newest');
  assert.equal(storage.peek(ACTIVE), 'b');
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), newerB);
});

test('Attack: second CAS read 两槽都抛错时必须在任何写入前中止 commit', () => {
  const oldA = makeSnapshot({ localRevision: 190, records: [{ id: 'durable' }] });
  const oldB = makeSnapshot({ localRevision: 189 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const originalGetStorageSync = storage.getStorageSync.bind(storage);
  let slotReads = 0;
  storage.getStorageSync = (key) => {
    if (key === SLOT_A || key === SLOT_B) {
      slotReads += 1;
      if (slotReads > 2) {
        throw new Error(`second CAS read unavailable for ${key}`);
      }
    }
    return originalGetStorageSync(key);
  };
  const database = createDatabase(storage);
  storage.clearOperations();

  assert.throws(
    () => database.commit((draft) => draft.records.push({ id: 'must-not-commit' }), 190),
    /second CAS read unavailable|Unable to read a valid AppDatabase snapshot/i
  );
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: second CAS 遇到同 revision 但不同 checksum/payload 时必须识别 ABA，不能只比较 revision', () => {
  const oldA = makeSnapshot({ localRevision: 200, records: [{ id: 'original-base' }] });
  const oldB = makeSnapshot({ localRevision: 199 });
  const conflictingA = makeSnapshot({
    localRevision: 200,
    records: [{ id: 'concurrent-same-revision-payload' }]
  });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.clearOperations();

  assert.throws(
    () =>
      database.commit(
        (draft) => {
          storage.seed(SLOT_A, conflictingA);
          draft.records.push({ id: 'stale-writer' });
        },
        200
      ),
    /revision conflict|checksum|concurrent|ABA/i
  );
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), conflictingA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: slot key 已存在但值为 JSON null 时属于损坏，不得伪装成首次安装并返回空数据库', () => {
  const storage = new StorageDouble({
    [SLOT_A]: 'null',
    [ACTIVE]: 'a'
  });
  const database = createDatabase(storage);

  assert.throws(() => database.load(), /valid AppDatabase|corrupt|snapshot|null/i);
  storage.assertOnlyKeysWritten([]);
  assert.equal(storage.peek(SLOT_A), 'null');
  assert.equal(storage.peek(SLOT_B), undefined);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: 显式传入空 expectedRevision options 必须拒绝，不能静默降级为无 CAS commit', () => {
  const oldA = makeSnapshot({ localRevision: 210, records: [{ id: 'durable' }] });
  const oldB = makeSnapshot({ localRevision: 209 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage);
  storage.clearOperations();

  assert.throws(
    () => database.commit((draft) => draft.records.push({ id: 'must-not-commit' }), {}),
    /expectedRevision|non-negative safe integer|revision option/i
  );
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: migration map 只能使用自身版本 key，不能执行 prototype 继承的 migration', () => {
  const oldA = makeSnapshot({ schemaVersion: 1, localRevision: 220, migrationTrail: [] });
  const oldB = makeSnapshot({ schemaVersion: 1, localRevision: 219 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const inheritedMigrations = Object.create({
    1(snapshot) {
      snapshot.schemaVersion = 2;
      snapshot.migrationTrail.push('inherited-prototype-migration');
      return snapshot;
    }
  });
  const database = createDatabase(storage, {
    currentSchemaVersion: 2,
    migrations: inheritedMigrations
  });
  storage.clearOperations();

  assert.throws(() => database.load(), /Missing migration from schemaVersion 1/);
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: install metadata key 存在但 JSON 损坏时必须失败关闭，不能静默丢弃 device identity', () => {
  const storage = new StorageDouble({
    'train_flow:v1:install': '{"deviceId":"truncated"'
  });
  const database = createDatabase(storage);

  assert.throws(() => database.load(), /install|JSON|Unexpected|corrupt/i);
  storage.assertOnlyKeysWritten([]);
  assert.equal(storage.peek('train_flow:v1:install'), '{"deviceId":"truncated"');
  assert.equal(storage.peek(SLOT_A), undefined);
  assert.equal(storage.peek(SLOT_B), undefined);
  assert.equal(storage.peek(ACTIVE), undefined);
});

test('Attack: migration 生成非法 settings 时间与休息上限时必须整体回滚，不能只校验字段类型', () => {
  const oldA = makeSnapshot({ schemaVersion: 1, localRevision: 230 });
  const oldB = makeSnapshot({ schemaVersion: 1, localRevision: 229 });
  const storage = seedPair({ active: 'a', a: oldA, b: oldB });
  const database = createDatabase(storage, {
    currentSchemaVersion: 2,
    migrations: {
      1(snapshot) {
        snapshot.schemaVersion = 2;
        snapshot.settings.defaultStartLocalTime = '99:99';
        snapshot.settings.defaultRestSeconds = 601;
        return snapshot;
      }
    }
  });
  storage.clearOperations();

  assert.throws(
    () => database.load(),
    /defaultStartLocalTime|HH:mm|defaultRestSeconds|between|600/i
  );
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), oldA);
  assert.deepEqual(storage.peek(SLOT_B), oldB);
  assert.equal(storage.peek(ACTIVE), 'a');
});

test('Attack: 两槽保存完全相同快照且 pointer 非法时必须无损选定一个槽，只修 pointer', () => {
  const duplicate = makeSnapshot({ localRevision: 240, records: [{ id: 'duplicate-safe' }] });
  const storage = seedPair({ active: 'not-a-slot', a: duplicate, b: duplicate });
  const database = createDatabase(storage);
  storage.clearOperations();

  const loaded = database.load();

  assert.deepEqual(loaded, duplicate);
  assert.deepEqual(storage.peek(SLOT_A), duplicate);
  assert.deepEqual(storage.peek(SLOT_B), duplicate);
  storage.assertOnlyKeysWritten([ACTIVE]);
  assert.ok(storage.peek(ACTIVE) === 'a' || storage.peek(ACTIVE) === 'b');
});

test('Attack: mutator 删除必需顶层字段或把 outbox 改成非数组时必须在写槽前拒绝', () => {
  const oldA = makeSnapshot({ localRevision: 250 });
  const oldB = makeSnapshot({ localRevision: 249 });

  for (const mutate of [
    (draft) => delete draft.settings,
    (draft) => delete draft.sync,
    (draft) => {
      draft.sync.outbox = { opId: 'not-an-array' };
    }
  ]) {
    const storage = seedPair({ active: 'a', a: oldA, b: oldB });
    const database = createDatabase(storage);
    storage.clearOperations();

    assert.throws(() => database.commit(mutate), /settings|sync|outbox|object|array/i);
    storage.assertOnlyKeysWritten([]);
    assert.deepEqual(storage.peek(SLOT_A), oldA);
    assert.deepEqual(storage.peek(SLOT_B), oldB);
    assert.equal(storage.peek(ACTIVE), 'a');
  }
});

test('Attack: canonical checksum 必须与标准 SHA-256 在 Unicode、长字符串和 key 重排下完全一致', () => {
  const crypto = require('node:crypto');
  const { canonicalize, computeChecksum } = require('../../miniprogram/utils/checksum');
  const samples = [
    { message: '训练完成🏋️‍♀️', nested: { z: '末', a: '始' }, values: [3, 2, 1] },
    { payload: 'TrainFlow-长文本-'.repeat(4096), revision: 260 },
    { checksum: 'must-be-excluded', b: 2, a: 1 }
  ];

  for (const sample of samples) {
    const payload = Object.fromEntries(
      Object.entries(sample).filter(([key]) => key !== 'checksum')
    );
    const expected = crypto
      .createHash('sha256')
      .update(canonicalize(payload), 'utf8')
      .digest('hex');
    assert.equal(computeChecksum(sample), expected);
  }
});

test('Attack: storage 仅实现 get/set 而没有 remove/clear 时仍必须能完成原子 commit', () => {
  const backing = new Map([
    [SLOT_A, makeSnapshot({ localRevision: 270 })],
    [SLOT_B, makeSnapshot({ localRevision: 269 })],
    [ACTIVE, 'a']
  ]);
  const storage = {
    getStorageSync(key) {
      return clone(backing.get(key));
    },
    setStorageSync(key, value) {
      backing.set(key, clone(value));
    }
  };
  const database = createDatabase(storage);

  const committed = database.commit((draft) => {
    draft.sync.outbox.push({ opId: 'no-remove-needed' });
  });

  assert.equal(committed.localRevision, 271);
  assert.equal(committed.sync.outbox[0].opId, 'no-remove-needed');
  assert.equal(backing.get(ACTIVE), 'b');
});

test('Peer regression: 任一槽暂时不可读时 load 只能只读回退，commit 必须失败关闭且不得覆盖潜在较新槽', () => {
  const newerA = makeSnapshot({ localRevision: 280, records: [{ id: 'newer-only' }] });
  const olderB = makeSnapshot({ localRevision: 279, records: [{ id: 'older-only' }] });

  const loadStorage = seedPair({ active: 'a', a: newerA, b: olderB });
  loadStorage.failNextRead(SLOT_A, new Error('slot a temporarily unavailable'));
  loadStorage.clearOperations();

  const fallback = createDatabase(loadStorage).load();

  assert.equal(fallback.localRevision, 279);
  assert.deepEqual(fallback.records.map(({ id }) => id), ['older-only']);
  loadStorage.assertOnlyKeysWritten([]);
  assert.equal(loadStorage.peek(ACTIVE), 'a');

  const commitStorage = seedPair({ active: 'a', a: newerA, b: olderB });
  commitStorage.failNextRead(SLOT_A, new Error('baseline slot a temporarily unavailable'));
  commitStorage.failNextRead(SLOT_A, new Error('CAS slot a temporarily unavailable'));
  commitStorage.clearOperations();

  assert.throws(
    () =>
      createDatabase(commitStorage).commit((draft) => {
        draft.records.push({ id: 'must-not-overwrite-newer' });
      }),
    /read|unavailable|commit|uncertain/i
  );
  commitStorage.assertOnlyKeysWritten([]);
  assert.deepEqual(commitStorage.peek(SLOT_A), newerA);
  assert.deepEqual(commitStorage.peek(SLOT_B), olderB);
  assert.equal(commitStorage.peek(ACTIVE), 'a');

  const casStorage = seedPair({ active: 'a', a: newerA, b: olderB });
  const originalGetStorageSync = casStorage.getStorageSync.bind(casStorage);
  let slotAReads = 0;
  casStorage.getStorageSync = (key) => {
    if (key === SLOT_A) {
      slotAReads += 1;
      if (slotAReads === 2) {
        throw new Error('CAS slot a temporarily unavailable');
      }
    }
    return originalGetStorageSync(key);
  };
  casStorage.clearOperations();

  assert.throws(
    () =>
      createDatabase(casStorage).commit((draft) => {
        draft.records.push({ id: 'must-not-write-after-uncertain-CAS' });
      }),
    /read|unavailable|commit|uncertain/i
  );
  casStorage.assertOnlyKeysWritten([]);
  assert.deepEqual(casStorage.peek(SLOT_A), newerA);
  assert.deepEqual(casStorage.peek(SLOT_B), olderB);
  assert.equal(casStorage.peek(ACTIVE), 'a');
});

test('Peer regression: 同一最高 revision 的不同有效快照属于 split brain，load 与 commit 都必须失败关闭', () => {
  const branchA = makeSnapshot({ localRevision: 290, records: [{ id: 'branch-a' }] });
  const branchB = makeSnapshot({ localRevision: 290, records: [{ id: 'branch-b' }] });
  const storage = seedPair({ active: 'invalid-pointer', a: branchA, b: branchB });
  const database = createDatabase(storage);
  storage.clearOperations();

  assert.throws(() => database.load(), /split.?brain|ambiguous|divergent|revision/i);
  assert.throws(
    () => database.commit((draft) => draft.records.push({ id: 'must-not-select-a-branch' })),
    /split.?brain|ambiguous|divergent|revision/i
  );
  storage.assertOnlyKeysWritten([]);
  assert.deepEqual(storage.peek(SLOT_A), branchA);
  assert.deepEqual(storage.peek(SLOT_B), branchB);
  assert.equal(storage.peek(ACTIVE), 'invalid-pointer');
});

test('Peer regression: install 必须是 closed schema，身份凭据与任意额外字段不得进入 A/B 快照', () => {
  const forbiddenFields = ['openId', 'unionId', 'sessionKey', 'appSecret', 'credential', 'extra'];

  for (const field of forbiddenFields) {
    const install = { deviceId: 'device_fixture', createdAt: FIXED_NOW - 5000, [field]: 'secret' };
    const storage = new StorageDouble({ 'train_flow:v1:install': install });

    assert.throws(
      () => createDatabase(storage).commit((draft) => draft.records.push({ id: field })),
      /install|field|schema|unknown|forbidden|unexpected/i
    );
    storage.assertOnlyKeysWritten([]);
    assert.equal(storage.peek(SLOT_A), undefined);
    assert.equal(storage.peek(SLOT_B), undefined);
    assert.equal(storage.peek(ACTIVE), undefined);
  }

  const cleanA = makeSnapshot({ localRevision: 300 });
  const cleanB = makeSnapshot({ localRevision: 299 });
  const commitStorage = seedPair({ active: 'a', a: cleanA, b: cleanB });
  commitStorage.clearOperations();

  assert.throws(
    () =>
      createDatabase(commitStorage).commit((draft) => {
        draft.install.openId = 'must-not-persist';
      }),
    /install|field|schema|unknown|forbidden|unexpected/i
  );
  commitStorage.assertOnlyKeysWritten([]);
  assert.deepEqual(commitStorage.peek(SLOT_A), cleanA);
  assert.deepEqual(commitStorage.peek(SLOT_B), cleanB);

  const maliciousA = makeSnapshot({
    localRevision: 310,
    install: {
      deviceId: 'device_fixture',
      createdAt: FIXED_NOW - 5000,
      openId: 'checksum-valid-but-forbidden'
    }
  });
  const survivorB = makeSnapshot({ localRevision: 309, records: [{ id: 'safe-survivor' }] });
  const loadStorage = seedPair({ active: 'a', a: maliciousA, b: survivorB });
  const loaded = createDatabase(loadStorage).load();

  assert.equal(loaded.localRevision, 309);
  assert.deepEqual(loaded.install, survivorB.install);
  assert.deepEqual(loaded.records.map(({ id }) => id), ['safe-survivor']);
  assert.equal(loadStorage.peek(ACTIVE), 'b');
});

test('Reviewer regression: direct commit 必须拒绝 settings 任意额外字段且保持零写', () => {
  for (const field of ['openId', 'sessionKey', 'extra']) {
    const oldA = makeSnapshot({ localRevision: 320 });
    const oldB = makeSnapshot({ localRevision: 319 });
    const storage = seedPair({ active: 'a', a: oldA, b: oldB });
    const database = createDatabase(storage);
    storage.clearOperations();

    assert.throws(
      () =>
        database.commit((draft) => {
          draft.settings[field] = 'must-not-persist';
        }),
      /settings|field|schema|unknown|unexpected/i
    );
    storage.assertOnlyKeysWritten([]);
    assert.deepEqual(storage.peek(SLOT_A), oldA);
    assert.deepEqual(storage.peek(SLOT_B), oldB);
    assert.equal(storage.peek(ACTIVE), 'a');
  }
});

test('Reviewer regression: checksum-valid 恶意 settings 槽必须让 load 与 commit 失败关闭', () => {
  for (const field of ['openId', 'sessionKey']) {
    const maliciousA = makeSnapshot({
      localRevision: 330,
      settings: {
        ...makeSnapshot().settings,
        [field]: 'checksum-valid-but-forbidden'
      }
    });
    const safeB = makeSnapshot({ localRevision: 329, records: [{ id: 'safe-fallback' }] });
    const storage = seedPair({ active: 'a', a: maliciousA, b: safeB });
    const database = createDatabase(storage);
    storage.clearOperations();

    assert.throws(() => database.load(), /settings|field|schema|unknown|unexpected|unsafe/i);
    storage.assertOnlyKeysWritten([]);
    assert.deepEqual(storage.peek(SLOT_A), maliciousA);
    assert.deepEqual(storage.peek(SLOT_B), safeB);
    assert.equal(storage.peek(ACTIVE), 'a');

    storage.clearOperations();
    assert.throws(
      () => database.commit((draft) => draft.records.push({ id: 'must-not-commit' })),
      /settings|field|schema|unknown|unexpected|unsafe/i
    );
    storage.assertOnlyKeysWritten([]);
    assert.deepEqual(storage.peek(SLOT_A), maliciousA);
    assert.deepEqual(storage.peek(SLOT_B), safeB);
    assert.equal(storage.peek(ACTIVE), 'a');
  }
});

test('Reviewer round 2 regression: checksum mismatch 必须先按普通损坏隔离，只有 checksum-valid 未知字段才 fail closed', () => {
  const healthyA = makeSnapshot({ localRevision: 340, records: [{ id: 'healthy-active' }] });
  const staleChecksumB = makeSnapshot({ localRevision: 339, records: [{ id: 'older-inactive' }] });
  staleChecksumB.settings.openId = 'not-covered-by-stale-checksum';
  const recoverableStorage = seedPair({ active: 'a', a: healthyA, b: staleChecksumB });
  recoverableStorage.clearOperations();

  const recovered = createDatabase(recoverableStorage).load();

  assert.deepEqual(recovered, healthyA);
  recoverableStorage.assertOnlyKeysWritten([]);
  assert.deepEqual(recoverableStorage.peek(SLOT_A), healthyA);
  assert.deepEqual(recoverableStorage.peek(SLOT_B), staleChecksumB);
  assert.equal(recoverableStorage.peek(ACTIVE), 'a');

  const checksumValidB = makeSnapshot({
    localRevision: 339,
    records: [{ id: 'older-inactive' }],
    settings: {
      ...makeSnapshot().settings,
      openId: 'covered-by-valid-checksum'
    }
  });
  const unsafeStorage = seedPair({ active: 'a', a: healthyA, b: checksumValidB });
  const unsafeDatabase = createDatabase(unsafeStorage);
  unsafeStorage.clearOperations();

  assert.throws(
    () => unsafeDatabase.load(),
    /settings|field|schema|unknown|unexpected|unsafe/i
  );
  unsafeStorage.assertOnlyKeysWritten([]);

  unsafeStorage.clearOperations();
  assert.throws(
    () => unsafeDatabase.commit((draft) => draft.records.push({ id: 'must-not-commit' })),
    /settings|field|schema|unknown|unexpected|unsafe/i
  );
  unsafeStorage.assertOnlyKeysWritten([]);
  assert.deepEqual(unsafeStorage.peek(SLOT_A), healthyA);
  assert.deepEqual(unsafeStorage.peek(SLOT_B), checksumValidB);
  assert.equal(unsafeStorage.peek(ACTIVE), 'a');
});
