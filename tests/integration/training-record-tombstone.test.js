const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWorkoutSummaryRuntime
} = require('../../miniprogram/application/workout-summary-runtime');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  findTrainingRecords
} = require('../../miniprogram/domain/execution/training-record');
const {
  isDeletedTrainingRecord
} = require('../../miniprogram/domain/records/training-record');
const {
  createTrainingRecordRepository
} = require('../../miniprogram/domain/records/training-record-repository');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const {
  OPERATION_FIELDS,
  assertSyncOperation
} = require('../../miniprogram/domain/sync/sync-operation');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785976500000;
const CORRECT_AT = START_AT + 120_000;
const DELETE_AT = START_AT + 180_000;
const SUMMARY_AT = START_AT + 240_000;
const NEXT_SESSION_AT = START_AT + 300_000;
const DEVICE_ID = 'device_record_tombstone_attack';
const PRIVATE_NOTE = 'PRIVATE_TOMBSTONE_NOTE_91bf';
const ACTIVE_SLOT_KEY = 'train_flow:v1:db:active';
const SLOT_KEYS = Object.freeze({
  a: 'train_flow:v1:db:a',
  b: 'train_flow:v1:db:b'
});

function manualPlan(id, trainingDate, title) {
  const source = createDefaultPlans({ now: () => START_AT })[2];
  return {
    ...clone(source),
    id,
    trainingDate,
    title,
    templateSource: null,
    steps: [{
      ...clone(source.steps.find(({ kind }) => kind === 'manual')),
      id: `step_${id}_manual`,
      order: 1
    }]
  };
}

function createHarness() {
  const storage = new StorageDouble();
  const database = createLocalDatabase({
    storage,
    now: () => SUMMARY_AT
  });
  return {
    storage,
    database,
    sessions: createSessionRepository({ database }),
    records: createTrainingRecordRepository({ database })
  };
}

function completeSession(harness, {
  sessionId = 'session_tombstone_source',
  planId = 'plan_tombstone_source',
  trainingDate = '2026-08-06',
  title = 'Tombstone source workout',
  endedAt = START_AT + 60_000
} = {}) {
  const started = harness.sessions.start({
    plan: manualPlan(planId, trainingDate, title),
    sessionId,
    originDeviceId: DEVICE_ID,
    commandKey: `start_${sessionId}`,
    nowMs: endedAt - 60_000
  });
  return harness.sessions.apply({
    type: 'complete_step',
    expectedSessionRevision: started.sessionRevision,
    commandKey: `complete_${sessionId}`,
    nowMs: endedAt,
    payload: { stepId: started.planSnapshot.steps[0].id }
  }, { originDeviceId: DEVICE_ID }).session;
}

function recordFor(database, sessionId = 'session_tombstone_source') {
  const candidates = findTrainingRecords(database.load().records, sessionId);
  assert.equal(candidates.length, 1);
  return candidates[0];
}

