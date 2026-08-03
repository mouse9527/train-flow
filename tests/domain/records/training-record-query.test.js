const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyWorkoutCommand,
  assertWorkoutSession,
  createWorkoutSession
} = require('../../../miniprogram/domain/execution/workout-session');
const {
  createBaselineTrainingRecord,
  findTrainingRecords
} = require('../../../miniprogram/domain/execution/training-record');
const {
  isDeletedTrainingRecord
} = require('../../../miniprogram/domain/records/training-record');
const {
  createTrainingRecordRepository
} = require('../../../miniprogram/domain/records/training-record-repository');
const {
  createDefaultPlans
} = require('../../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../../helpers/storage-double');

const NOW = 1786149300000;
const CORRECT_AT = NOW + 900_000;
const DELETE_AT = NOW + 960_000;

function stepForKind(kind) {
  const plans = createDefaultPlans({ now: () => NOW });
  const sourcePlan = kind === 'interval' ? plans[3] : kind === 'manual' ? plans[2] : plans[0];
  return {
    sourcePlan,
    step: sourcePlan.steps.find((candidate) => candidate.kind === kind)
  };
}

function singleKindPlan({ id, trainingDate, kind }) {
  const { sourcePlan, step } = stepForKind(kind);
  return {
    ...clone(sourcePlan),
    id,
    trainingDate,
    title: `${kind} query fixture`,
    templateSource: null,
    steps: [{
      ...clone(step),
      id: `step_${id}_${kind}`,
      order: 1,
      ...(kind === 'interval' ? { sets: 1, restSeconds: 0 } : {}),
      ...(kind === 'strength' ? { sets: 1, restSeconds: 0 } : {})
    }]
  };
}

function apply(session, type, commandKey, nowMs, payload = {}) {
  return applyWorkoutCommand(session, {
    type,
    expectedSessionRevision: session.sessionRevision,
    commandKey,
    nowMs,
    payload
  }).session;
}

function completedRecord({ sessionId, planId, trainingDate, kind, endedAt }) {
  let session = createWorkoutSession({
    plan: singleKindPlan({ id: planId, trainingDate, kind }),
    sessionId,
    originDeviceId: 'device_record_query_attack',
    commandKey: `start_${sessionId}`,
    nowMs: endedAt - 600_000
  });
  const step = session.planSnapshot.steps[0];
  if (kind === 'manual') {
    session = apply(session, 'complete_step', `complete_${sessionId}`, endedAt, {
      stepId: step.id
    });
  } else if (kind === 'strength') {
    session = apply(session, 'complete_set', `complete_${sessionId}`, endedAt, {
      stepId: step.id,
      setNumber: 1,
      reps: 11,
      weightKg: 20
    });
  } else {
    session = apply(session, 'start_step', `start_step_${sessionId}`, endedAt - step.durationSeconds * 1_000, {
      stepId: step.id
    });
    session = apply(session, 'confirm_next', `confirm_${sessionId}`, session.timer.expectedEndAt, {
      stepId: step.id
    });
  }
  assert.equal(session.status, 'completed');
  assert.equal(assertWorkoutSession(session), session);
  return createBaselineTrainingRecord(session);
}

function abortedMixedRecord({ sessionId, trainingDate, endedAt }) {
  const plans = createDefaultPlans({ now: () => NOW });
  const sourcePlan = plans[0];
  const manual = plans[2].steps.find(({ kind }) => kind === 'manual');
  const timed = plans[0].steps.find(({ kind }) => kind === 'timed');
  const interval = plans[3].steps.find(({ kind }) => kind === 'interval');
  const strength = plans[0].steps.find(({ kind }) => kind === 'strength');
  const plan = {
    ...clone(sourcePlan),
    id: `plan_${sessionId}`,
    trainingDate,
    title: 'aborted mixed query fixture',
    templateSource: null,
    steps: [manual, timed, interval, strength].map((step, index) => ({
      ...clone(step),
      id: `step_${sessionId}_${step.kind}`,
      order: index + 1,
      ...(step.kind === 'interval' ? { sets: 1, restSeconds: 0 } : {}),
      ...(step.kind === 'strength' ? { sets: 1, restSeconds: 0 } : {})
    }))
  };
  let session = createWorkoutSession({
    plan,
    sessionId,
    originDeviceId: 'device_record_query_attack',
    commandKey: `start_${sessionId}`,
    nowMs: endedAt - 3_000
  });
  session = apply(session, 'complete_step', `complete_manual_${sessionId}`, endedAt - 2_000, {
    stepId: session.planSnapshot.steps[0].id
  });
  session = apply(session, 'skip_step', `skip_timed_${sessionId}`, endedAt - 1_000, {
    stepId: session.planSnapshot.steps[1].id
  });
  session = apply(session, 'abort', `abort_${sessionId}`, endedAt, {
    reason: 'user-ended-workout'
  });
  assert.equal(session.status, 'aborted');
  assert.equal(assertWorkoutSession(session), session);
  return createBaselineTrainingRecord(session);
}

