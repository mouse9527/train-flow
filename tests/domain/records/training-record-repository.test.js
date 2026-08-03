const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createBaselineTrainingRecord
} = require('../../../miniprogram/domain/execution/training-record');
const {
  applyWorkoutCommand,
  assertWorkoutSession,
  createWorkoutSession
} = require('../../../miniprogram/domain/execution/workout-session');
const {
  createDefaultPlans
} = require('../../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../../helpers/storage-double');

const NOW = 1785976500000;
const CORRECTION_NOW = NOW + 120_000;
const SLOT_B = 'train_flow:v1:db:b';
const PRIVATE_NOTE = 'PRIVATE_RECORD_NOTE_7a31';

let repositoryApi = {};
let repositoryApiLoadError = null;
try {
  repositoryApi = require('../../../miniprogram/domain/records/training-record-repository');
} catch (error) {
  repositoryApiLoadError = error;
}

function requireRepositoryFactory() {
  assert.equal(
    typeof repositoryApi.createTrainingRecordRepository,
    'function',
    repositoryApiLoadError
      ? `TrainingRecord repository must export createTrainingRecordRepository(): ${repositoryApiLoadError.message}`
      : 'TrainingRecord repository must export createTrainingRecordRepository()'
  );
  return repositoryApi.createTrainingRecordRepository;
}

function createRepository(database) {
  const repository = requireRepositoryFactory()({ database });
  assert.equal(typeof repository.correct, 'function', 'TrainingRecord repository must expose correct(command)');
  return repository;
}

function unwrapRecord(result) {
  return result && result.record ? result.record : result;
}

function canonicalManualRecord() {
  const sourcePlan = createDefaultPlans({ now: () => NOW })[2];
  const manualStep = sourcePlan.steps.find(({ kind }) => kind === 'manual');
  const plan = {
    ...clone(sourcePlan),
    id: 'plan_record_repository_fixture',
    title: 'TrainingRecord repository fixture',
    trainingDate: '2026-08-06',
    steps: [{
      ...clone(manualStep),
      id: 'step_record_repository_manual',
      order: 10
    }]
  };
  let session = createWorkoutSession({
    plan,
    sessionId: 'session_record_repository_fixture',
    originDeviceId: 'device_record_repository_attack',
    commandKey: 'start_record_repository_fixture',
    nowMs: NOW
  });
  session = applyWorkoutCommand(session, {
    type: 'complete_step',
    expectedSessionRevision: session.sessionRevision,
    commandKey: 'complete_record_repository_manual',
    nowMs: NOW + 60_000,
    payload: { stepId: session.planSnapshot.steps[0].id }
  }).session;
  assert.equal(session.status, 'completed');
  assert.equal(assertWorkoutSession(session), session);
  return createBaselineTrainingRecord(session);
}

function createHarness({ records, mutateSeed } = {}) {
  const storage = new StorageDouble();
  const database = createLocalDatabase({
    storage,
    now: () => CORRECTION_NOW
  });
  const canonical = canonicalManualRecord();
  const seededRecords = records === undefined ? [canonical] : records;
  database.commit((draft) => {
    draft.records.push(...clone(seededRecords));
    if (mutateSeed) {
      mutateSeed(draft);
    }
  });
  return { storage, database, canonical };
}

function correctionCommand(record, overrides = {}) {
  return {
    recordId: record.id,
    expectedRevision: record.revision,
    commandKey: `correct_${record.id}`,
    nowMs: CORRECTION_NOW,
    actualCorrections: [{
      stepId: record.planSnapshot.steps[0].id,
      actualReps: 13
    }],
    feedback: {
      rpe: 8,
      weightBeforeKg: 83.7,
      pain: {
        knee: true,
        lowerBack: false,
        ankleOrToe: false,
        dizziness: false
      },
      note: PRIVATE_NOTE
    },
    ...overrides
  };
}

function snapshotBytes(snapshot) {
  return JSON.stringify(snapshot);
}

function assertClosedKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertRejectedWithoutWrite(database, command) {
  const repository = createRepository(database);
  const before = database.load();
  const beforeBytes = snapshotBytes(before);
  const commandBefore = clone(command);

  assert.throws(() => repository.correct(command));

  assert.equal(snapshotBytes(database.load()), beforeBytes, 'rejected command must leave the durable snapshot byte-equivalent');
  assert.deepEqual(command, commandBefore, 'rejected command must not be mutated');
}

test('Attack Round 2: one successful correction atomically replaces the record and writes one outbox plus one statistics invalidation', () => {
  const { database, canonical } = createHarness();
  const repository = createRepository(database);
  const before = database.load();
  const input = correctionCommand(canonical);
  const inputBefore = clone(input);

  const corrected = unwrapRecord(repository.correct(input));
  const after = database.load();

  assert.equal(after.localRevision, before.localRevision + 1, 'record, outbox and invalidation must share one LocalDatabase commit');
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].id, canonical.id);
  assert.equal(after.records[0].revision, canonical.revision + 1);
  assert.deepEqual(after.records[0], corrected);
  assert.equal(after.sync.outbox.length, before.sync.outbox.length + 1);
  assert.equal(after.statisticsProjection.dirty, true);
  assert.equal(after.statisticsProjection.recordId, canonical.id);
  assert.equal(after.statisticsProjection.recordRevision, corrected.revision);
  assert.deepEqual(input, inputBefore, 'repository must not mutate the correction command');
  assert.notEqual(corrected, after.records[0], 'returned record must not alias durable state');
  assert.notEqual(corrected.feedback, after.records[0].feedback);
  assert.notEqual(corrected.actualCorrections, after.records[0].actualCorrections);

  corrected.feedback.note = 'mutated returned record';
  corrected.actualCorrections[0].actualReps = 999;
  assert.equal(database.load().records[0].feedback.note, PRIVATE_NOTE);
  assert.equal(database.load().records[0].actualCorrections[0].actualReps, 13);
});

test('Attack Round 2: sync and statistics descriptors are strictly closed and never leak correction or feedback payloads', () => {
  const { database, canonical } = createHarness();
  const corrected = unwrapRecord(
    createRepository(database).correct(correctionCommand(canonical))
  );
  const snapshot = database.load();
  const outbox = snapshot.sync.outbox.at(-1);
  const invalidation = snapshot.statisticsProjection;

  assertClosedKeys(outbox, [
    'opId',
    'kind',
    'entityType',
    'entityId',
    'entityRevision',
    'occurredAt'
  ]);
  assert.equal(typeof outbox.opId, 'string');
  assert.notEqual(outbox.opId.length, 0);
  assert.equal(outbox.kind, 'training-record.corrected');
  assert.equal(outbox.entityType, 'training-record');
  assert.equal(outbox.entityId, canonical.id);
  assert.equal(outbox.entityRevision, corrected.revision);
  assert.equal(outbox.occurredAt, CORRECTION_NOW);

  assert.deepEqual(invalidation, {
    dirty: true,
    reason: 'training-record-changed',
    recordId: canonical.id,
    recordRevision: corrected.revision,
    invalidatedAt: CORRECTION_NOW
  });

  const descriptorJson = JSON.stringify({ outbox, invalidation });
  assert.doesNotMatch(
    descriptorJson,
    /note|pain|rpe|weightBeforeKg|actualCorrections|feedback/i
  );
  assert.equal(descriptorJson.includes(PRIVATE_NOTE), false);
  assert.equal(
    descriptorJson.includes(canonical.planSnapshot.steps[0].id),
    false,
    'actual correction step identity must not leak into the descriptor'
  );
});