function correctionCommand(record, overrides = {}) {
  return {
    recordId: record.id,
    expectedRevision: record.revision,
    commandKey: `correct_${record.id}`,
    nowMs: CORRECT_AT,
    actualCorrections: [{
      stepId: record.planSnapshot.steps[0].id,
      actualReps: 12
    }],
    feedback: {
      rpe: 8,
      weightBeforeKg: 81.5,
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

function deleteCommand(record, overrides = {}) {
  return {
    recordId: record.id,
    expectedRevision: record.revision,
    commandKey: `delete_${record.id}`,
    nowMs: DELETE_AT,
    ...overrides
  };
}

function requireDelete(repository) {
  assert.equal(
    typeof repository.delete,
    'function',
    'TrainingRecord repository must expose delete(command)'
  );
  return repository.delete.bind(repository);
}

function deleteRecord(repository, command) {
  const result = requireDelete(repository)(command);
  return result && result.record ? result.record : result;
}

function snapshotBytes(database) {
  return JSON.stringify(database.load());
}

function assertClosedKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function assertDeleteRejectedWithoutWrite(repository, database, command) {
  const remove = requireDelete(repository);
  const before = snapshotBytes(database);
  const commandBefore = clone(command);
  assert.throws(() => remove(command));
  assert.equal(snapshotBytes(database), before);
  assert.deepEqual(command, commandBefore);
}

function assertCorrectionOperation(operation, record, createdAt) {
  assertClosedKeys(operation, OPERATION_FIELDS);
  assertSyncOperation(operation);
  assert.equal(operation.entityType, 'training_record');
  assert.equal(operation.entityId, record.id);
  assert.equal(operation.action, 'upsert');
  assert.equal(operation.createdAt, createdAt);
  assert.deepEqual(operation.payload, record);
}

test('Attack Round 3: delete is one CAS commit producing a minimal private-free tombstone, sync tombstone and statistics invalidation', () => {
  const harness = createHarness();
  completeSession(harness);
  const baseline = recordFor(harness.database);
  harness.records.correct(correctionCommand(baseline));
  const corrected = recordFor(harness.database);
  const before = harness.database.load();
  const input = deleteCommand(corrected);
  const inputBefore = clone(input);

  const returned = deleteRecord(harness.records, input);
  const after = harness.database.load();
  const tombstone = after.records[0];
  const deletionOperation = after.sync.outbox.at(-1);

  assert.equal(after.localRevision, before.localRevision + 1);
  assert.equal(after.records.length, 1);
  assert.equal(tombstone.revision, corrected.revision + 1);
  assert.equal(tombstone.updatedAt, DELETE_AT);
  assert.equal(tombstone.deletedAt, DELETE_AT);
  assert.equal(isDeletedTrainingRecord(tombstone), true);
  assert.deepEqual(returned, tombstone);
  assert.notEqual(returned, tombstone);
  assert.notEqual(returned.processedDeletionCommands, tombstone.processedDeletionCommands);
  assert.deepEqual(input, inputBefore);

  assertClosedKeys(tombstone, [
    'id',
    'sourceSessionId',
    'sourceSessionFingerprint',
    'status',
    'trainingDate',
    'createdAt',
    'updatedAt',
    'revision',
    'deletedAt',
    'processedDeletionCommands'
  ]);
  assert.equal(tombstone.id, corrected.id);
  assert.equal(tombstone.sourceSessionId, corrected.sourceSessionId);
  assert.equal(tombstone.sourceSessionFingerprint, corrected.sourceSessionFingerprint);
  assert.equal(tombstone.status, corrected.status);
  assert.equal(tombstone.trainingDate, corrected.trainingDate);
  assert.equal(tombstone.createdAt, corrected.createdAt);
  assert.equal(tombstone.processedDeletionCommands.length, 1);
  assertClosedKeys(tombstone.processedDeletionCommands[0], [
    'key',
    'fingerprint',
    'resultRevision'
  ]);
  assert.equal(tombstone.processedDeletionCommands[0].key, input.commandKey);
  assert.match(tombstone.processedDeletionCommands[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(tombstone.processedDeletionCommands[0].resultRevision, tombstone.revision);

  assertClosedKeys(deletionOperation, OPERATION_FIELDS);
  assertSyncOperation(deletionOperation);
  assert.equal(deletionOperation.entityType, 'training_record');
  assert.equal(deletionOperation.entityId, tombstone.id);
  assert.equal(deletionOperation.action, 'delete');
  assert.equal(deletionOperation.payload, null);
  assert.equal(deletionOperation.createdAt, DELETE_AT);
  assert.deepEqual(after.statisticsProjection, {
    dirty: true,
    reason: 'training-record-changed',
    recordId: tombstone.id,
    recordRevision: tombstone.revision,
    invalidatedAt: DELETE_AT
  });

  const tombstoneJson = JSON.stringify(tombstone);
  assert.doesNotMatch(
    tombstoneJson,
    /planSnapshot|stepResults|feedback|actualCorrections|processedCorrectionCommands|note|pain|rpe|weightBeforeKg/i
  );
  assert.equal(tombstoneJson.includes(PRIVATE_NOTE), false);
  assert.equal(tombstoneJson.includes(corrected.planSnapshot.title), false);
  assert.equal(tombstoneJson.includes(corrected.planSnapshot.steps[0].id), false);

  returned.processedDeletionCommands[0].key = 'mutated-return';
  assert.equal(recordFor(harness.database).processedDeletionCommands[0].key, input.commandKey);
});

test('Reviewer regression: deleting a valid legacy record derives its missing source fingerprint before writing the tombstone', () => {
  const harness = createHarness();
  completeSession(harness, { sessionId: 'session_legacy_delete_fingerprint' });
  const canonical = recordFor(harness.database, 'session_legacy_delete_fingerprint');
  const expectedFingerprint = canonical.sourceSessionFingerprint;

  harness.database.commit((draft) => {
    delete draft.records[0].sourceSessionFingerprint;
  });
  const legacy = recordFor(harness.database, 'session_legacy_delete_fingerprint');
  assert.equal(Object.hasOwn(legacy, 'sourceSessionFingerprint'), false);

  const tombstone = deleteRecord(harness.records, deleteCommand(legacy, {
    commandKey: 'delete_legacy_fingerprint'
  }));

  assert.equal(tombstone.sourceSessionFingerprint, expectedFingerprint);
  assert.match(tombstone.sourceSessionFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(tombstone, 'planSnapshot'), false);
  assert.equal(Object.hasOwn(tombstone, 'feedback'), false);
  assert.deepEqual(recordFor(
    harness.database,
    'session_legacy_delete_fingerprint'
  ), tombstone);
});

test('Attack Round 3: exact delete replay is a zero-write deep copy while conflicting, stale and correction-after-delete intents fail closed', () => {
  const harness = createHarness();
  completeSession(harness);
  const sourceRecord = recordFor(harness.database);
  const input = deleteCommand(sourceRecord, { commandKey: 'delete_replay_key' });
  const first = deleteRecord(harness.records, input);
  const afterFirst = snapshotBytes(harness.database);

  const replay = deleteRecord(harness.records, input);
  assert.equal(snapshotBytes(harness.database), afterFirst);
  assert.deepEqual(replay, first);
  assert.notEqual(replay, first);
  assert.notEqual(replay.processedDeletionCommands, first.processedDeletionCommands);

  assertDeleteRejectedWithoutWrite(harness.records, harness.database, {
    ...input,
    nowMs: input.nowMs + 1
  });

  const staleHarness = createHarness();
  completeSession(staleHarness);
  const staleRecord = recordFor(staleHarness.database);
  assertDeleteRejectedWithoutWrite(
    staleHarness.records,
    staleHarness.database,
    deleteCommand(staleRecord, {
      expectedRevision: staleRecord.revision - 1,
      commandKey: 'stale_delete'
    })
  );

  const correctionAfterDelete = correctionCommand(sourceRecord, {
    expectedRevision: first.revision,
    commandKey: 'correct_deleted_record',
    nowMs: DELETE_AT + 1
  });
  const beforeCorrection = snapshotBytes(harness.database);
  assert.throws(() => harness.records.correct(correctionAfterDelete));
  assert.equal(snapshotBytes(harness.database), beforeCorrection);
});

test('Test adequacy: delete passes its loaded localRevision into commit so a racing baseline cannot be overwritten', () => {
  const harness = createHarness();
  completeSession(harness);
  const sourceRecord = recordFor(harness.database);
  const staleBaseline = harness.database.load();
  let armed = false;
  let raced = false;
  const observedCommits = [];
  const racingDatabase = {
    load() {
      const snapshot = harness.database.load();
      if (armed && !raced) {
        raced = true;
        harness.database.commit((draft) => {
          draft.statisticsProjection.concurrentDeleteMarker = 'preserve-racing-write';
        });
      }
      return snapshot;
    },
    commit(mutator, expectedRevision) {
      observedCommits.push({ argumentCount: arguments.length, expectedRevision });
      return harness.database.commit(mutator, expectedRevision);
    }
  };
  const racingRecords = createTrainingRecordRepository({ database: racingDatabase });
  const input = deleteCommand(sourceRecord, { commandKey: 'racing_record_delete' });
  const inputBefore = clone(input);
  armed = true;

  assert.throws(() => deleteRecord(racingRecords, input), /revision|conflict|concurrent/i);

  const after = harness.database.load();
  assert.equal(raced, true, 'test facade must inject the concurrent write after repository load');
  assert.deepEqual(observedCommits, [{
    argumentCount: 2,
    expectedRevision: staleBaseline.localRevision
  }]);
  assert.equal(after.localRevision, staleBaseline.localRevision + 1, 'only the racing commit may persist');
  assert.equal(after.statisticsProjection.concurrentDeleteMarker, 'preserve-racing-write');
  assert.deepEqual(after.records, staleBaseline.records);
  assert.deepEqual(after.sync.outbox, staleBaseline.sync.outbox);
  assert.deepEqual(input, inputBefore);
});

test('Test adequacy: injected storage failure leaves delete record, outbox and statistics byte-equivalent', () => {
  const harness = createHarness();
  completeSession(harness);
  const sourceRecord = recordFor(harness.database);
  const before = harness.database.load();
  const input = deleteCommand(sourceRecord, { commandKey: 'storage_failure_record_delete' });
  const inputBefore = clone(input);
  const activeSlot = harness.storage.peek(ACTIVE_SLOT_KEY);
  const targetSlot = activeSlot === 'a' ? 'b' : 'a';
  harness.storage.failNextWrite(
    SLOT_KEYS[targetSlot],
    new Error('forced delete storage failure')
  );

  assert.throws(
    () => deleteRecord(harness.records, input),
    /forced delete storage failure/i
  );

  const after = harness.database.load();
  assert.equal(snapshotBytes(harness.database), JSON.stringify(before));
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(after.sync.outbox, before.sync.outbox);
  assert.deepEqual(after.statisticsProjection, before.statisticsProjection);
  assert.deepEqual(input, inputBefore);
});

test('Attack Round 3: terminal materialization preserves a tombstone and never resurrects its baseline when a new Session starts', () => {
  const harness = createHarness();
  const terminal = completeSession(harness);
  const baseline = recordFor(harness.database, terminal.id);
  harness.records.correct(correctionCommand(baseline));
  const corrected = recordFor(harness.database, terminal.id);
  deleteRecord(harness.records, deleteCommand(corrected));
  const beforeStart = harness.database.load();
  const tombstoneBefore = clone(recordFor(harness.database, terminal.id));
  const outboxBefore = clone(beforeStart.sync.outbox);

  const next = harness.sessions.start({
    plan: manualPlan('plan_after_tombstone', '2026-08-07', 'Workout after tombstone'),
    sessionId: 'session_after_tombstone',
    originDeviceId: DEVICE_ID,
    commandKey: 'start_after_tombstone',
    nowMs: NEXT_SESSION_AT
  });
  const afterStart = harness.database.load();

  assert.equal(next.id, 'session_after_tombstone');
  assert.equal(afterStart.activeSession.id, next.id);
  assert.equal(afterStart.localRevision, beforeStart.localRevision + 1);
  assert.equal(afterStart.records.length, 1);
  assert.deepEqual(recordFor(harness.database, terminal.id), tombstoneBefore);
  assert.deepEqual(afterStart.sync.outbox, outboxBefore, 'materializer must not enqueue a second deletion or save intent');
  assert.equal(findTrainingRecords(afterStart.records, terminal.id).length, 1);
  assert.equal(isDeletedTrainingRecord(afterStart.records[0]), true);
});

test('Attack Round 3: Workout Summary feedback updates preserve corrections and use the repository atomic outbox plus statistics boundary', () => {
  const harness = createHarness();
  const terminal = completeSession(harness);
  const baseline = recordFor(harness.database, terminal.id);
  harness.records.correct(correctionCommand(baseline, {
    commandKey: 'initial_record_correction'
  }));
  const correctedBefore = clone(recordFor(harness.database, terminal.id));
  const before = harness.database.load();
  const runtime = createWorkoutSummaryRuntime({
    database: harness.database,
    now: () => SUMMARY_AT
  });

  const loaded = runtime.load({ sessionId: terminal.id });
  assert.equal(loaded.saved, true);
  assert.equal(loaded.feedback.note, PRIVATE_NOTE);
  const saved = runtime.saveFeedback({
    rpe: 6,
    weightBeforeKg: null,
    pain: { lowerBack: true },
    note: 'UPDATED_PRIVATE_SUMMARY_NOTE_62cd'
  });
  const after = harness.database.load();
  const record = recordFor(harness.database, terminal.id);
  const descriptor = after.sync.outbox.at(-1);

  assert.equal(saved.saved, true);
  assert.equal(after.localRevision, before.localRevision + 1);
  assert.equal(after.records.length, 1);
  assert.equal(record.revision, correctedBefore.revision + 1);
  assert.deepEqual(record.actualCorrections, correctedBefore.actualCorrections);
  assert.equal(record.feedback.rpe, 6);
  assert.equal(record.feedback.note, 'UPDATED_PRIVATE_SUMMARY_NOTE_62cd');
  assert.equal(after.sync.outbox.length, before.sync.outbox.length + 1);
  assertCorrectionOperation(descriptor, record, SUMMARY_AT);
  assert.deepEqual(after.statisticsProjection, {
    dirty: true,
    reason: 'training-record-changed',
    recordId: record.id,
    recordRevision: record.revision,
    invalidatedAt: SUMMARY_AT
  });
});

test('Attack Round 3: summary load and previously-bound save both reject active and historical tombstones without resurrection', () => {
  for (const mode of ['active-terminal-source', 'historical-tombstone']) {
    const harness = createHarness();
    const terminal = completeSession(harness, {
      sessionId: `session_summary_tombstone_${mode}`,
      planId: `plan_summary_tombstone_${mode}`
    });
    const boundRuntime = createWorkoutSummaryRuntime({
      database: harness.database,
      now: () => SUMMARY_AT
    });
    boundRuntime.load({ sessionId: terminal.id });
    const baseline = recordFor(harness.database, terminal.id);
    deleteRecord(harness.records, deleteCommand(baseline, {
      commandKey: `delete_summary_${mode}`
    }));

    if (mode === 'historical-tombstone') {
      harness.sessions.start({
        plan: manualPlan('plan_summary_tombstone_next', '2026-08-08', 'Next summary workout'),
        sessionId: 'session_summary_tombstone_next',
        originDeviceId: DEVICE_ID,
        commandKey: 'start_summary_tombstone_next',
        nowMs: NEXT_SESSION_AT
      });
    }

    const beforeFailure = snapshotBytes(harness.database);
    assert.throws(
      () => createWorkoutSummaryRuntime({ database: harness.database })
        .load({ sessionId: terminal.id })
    );
    assert.throws(
      () => boundRuntime.saveFeedback({ rpe: 5, note: 'must-not-resurrect' })
    );
    assert.equal(snapshotBytes(harness.database), beforeFailure);
    const tombstones = findTrainingRecords(harness.database.load().records, terminal.id);
    assert.equal(tombstones.length, 1, 'identity query retains one tombstone for no-resurrection checks');
    assert.equal(isDeletedTrainingRecord(tombstones[0]), true);
  }
});

test('Attack Round 3: authorized corrected records pass terminal source validation while unknown fields or fingerprint tampering fail closed', () => {
  {
    const harness = createHarness();
    const terminal = completeSession(harness);
    const baseline = recordFor(harness.database, terminal.id);
    harness.records.correct(correctionCommand(baseline, {
      commandKey: 'correct_before_terminal_recheck'
    }));
    const correctedBefore = clone(recordFor(harness.database, terminal.id));
    const outboxBefore = clone(harness.database.load().sync.outbox);

    harness.sessions.start({
      plan: manualPlan('plan_after_corrected_record', '2026-08-09', 'Workout after correction'),
      sessionId: 'session_after_corrected_record',
      originDeviceId: DEVICE_ID,
      commandKey: 'start_after_corrected_record',
      nowMs: NEXT_SESSION_AT
    });

    assert.deepEqual(recordFor(harness.database, terminal.id), correctedBefore);
    assert.deepEqual(harness.database.load().sync.outbox, outboxBefore);
  }

  for (const tamper of [
    (record) => { record.unknownPrivateField = 'forged'; },
    (record) => { record.sourceSessionFingerprint = '0'.repeat(64); }
  ]) {
    const harness = createHarness();
    const terminal = completeSession(harness);
    const baseline = recordFor(harness.database, terminal.id);
    harness.records.correct(correctionCommand(baseline, {
      commandKey: 'correct_before_tamper'
    }));
    harness.database.commit((draft) => {
      tamper(draft.records[0]);
    });
    const before = snapshotBytes(harness.database);

    assert.throws(() => harness.sessions.start({
      plan: manualPlan('plan_after_tamper', '2026-08-10', 'Workout after tamper'),
      sessionId: 'session_after_tamper',
      originDeviceId: DEVICE_ID,
      commandKey: 'start_after_tamper',
      nowMs: NEXT_SESSION_AT
    }));
    assert.equal(snapshotBytes(harness.database), before);
  }
});