function createHarness(records) {
  const database = createLocalDatabase({
    storage: new StorageDouble(),
    now: () => CORRECT_AT
  });
  database.commit((draft) => {
    draft.records.push(...clone(records));
  });
  return {
    database,
    repository: createTrainingRecordRepository({ database })
  };
}

function requireQueries(repository) {
  assert.equal(typeof repository.list, 'function', 'TrainingRecord repository must expose list(query)');
  assert.equal(typeof repository.findById, 'function', 'TrainingRecord repository must expose findById(recordId)');
  return {
    list: repository.list.bind(repository),
    findById: repository.findById.bind(repository)
  };
}

function correctionCommand(record, actualCorrections, overrides = {}) {
  return {
    recordId: record.id,
    expectedRevision: record.revision,
    commandKey: `correct_query_${record.id}`,
    nowMs: CORRECT_AT,
    actualCorrections,
    feedback: {
      rpe: 7,
      weightBeforeKg: null,
      pain: {},
      note: ''
    },
    ...overrides
  };
}

function recordIds(records) {
  return records.map(({ id }) => id);
}

function snapshotBytes(database) {
  return JSON.stringify(database.load());
}

test('Attack Round 4: default query order is deterministic by date, end time and id with fully deep-cloned results', () => {
  const records = [
    completedRecord({
      sessionId: 'session_sort_older',
      planId: 'plan_sort_older',
      trainingDate: '2026-08-05',
      kind: 'manual',
      endedAt: NOW + 100_000
    }),
    completedRecord({
      sessionId: 'session_sort_z',
      planId: 'plan_sort_z',
      trainingDate: '2026-08-06',
      kind: 'timed',
      endedAt: NOW + 300_000
    }),
    completedRecord({
      sessionId: 'session_sort_a',
      planId: 'plan_sort_a',
      trainingDate: '2026-08-06',
      kind: 'interval',
      endedAt: NOW + 300_000
    }),
    completedRecord({
      sessionId: 'session_sort_early',
      planId: 'plan_sort_early',
      trainingDate: '2026-08-06',
      kind: 'strength',
      endedAt: NOW + 200_000
    })
  ];
  const { database, repository } = createHarness(records);
  const { list } = requireQueries(repository);
  const before = snapshotBytes(database);

  const first = list();
  const second = list({ trainingDate: null, kind: null });

  assert.deepEqual(recordIds(first), [
    'record_session_sort_a',
    'record_session_sort_z',
    'record_session_sort_early',
    'record_session_sort_older'
  ]);
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  assert.notEqual(second[0], first[0]);
  assert.notEqual(second[0].planSnapshot, first[0].planSnapshot);
  assert.notEqual(second[0].stepResults, first[0].stepResults);

  first[0].planSnapshot.title = 'mutated query result';
  first[0].stepResults[0].status = 'skipped';
  assert.deepEqual(list(), second, 'later queries must not alias an earlier result');
  assert.equal(snapshotBytes(database), before, 'read queries must never mutate or commit storage');
});