test('Attack Round 2: exact replay is a zero-write deep-copy while same command key with different intent is rejected', () => {
  const { database, canonical } = createHarness();
  const repository = createRepository(database);
  const input = correctionCommand(canonical, { commandKey: 'record_repository_replay' });
  const first = unwrapRecord(repository.correct(input));
  const afterFirst = database.load();
  const afterFirstBytes = snapshotBytes(afterFirst);

  const replay = unwrapRecord(repository.correct(input));
  const afterReplay = database.load();

  assert.equal(snapshotBytes(afterReplay), afterFirstBytes);
  assert.deepEqual(replay, first);
  assert.notEqual(replay, first);
  assert.notEqual(replay.feedback, first.feedback);
  assert.notEqual(replay.actualCorrections, first.actualCorrections);
  assert.equal(afterReplay.sync.outbox.length, 1);

  const conflictingIntent = correctionCommand(canonical, {
    commandKey: input.commandKey,
    actualCorrections: [{
      stepId: canonical.planSnapshot.steps[0].id,
      actualReps: 14
    }]
  });
  assertRejectedWithoutWrite(database, conflictingIntent);
});

test('Attack Round 2: stale, unknown, canonical identity collisions and duplicate candidates reject with byte-equivalent storage', () => {
  {
    const { database, canonical } = createHarness();
    assertRejectedWithoutWrite(database, correctionCommand(canonical, {
      expectedRevision: canonical.revision - 1,
      commandKey: 'stale_record_correction'
    }));
  }
  {
    const { database, canonical } = createHarness({ records: [] });
    assertRejectedWithoutWrite(database, correctionCommand(canonical, {
      recordId: 'record_unknown',
      commandKey: 'unknown_record_correction'
    }));
  }
  {
    const canonical = canonicalManualRecord();
    const idCollision = {
      ...clone(canonical),
      sourceSessionId: 'different_source_session'
    };
    const { database } = createHarness({ records: [idCollision] });
    assertRejectedWithoutWrite(database, correctionCommand(canonical, {
      commandKey: 'canonical_id_collision'
    }));
  }
  {
    const canonical = canonicalManualRecord();
    const sourceCollision = {
      ...clone(canonical),
      id: 'forged_noncanonical_record_id'
    };
    const { database } = createHarness({ records: [sourceCollision] });
    assertRejectedWithoutWrite(database, correctionCommand(canonical, {
      commandKey: 'canonical_source_collision'
    }));
  }
  {
    const canonical = canonicalManualRecord();
    const duplicate = {
      ...clone(canonical),
      id: 'duplicate_source_candidate'
    };
    const { database } = createHarness({ records: [canonical, duplicate] });
    assertRejectedWithoutWrite(database, correctionCommand(canonical, {
      commandKey: 'duplicate_record_candidates'
    }));
  }
});

test('Attack Round 2: repository passes the loaded localRevision into commit so a racing baseline cannot be overwritten', () => {
  const { database, canonical } = createHarness();
  const staleBaseline = database.load();
  let armed = false;
  let raced = false;
  const observedCommits = [];
  const racingDatabase = {
    load() {
      const snapshot = database.load();
      if (armed && !raced) {
        raced = true;
        database.commit((draft) => {
          draft.statisticsProjection.concurrentMarker = 'preserve-concurrent-write';
        });
      }
      return snapshot;
    },
    commit(mutator, expectedRevision) {
      observedCommits.push({ argumentCount: arguments.length, expectedRevision });
      return database.commit(mutator, expectedRevision);
    }
  };
  const repository = createRepository(racingDatabase);
  armed = true;
  const input = correctionCommand(canonical, { commandKey: 'racing_record_correction' });
  const inputBefore = clone(input);

  assert.throws(() => repository.correct(input), /revision|conflict|concurrent/i);

  const after = database.load();
  assert.equal(raced, true, 'test facade must inject the concurrent commit after repository load');
  assert.deepEqual(observedCommits, [{
    argumentCount: 2,
    expectedRevision: staleBaseline.localRevision
  }]);
  assert.equal(after.localRevision, staleBaseline.localRevision + 1, 'only the racing commit may advance localRevision');
  assert.equal(after.statisticsProjection.concurrentMarker, 'preserve-concurrent-write');
  assert.deepEqual(after.records, staleBaseline.records);
  assert.deepEqual(after.sync.outbox, staleBaseline.sync.outbox);
  assert.deepEqual(input, inputBefore);
});