test('Attack Round 4: exact date and immutable plan-kind filters compose honestly and empty results stay empty', () => {
  const records = [
    completedRecord({ sessionId: 'session_filter_manual', planId: 'plan_filter_manual', trainingDate: '2026-08-06', kind: 'manual', endedAt: NOW + 100_000 }),
    completedRecord({ sessionId: 'session_filter_timed', planId: 'plan_filter_timed', trainingDate: '2026-08-06', kind: 'timed', endedAt: NOW + 200_000 }),
    completedRecord({ sessionId: 'session_filter_interval', planId: 'plan_filter_interval', trainingDate: '2026-08-07', kind: 'interval', endedAt: NOW + 300_000 }),
    completedRecord({ sessionId: 'session_filter_strength', planId: 'plan_filter_strength', trainingDate: '2026-08-07', kind: 'strength', endedAt: NOW + 400_000 })
  ];
  const { repository } = createHarness(records);
  const { list } = requireQueries(repository);

  assert.deepEqual(recordIds(list({ trainingDate: '2026-08-06' })), [
    'record_session_filter_timed',
    'record_session_filter_manual'
  ]);
  for (const kind of ['manual', 'timed', 'interval', 'strength']) {
    const result = list({ kind });
    assert.equal(result.length, 1);
    assert.equal(result[0].planSnapshot.steps.some((step) => step.kind === kind), true);
  }
  assert.deepEqual(recordIds(list({ trainingDate: '2026-08-07', kind: 'interval' })), [
    'record_session_filter_interval'
  ]);
  assert.deepEqual(list({ trainingDate: '2099-01-01' }), []);
  assert.deepEqual(list({ trainingDate: '2026-08-06', kind: 'strength' }), []);
});

test('Attack Round 4: list and findById share effective corrections while aborted skipped and unknown actuals remain honest', () => {
  const manual = completedRecord({
    sessionId: 'session_effective_manual',
    planId: 'plan_effective_manual',
    trainingDate: '2026-08-08',
    kind: 'manual',
    endedAt: NOW + 500_000
  });
  const aborted = abortedMixedRecord({
    sessionId: 'session_effective_aborted',
    trainingDate: '2026-08-09',
    endedAt: NOW + 600_000
  });
  const { repository } = createHarness([manual, aborted]);
  repository.correct(correctionCommand(manual, [{
    stepId: manual.planSnapshot.steps[0].id,
    actualReps: 16
  }]));
  const { list, findById } = requireQueries(repository);

  const correctedFromList = list({ trainingDate: manual.trainingDate })[0];
  const correctedFromFind = findById(manual.id);
  assert.deepEqual(correctedFromFind, correctedFromList);
  assert.notEqual(correctedFromFind, correctedFromList);
  assert.equal(correctedFromFind.stepResults[0].status, 'completed');
  assert.equal(correctedFromFind.stepResults[0].actualReps, 16);

  const abortedEffective = findById(aborted.id);
  assert.deepEqual(
    abortedEffective.stepResults.map(({ status }) => status),
    ['completed', 'skipped', 'unknown', 'unknown']
  );
  assert.equal(abortedEffective.stepResults[0].actualReps, null);
  assert.equal(abortedEffective.stepResults[1].actualDurationSeconds, null);
  assert.equal(abortedEffective.stepResults[2].actualDurationSeconds, null);
  assert.notEqual(
    abortedEffective.stepResults[2].actualDurationSeconds,
    aborted.planSnapshot.steps[2].durationSeconds
  );
  assert.deepEqual(abortedEffective.stepResults[3].setResults, []);
  assert.equal(findById('record_missing_query'), null);
});

test('Attack Round 4: tombstones disappear from normal list and find queries while durable identity remains reserved', () => {
  const deletedCandidate = completedRecord({
    sessionId: 'session_query_deleted',
    planId: 'plan_query_deleted',
    trainingDate: '2026-08-10',
    kind: 'manual',
    endedAt: NOW + 700_000
  });
  const survivor = completedRecord({
    sessionId: 'session_query_survivor',
    planId: 'plan_query_survivor',
    trainingDate: '2026-08-11',
    kind: 'timed',
    endedAt: NOW + 800_000
  });
  const { database, repository } = createHarness([deletedCandidate, survivor]);
  const { list, findById } = requireQueries(repository);

  assert.deepEqual(recordIds(list()), [survivor.id, deletedCandidate.id]);
  assert.equal(findById(deletedCandidate.id).id, deletedCandidate.id);
  repository.delete({
    recordId: deletedCandidate.id,
    expectedRevision: deletedCandidate.revision,
    commandKey: 'delete_query_candidate',
    nowMs: DELETE_AT
  });

  assert.deepEqual(recordIds(list()), [survivor.id]);
  assert.equal(findById(deletedCandidate.id), null);
  const durableMatches = findTrainingRecords(database.load().records, deletedCandidate.sourceSessionId);
  assert.equal(durableMatches.length, 1);
  assert.equal(isDeletedTrainingRecord(durableMatches[0]), true);
});