test('Attack Round 2: commit and storage failures expose no record-only or outbox-only state and keep command inputs inert', () => {
  {
    const { database, canonical } = createHarness();
    const before = database.load();
    const input = correctionCommand(canonical, { commandKey: 'commit_failure' });
    const inputBefore = clone(input);
    const failingDatabase = {
      load: () => database.load(),
      commit() {
        throw new Error('forced commit failure');
      }
    };
    const repository = createRepository(failingDatabase);

    assert.throws(() => repository.correct(input), /forced commit failure/i);
    assert.equal(snapshotBytes(database.load()), snapshotBytes(before));
    assert.deepEqual(input, inputBefore);
  }

  {
    const { storage, database, canonical } = createHarness();
    const before = database.load();
    const input = correctionCommand(canonical, { commandKey: 'storage_failure' });
    const inputBefore = clone(input);
    storage.failNextWrite(SLOT_B, new Error('forced storage failure'));
    const repository = createRepository(database);

    assert.throws(() => repository.correct(input), /forced storage failure/i);
    const after = database.load();
    assert.equal(snapshotBytes(after), snapshotBytes(before));
    assert.deepEqual(after.records, before.records);
    assert.deepEqual(after.sync.outbox, before.sync.outbox);
    assert.deepEqual(after.statisticsProjection, before.statisticsProjection);
    assert.deepEqual(input, inputBefore);
  }
});

test('Attack Round 5: repository late replay of correction A returns current B state with zero durable writes or duplicate intents', () => {
  const { database, canonical } = createHarness();
  const repository = createRepository(database);
  const manualStepId = canonical.planSnapshot.steps[0].id;
  const commandA = correctionCommand(canonical, {
    commandKey: 'repository_historical_a'
  });
  const afterA = unwrapRecord(repository.correct(commandA));
  const commandB = correctionCommand(afterA, {
    expectedRevision: afterA.revision,
    commandKey: 'repository_newer_b',
    nowMs: CORRECTION_NOW + 1_000,
    actualCorrections: [{ stepId: manualStepId, actualReps: 21 }],
    feedback: {
      rpe: 5,
      weightBeforeKg: null,
      pain: {
        knee: false,
        lowerBack: true,
        ankleOrToe: false,
        dizziness: false
      },
      note: 'repository current B state'
    }
  });
  const afterB = unwrapRecord(repository.correct(commandB));
  const snapshotAfterB = database.load();
  const snapshotBytesAfterB = JSON.stringify(snapshotAfterB);
  const commandABeforeReplay = clone(commandA);

  const lateReplay = unwrapRecord(repository.correct(commandA));
  const snapshotAfterReplay = database.load();

  assert.equal(lateReplay.revision, afterB.revision);
  assert.equal(lateReplay.actualCorrections[0].actualReps, 21);
  assert.equal(lateReplay.feedback.note, 'repository current B state');
  assert.deepEqual(lateReplay, afterB);
  assert.notEqual(lateReplay, afterB);
  assert.notEqual(lateReplay.feedback, afterB.feedback);
  assert.notEqual(lateReplay.actualCorrections, afterB.actualCorrections);
  assert.equal(JSON.stringify(snapshotAfterReplay), snapshotBytesAfterB);
  assert.equal(snapshotAfterReplay.localRevision, snapshotAfterB.localRevision);
  assert.deepEqual(snapshotAfterReplay.sync.outbox, snapshotAfterB.sync.outbox);
  assert.deepEqual(snapshotAfterReplay.statisticsProjection, snapshotAfterB.statisticsProjection);
  assert.deepEqual(commandA, commandABeforeReplay);

  lateReplay.feedback.note = 'mutated replay result';
  lateReplay.actualCorrections[0].actualReps = 999;
  assert.equal(database.load().records[0].feedback.note, 'repository current B state');
  assert.equal(database.load().records[0].actualCorrections[0].actualReps, 21);
});