test('Attack Round 4: every query validates the whole record set and rejects malformed records or non-inert filter input before filtering', () => {
  const clean = completedRecord({
    sessionId: 'session_query_clean',
    planId: 'plan_query_clean',
    trainingDate: '2026-08-12',
    kind: 'manual',
    endedAt: NOW + 900_000
  });
  const corruptBase = completedRecord({
    sessionId: 'session_query_corrupt',
    planId: 'plan_query_corrupt',
    trainingDate: '2026-08-13',
    kind: 'timed',
    endedAt: NOW + 1_000_000
  });
  const corruptions = [
    (draft) => { draft.records.push(clone(draft.records[1])); },
    (draft) => { draft.records[1].id = clean.id; },
    (draft) => { draft.records[1].sourceSessionId = clean.sourceSessionId; },
    (draft) => { draft.records[1].unknownQueryField = 'forged'; },
    (draft) => { draft.records[1].sourceSessionFingerprint = '0'.repeat(64); },
    (draft) => {
      draft.records[1].actualCorrections = [{
        stepId: draft.records[1].planSnapshot.steps[0].id,
        actualDurationSeconds: 12
      }];
      draft.records[1].processedCorrectionCommands = [{
        key: 'malformed-query-receipt',
        fingerprint: 'not-a-digest',
        resultRevision: draft.records[1].revision
      }];
    },
    (draft) => {
      const record = draft.records[1];
      record.revision = 2;
      record.updatedAt += 1;
      record.actualCorrections = [{
        stepId: record.planSnapshot.steps[0].id,
        actualDurationSeconds: -1
      }];
      record.processedCorrectionCommands = [{
        key: 'query-invalid-overlay-with-valid-receipt',
        fingerprint: 'a'.repeat(64),
        resultRevision: 2
      }];
    },
    (draft) => {
      draft.records[1].feedback = {
        rpe: 999,
        weightBeforeKg: null,
        pain: {
          knee: false,
          lowerBack: false,
          ankleOrToe: false,
          dizziness: false
        },
        note: ''
      };
    }
  ];

  for (const corrupt of corruptions) {
    const { database, repository } = createHarness([clean, corruptBase]);
    const { list, findById } = requireQueries(repository);
    database.commit(corrupt);
    const before = snapshotBytes(database);
    assert.throws(
      () => list({ trainingDate: '2099-01-01' }),
      undefined,
      'corrupt records must not be disguised as an empty filtered result'
    );
    assert.throws(() => findById(clean.id));
    assert.equal(snapshotBytes(database), before);
  }

  const { repository } = createHarness([clean]);
  const { list, findById } = requireQueries(repository);
  const invalidQueries = [
    null,
    { trainingDate: '2026/08/12' },
    { trainingDate: '2026-02-30' },
    { kind: 'rest_day' },
    { kind: 'cardio' },
    { trainingDate: null, kind: null, status: 'completed' },
    Object.assign(Object.create({ inherited: true }), { trainingDate: null, kind: null })
  ];
  for (const query of invalidQueries) {
    assert.throws(() => list(query));
  }

  let getterRead = false;
  const accessorQuery = { kind: null };
  Object.defineProperty(accessorQuery, 'trainingDate', {
    enumerable: true,
    get() {
      getterRead = true;
      return '2026-08-12';
    }
  });
  assert.throws(() => list(accessorQuery));
  assert.equal(getterRead, false, 'query validation must reject accessors without executing them');

  for (const recordId of ['', 'session_query_clean', null, {}, -1]) {
    assert.throws(() => findById(recordId));
  }
});
