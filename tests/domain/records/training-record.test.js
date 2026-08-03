const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createBaselineTrainingRecord,
  ensureTerminalTrainingRecord,
  recordMatchesTerminalSource,
  terminalSourceFromRecord
} = require('../../../miniprogram/domain/execution/training-record');
const {
  applyWorkoutCommand,
  assertWorkoutSession,
  createWorkoutSession
} = require('../../../miniprogram/domain/execution/workout-session');
const {
  createDefaultPlans
} = require('../../../miniprogram/domain/planning/default-plan-factory');

const NOW = 1785717300000;
const CORRECTION_NOW = NOW + 900_000;
const SOURCE_FACT_FIELDS = Object.freeze([
  'sourceSessionId',
  'status',
  'trainingDate',
  'startedAt',
  'endedAt',
  'elapsedActiveSeconds',
  'planSnapshot',
  'stepResults',
  'sourceSessionFingerprint',
  'createdAt'
]);
const PAIN_FIELDS = Object.freeze(['knee', 'lowerBack', 'ankleOrToe', 'dizziness']);

let recordApi = {};
let recordApiLoadError = null;
try {
  recordApi = require('../../../miniprogram/domain/records/training-record');
} catch (error) {
  recordApiLoadError = error;
}

function clone(value) {
  return structuredClone(value);
}

function requireRecordApi(name) {
  assert.equal(
    typeof recordApi[name],
    'function',
    recordApiLoadError
      ? `TrainingRecord aggregate must export ${name}(): ${recordApiLoadError.message}`
      : `TrainingRecord aggregate must export ${name}()`
  );
  return recordApi[name];
}

function applyCorrection(record, command) {
  const result = requireRecordApi('applyTrainingRecordCorrection')(record, command);
  return result && result.record ? result.record : result;
}

function buildEffective(record) {
  return requireRecordApi('buildEffectiveTrainingRecord')(record);
}

function isDeleted(record) {
  return requireRecordApi('isDeletedTrainingRecord')(record);
}

function combinedPlan(id) {
  const defaults = createDefaultPlans({ now: () => NOW });
  const base = clone(defaults[0]);
  const sourceSteps = [
    defaults[2].steps.find(({ kind }) => kind === 'manual'),
    defaults[0].steps.find(({ kind }) => kind === 'timed'),
    defaults[3].steps.find(({ kind }) => kind === 'interval'),
    defaults[0].steps.find(({ kind }) => kind === 'strength')
  ];
  return {
    ...base,
    id,
    title: 'TrainingRecord adversarial canonical fixture',
    trainingDate: '2026-08-03',
    steps: sourceSteps.map((source, index) => ({
      ...clone(source),
      id: `${id}_${source.kind}`,
      order: (index + 1) * 10,
      ...(source.kind === 'interval' ? { sets: 1, restSeconds: 0 } : {}),
      ...(source.kind === 'strength' ? { sets: 1, restSeconds: 0 } : {})
    }))
  };
}

function command(type, session, commandKey, nowMs, payload = {}) {
  return {
    type,
    expectedSessionRevision: session.sessionRevision,
    commandKey,
    nowMs,
    payload
  };
}

function applySessionCommand(session, type, commandKey, nowMs, payload = {}) {
  return applyWorkoutCommand(
    session,
    command(type, session, commandKey, nowMs, payload)
  ).session;
}

function completedSession() {
  let session = createWorkoutSession({
    plan: combinedPlan('plan_record_completed'),
    sessionId: 'session_record_completed',
    originDeviceId: 'device_record_attack',
    commandKey: 'start_record_completed',
    nowMs: NOW
  });
  const [manual, timed, interval, strength] = session.planSnapshot.steps;
  session = applySessionCommand(
    session,
    'complete_step',
    'complete_manual',
    NOW + 1_000,
    { stepId: manual.id }
  );
  session = applySessionCommand(
    session,
    'start_step',
    'start_timed',
    NOW + 2_000,
    { stepId: timed.id }
  );
  session = applySessionCommand(
    session,
    'confirm_next',
    'complete_timed',
    session.timer.expectedEndAt,
    { stepId: timed.id }
  );
  session = applySessionCommand(
    session,
    'start_step',
    'start_interval',
    session.lastCheckpointAt + 1_000,
    { stepId: interval.id }
  );
  session = applySessionCommand(
    session,
    'confirm_next',
    'complete_interval',
    session.timer.expectedEndAt,
    { stepId: interval.id }
  );
  session = applySessionCommand(
    session,
    'complete_set',
    'complete_strength',
    session.lastCheckpointAt + 1_000,
    {
      stepId: strength.id,
      setNumber: 1,
      reps: 12,
      weightKg: 20
    }
  );
  assert.equal(session.status, 'completed');
  assert.equal(assertWorkoutSession(session), session);
  return session;
}

function abortedSession() {
  let session = createWorkoutSession({
    plan: combinedPlan('plan_record_aborted'),
    sessionId: 'session_record_aborted',
    originDeviceId: 'device_record_attack',
    commandKey: 'start_record_aborted',
    nowMs: NOW
  });
  const [manual, timed] = session.planSnapshot.steps;
  session = applySessionCommand(
    session,
    'complete_step',
    'aborted_complete_manual',
    NOW + 1_000,
    { stepId: manual.id }
  );
  session = applySessionCommand(
    session,
    'skip_step',
    'aborted_skip_timed',
    NOW + 2_000,
    { stepId: timed.id }
  );
  session = applySessionCommand(
    session,
    'abort',
    'abort_before_interval',
    NOW + 3_000,
    { reason: 'user-ended-workout' }
  );
  assert.equal(session.status, 'aborted');
  assert.equal(assertWorkoutSession(session), session);
  return session;
}

function baseline(status = 'completed') {
  return createBaselineTrainingRecord(
    status === 'completed' ? completedSession() : abortedSession()
  );
}

function feedback(overrides = {}) {
  return {
    rpe: 7,
    weightBeforeKg: null,
    pain: {
      knee: false,
      lowerBack: false,
      ankleOrToe: false,
      dizziness: false,
      ...(overrides.pain || {})
    },
    note: '',
    ...overrides,
    pain: {
      knee: false,
      lowerBack: false,
      ankleOrToe: false,
      dizziness: false,
      ...(overrides.pain || {})
    }
  };
}

function completedCorrections(record) {
  const [manual, timed, interval, strength] = record.planSnapshot.steps;
  return [
    { stepId: manual.id, actualReps: 14 },
    { stepId: timed.id, actualDurationSeconds: 240 },
    { stepId: interval.id, actualDurationSeconds: 55 },
    {
      stepId: strength.id,
      setCorrections: [{ setNumber: 1, reps: 10, weightKg: 22.5 }]
    }
  ];
}

function correctionCommand(record, overrides = {}) {
  return {
    expectedRevision: record.revision,
    commandKey: `correct_${record.sourceSessionId}`,
    nowMs: CORRECTION_NOW,
    actualCorrections: completedCorrections(record),
    feedback: feedback({ pain: { knee: true }, note: 'private correction note' }),
    ...overrides
  };
}

function factBytes(record) {
  return Object.fromEntries(
    SOURCE_FACT_FIELDS.map((field) => [field, JSON.stringify(record[field])])
  );
}

function assertFactBytesEqual(record, expected) {
  assert.deepEqual(factBytes(record), expected);
}

function assertRejectedWithoutRecordMutation(record, commandValue) {
  const applyTrainingRecordCorrection = requireRecordApi('applyTrainingRecordCorrection');
  const before = clone(record);
  assert.throws(() => applyTrainingRecordCorrection(record, commandValue));
  assert.deepEqual(record, before, 'rejected correction must leave its input byte-for-byte unchanged');
}

test('Attack Round 1: source terminal facts are immutable while corrections use a closed overlay and canonical feedback', () => {
  const record = baseline('completed');
  const before = clone(record);
  const beforeFacts = factBytes(record);
  const input = correctionCommand(record);
  const inputBefore = clone(input);

  const corrected = applyCorrection(record, input);

  assert.deepEqual(record, before, 'the canonical baseline input must not be mutated');
  assert.deepEqual(input, inputBefore, 'the correction command must not be mutated');
  assertFactBytesEqual(corrected, beforeFacts);
  assert.equal(corrected.revision, record.revision + 1);
  assert.equal(corrected.updatedAt, CORRECTION_NOW);
  assert.deepEqual(corrected.actualCorrections, input.actualCorrections);
  assert.deepEqual(corrected.feedback, {
    rpe: 7,
    weightBeforeKg: null,
    pain: {
      knee: true,
      lowerBack: false,
      ankleOrToe: false,
      dizziness: false
    },
    note: 'private correction note'
  });
  assert.equal(Object.hasOwn(corrected.feedback, 'hasSafetyAlarm'), false);
  assert.equal(Object.hasOwn(corrected.feedback, 'safetyAdvice'), false);
});

test('Reviewer regression: terminal-source matching rejects every malformed persisted strength set correction', () => {
  const session = completedSession();
  const baselineRecord = createBaselineTrainingRecord(session);
  const strength = baselineRecord.planSnapshot.steps.find(({ kind }) => kind === 'strength');
  const corrected = applyCorrection(baselineRecord, correctionCommand(baselineRecord, {
    actualCorrections: [{
      stepId: strength.id,
      setCorrections: [{ setNumber: 1, reps: 10, weightKg: 22.5 }]
    }]
  }));
  const source = terminalSourceFromRecord(corrected);
  assert.equal(recordMatchesTerminalSource(corrected, source), true);

  const malformedRecords = [
    (() => {
      const value = clone(corrected);
      value.actualCorrections[0].setCorrections[0].setNumber = 2;
      return value;
    })(),
    (() => {
      const value = clone(corrected);
      value.actualCorrections[0].setCorrections[0].reps = -1;
      return value;
    })(),
    (() => {
      const value = clone(corrected);
      value.actualCorrections[0].setCorrections[0].weightKg = 22.55;
      return value;
    })(),
    (() => {
      const value = clone(corrected);
      value.actualCorrections[0].setCorrections[0].completedAt = CORRECTION_NOW;
      return value;
    })(),
    (() => {
      const value = clone(corrected);
      value.actualCorrections[0].setCorrections.push(
        clone(value.actualCorrections[0].setCorrections[0])
      );
      return value;
    })()
  ];

  for (const malformed of malformedRecords) {
    assert.equal(recordMatchesTerminalSource(malformed, source), false);
    assert.throws(
      () => ensureTerminalTrainingRecord([malformed], session),
      /does not match its source/
    );
  }
});

test('Reviewer regression: terminal-source matching rejects tombstones with extra deletion receipts', () => {
  const session = completedSession();
  const record = createBaselineTrainingRecord(session);
  const deletedAt = record.updatedAt + 1_000;
  const malformed = {
    id: record.id,
    sourceSessionId: record.sourceSessionId,
    sourceSessionFingerprint: record.sourceSessionFingerprint,
    status: record.status,
    trainingDate: record.trainingDate,
    createdAt: record.createdAt,
    updatedAt: deletedAt,
    revision: 3,
    deletedAt,
    processedDeletionCommands: [
      { key: 'delete_once', fingerprint: 'a'.repeat(64), resultRevision: 2 },
      { key: 'delete_twice', fingerprint: 'b'.repeat(64), resultRevision: 3 }
    ]
  };

  assert.equal(recordMatchesTerminalSource(malformed, session), false);
  assert.throws(
    () => ensureTerminalTrainingRecord([malformed], session),
    /does not match its source/
  );
});

test('Attack Round 1: effective completed facts merge overlays without rewriting source results', () => {
  const source = baseline('completed');
  const corrected = applyCorrection(source, correctionCommand(source));
  const effective = buildEffective(corrected);
  const [manual, timed, interval, strength] = effective.stepResults;
  const sourceStrength = source.stepResults[3];

  assert.equal(effective.sourceSessionId, source.sourceSessionId);
  assert.equal(effective.status, 'completed');
  assert.deepEqual(
    effective.stepResults.map(({ status }) => status),
    ['completed', 'completed', 'completed', 'completed']
  );
  assert.equal(manual.actualReps, 14);
  assert.equal(timed.actualDurationSeconds, 240);
  assert.equal(interval.actualDurationSeconds, 55);
  assert.deepEqual(strength.setResults, [{
    ...sourceStrength.setResults[0],
    reps: 10,
    weightKg: 22.5
  }]);
  assert.deepEqual(source.stepResults[3], sourceStrength, 'effective merge must not rewrite source set facts');
});

test('Attack Round 1: aborted views keep skipped and never-started plan steps honest instead of copying plan targets', () => {
  const record = baseline('aborted');
  const manualStep = record.planSnapshot.steps[0];
  const corrected = applyCorrection(record, correctionCommand(record, {
    commandKey: 'correct_aborted_manual_only',
    actualCorrections: [{ stepId: manualStep.id, actualReps: 9 }],
    feedback: feedback({ rpe: 4 })
  }));
  const effective = buildEffective(corrected);
  const [manual, skippedTimed, unknownInterval, unknownStrength] = effective.stepResults;

  assert.equal(effective.status, 'aborted');
  assert.equal(manual.status, 'completed');
  assert.equal(manual.actualReps, 9);
  assert.equal(skippedTimed.status, 'skipped');
  assert.equal(skippedTimed.actualDurationSeconds, null);
  assert.equal(unknownInterval.status, 'unknown');
  assert.equal(unknownInterval.actualDurationSeconds, null);
  assert.notEqual(
    unknownInterval.actualDurationSeconds,
    record.planSnapshot.steps[2].durationSeconds,
    'an interval target is not an actual result'
  );
  assert.equal(unknownStrength.status, 'unknown');
  assert.deepEqual(unknownStrength.setResults, []);
  assert.equal(Object.hasOwn(unknownStrength, 'actualReps'), false);
  assert.notDeepEqual(
    unknownStrength.setResults,
    [{
      setNumber: 1,
      reps: record.planSnapshot.steps[3].reps,
      weightKg: record.planSnapshot.steps[3].weightKg ?? null
    }],
    'strength targets must not fabricate a set result for an unexecuted step'
  );
});

test('Attack Round 1: permitted nullable and numeric correction boundaries stay type-specific', () => {
  const record = baseline('completed');
  const [manual, timed, interval, strength] = record.planSnapshot.steps;
  const corrected = applyCorrection(record, correctionCommand(record, {
    commandKey: 'correct_valid_boundaries',
    actualCorrections: [
      { stepId: manual.id, actualReps: null },
      { stepId: timed.id, actualDurationSeconds: 0 },
      { stepId: interval.id, actualDurationSeconds: null },
      {
        stepId: strength.id,
        setCorrections: [{ setNumber: 1, reps: null, weightKg: null }]
      }
    ],
    feedback: feedback({ rpe: 1, weightBeforeKg: 0 })
  }));
  const effective = buildEffective(corrected);

  assert.equal(effective.stepResults[0].actualReps, null);
  assert.equal(effective.stepResults[1].actualDurationSeconds, 0);
  assert.equal(effective.stepResults[2].actualDurationSeconds, null);
  assert.equal(effective.stepResults[3].setResults[0].reps, null);
  assert.equal(effective.stepResults[3].setResults[0].weightKg, null);
  assert.equal(corrected.feedback.rpe, 1);
  assert.equal(corrected.feedback.weightBeforeKg, 0);
});

test('Attack Round 1: malicious correction structures and values cannot forge execution facts or expand the schema', () => {
  const completed = baseline('completed');
  const aborted = baseline('aborted');
  const [manual, timed, interval, strength] = completed.planSnapshot.steps;
  const skippedTimed = aborted.planSnapshot.steps[1];
  const unknownInterval = aborted.planSnapshot.steps[2];
  const invalidManualValues = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, -0, Infinity];
  const invalidDurationValues = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, -0, Infinity];
  const invalidWeightValues = [-1, 1.11, Number.MAX_SAFE_INTEGER + 1, Number.NaN, -0, Infinity];

  for (const actualReps of invalidManualValues) {
    assertRejectedWithoutRecordMutation(completed, correctionCommand(completed, {
      actualCorrections: [{ stepId: manual.id, actualReps }]
    }));
  }
  for (const durationStep of [timed, interval]) {
    for (const actualDurationSeconds of invalidDurationValues) {
      assertRejectedWithoutRecordMutation(completed, correctionCommand(completed, {
        actualCorrections: [{ stepId: durationStep.id, actualDurationSeconds }]
      }));
    }
  }
  for (const reps of invalidManualValues) {
    assertRejectedWithoutRecordMutation(completed, correctionCommand(completed, {
      actualCorrections: [{
        stepId: strength.id,
        setCorrections: [{ setNumber: 1, reps, weightKg: 20 }]
      }]
    }));
  }
  for (const weightKg of invalidWeightValues) {
    assertRejectedWithoutRecordMutation(completed, correctionCommand(completed, {
      actualCorrections: [{
        stepId: strength.id,
        setCorrections: [{ setNumber: 1, reps: 10, weightKg }]
      }]
    }));
  }

  const invalidCorrectionSets = [
    [{ stepId: skippedTimed.id, actualDurationSeconds: 10 }],
    [{ stepId: unknownInterval.id, actualDurationSeconds: 10 }],
    [{ stepId: strength.id, setCorrections: [{ setNumber: 2, reps: 10, weightKg: 20 }] }],
    [{ stepId: strength.id, setCorrections: [
      { setNumber: 1, reps: 10, weightKg: 20 },
      { setNumber: 1, reps: 11, weightKg: 21 }
    ] }],
    [{ stepId: manual.id, actualReps: 10 }, { stepId: manual.id, actualReps: 11 }],
    [{ stepId: 'unknown_step', actualReps: 10 }],
    [{ stepId: manual.id, actualDurationSeconds: 10 }],
    [{ stepId: timed.id, actualReps: 10 }],
    [{ stepId: interval.id, setCorrections: [] }],
    [{ stepId: strength.id, actualReps: 10 }],
    [{ stepId: manual.id, actualReps: 10, forgedActual: 99 }],
    [{ stepId: strength.id, setCorrections: [{
      setNumber: 1,
      reps: 10,
      weightKg: 20,
      completedAt: CORRECTION_NOW
    }] }]
  ];
  for (const actualCorrections of invalidCorrectionSets) {
    const target = actualCorrections[0].stepId.startsWith('plan_record_aborted')
      ? aborted
      : completed;
    assertRejectedWithoutRecordMutation(target, correctionCommand(target, { actualCorrections }));
  }

  const extraCommandField = correctionCommand(completed);
  extraCommandField.sourceSessionId = completed.sourceSessionId;
  assertRejectedWithoutRecordMutation(completed, extraCommandField);

  const customPrototypeCommand = Object.assign(
    Object.create({ inherited: 'forged' }),
    correctionCommand(completed)
  );
  assertRejectedWithoutRecordMutation(completed, customPrototypeCommand);

  const customPrototypeCorrection = Object.assign(
    Object.create({ inherited: 'forged' }),
    { stepId: manual.id, actualReps: 10 }
  );
  assertRejectedWithoutRecordMutation(completed, correctionCommand(completed, {
    actualCorrections: [customPrototypeCorrection]
  }));

  let accessorRead = false;
  const accessorCorrection = { stepId: manual.id };
  Object.defineProperty(accessorCorrection, 'actualReps', {
    enumerable: true,
    get() {
      accessorRead = true;
      return 10;
    }
  });
  assertRejectedWithoutRecordMutation(completed, correctionCommand(completed, {
    actualCorrections: [accessorCorrection]
  }));
  assert.equal(accessorRead, false, 'validation must reject accessors without executing them');
});

test('Attack Round 1: feedback enforces the existing private schema and strips derived safety advice', () => {
  const record = baseline('completed');
  const valid = applyCorrection(record, correctionCommand(record, {
    commandKey: 'correct_feedback_canonical',
    actualCorrections: [],
    feedback: {
      rpe: 10,
      weightBeforeKg: 72.5,
      pain: { dizziness: true },
      note: 'x'.repeat(500)
    }
  }));

  assert.deepEqual(valid.feedback, {
    rpe: 10,
    weightBeforeKg: 72.5,
    pain: {
      knee: false,
      lowerBack: false,
      ankleOrToe: false,
      dizziness: true
    },
    note: 'x'.repeat(500)
  });
  assert.deepEqual(Object.keys(valid.feedback).sort(), ['note', 'pain', 'rpe', 'weightBeforeKg']);
  assert.deepEqual(Object.keys(valid.feedback.pain), PAIN_FIELDS);

  const invalidFeedback = [
    {},
    { rpe: null },
    { rpe: 0 },
    { rpe: 11 },
    { rpe: 1.5 },
    { rpe: 5, weightBeforeKg: -1 },
    { rpe: 5, weightBeforeKg: 70.55 },
    { rpe: 5, weightBeforeKg: Number.NaN },
    { rpe: 5, weightBeforeKg: -0 },
    { rpe: 5, weightBeforeKg: Infinity },
    { rpe: 5, pain: { knee: 'yes' } },
    { rpe: 5, pain: { diagnosis: true } },
    { rpe: 5, note: 'x'.repeat(501) },
    { rpe: 5, hasSafetyAlarm: true },
    { rpe: 5, safetyAdvice: 'forged diagnosis' }
  ];
  for (const invalid of invalidFeedback) {
    assertRejectedWithoutRecordMutation(record, correctionCommand(record, {
      actualCorrections: [],
      feedback: invalid
    }));
  }
});

test('Attack Round 1: revision CAS and command keys reject stale or conflicting intent while exact replay is idempotent', () => {
  const record = baseline('completed');
  const input = correctionCommand(record, { commandKey: 'correction_idempotency_key' });
  const inputBefore = clone(input);
  const first = applyCorrection(record, input);
  const firstBeforeReplay = clone(first);
  const replay = applyCorrection(first, input);

  assert.equal(first.revision, record.revision + 1);
  assert.equal(replay.revision, first.revision);
  assert.deepEqual(replay, firstBeforeReplay, 'same key and same intent must replay the original result');
  assert.deepEqual(first, firstBeforeReplay, 'replay must not mutate the previously returned value');
  assert.deepEqual(input, inputBefore, 'idempotency checks must not mutate the command');
  assert.notEqual(first, record);
  assert.notEqual(replay, first);
  assert.notEqual(first.planSnapshot, record.planSnapshot);
  assert.notEqual(first.stepResults, record.stepResults);
  assert.notEqual(first.feedback, input.feedback);
  assert.notEqual(first.actualCorrections, input.actualCorrections);

  assertRejectedWithoutRecordMutation(record, correctionCommand(record, {
    expectedRevision: record.revision - 1,
    commandKey: 'stale_correction'
  }));
  assertRejectedWithoutRecordMutation(first, {
    ...input,
    actualCorrections: [{
      stepId: first.planSnapshot.steps[0].id,
      actualReps: 99
    }]
  });

  const effectiveBeforeMutation = buildEffective(first);
  const effectiveSnapshot = clone(effectiveBeforeMutation);
  effectiveBeforeMutation.planSnapshot.title = 'mutated returned view';
  effectiveBeforeMutation.stepResults[0].actualReps = 999;
  const effectiveAgain = buildEffective(first);
  assert.deepEqual(effectiveAgain, effectiveSnapshot, 'effective view must be rebuilt as a deep copy');

  replay.planSnapshot.title = 'mutated replay';
  replay.actualCorrections[0].actualReps = 123;
  assert.deepEqual(first, firstBeforeReplay, 'mutating a replay result must not alias prior state');
});

test('Attack Round 1: completed and aborted records share correction semantics without changing terminal identity', () => {
  for (const status of ['completed', 'aborted']) {
    const record = baseline(status);
    const manual = record.planSnapshot.steps[0];
    const beforeFacts = factBytes(record);
    const corrected = applyCorrection(record, correctionCommand(record, {
      commandKey: `symmetric_${status}`,
      actualCorrections: [{ stepId: manual.id, actualReps: 8 }],
      feedback: feedback({ rpe: 6 })
    }));
    const effective = buildEffective(corrected);

    assert.equal(corrected.status, status);
    assert.equal(effective.status, status);
    assert.equal(effective.stepResults[0].status, 'completed');
    assert.equal(effective.stepResults[0].actualReps, 8);
    assertFactBytesEqual(corrected, beforeFacts);
    assert.equal(isDeleted(record), false);
    assert.equal(isDeleted(corrected), false);
  }
});

test('Attack Round 5: a late exact replay of historical correction A returns current correction B state before stale revision or time checks', () => {
  const source = baseline('completed');
  const manualStepId = source.planSnapshot.steps[0].id;
  const commandA = correctionCommand(source, {
    commandKey: 'historical_correction_a'
  });
  const afterA = applyCorrection(source, commandA);
  const commandB = correctionCommand(afterA, {
    expectedRevision: afterA.revision,
    commandKey: 'newer_correction_b',
    nowMs: CORRECTION_NOW + 1_000,
    actualCorrections: [{ stepId: manualStepId, actualReps: 19 }],
    feedback: feedback({ rpe: 9, note: 'newer B state' })
  });
  const afterB = applyCorrection(afterA, commandB);
  const currentBeforeReplay = clone(afterB);
  const commandABeforeReplay = clone(commandA);

  const lateReplay = applyCorrection(afterB, commandA);

  assert.equal(afterB.revision, 3);
  assert.equal(lateReplay.revision, afterB.revision);
  assert.equal(lateReplay.actualCorrections[0].actualReps, 19);
  assert.equal(lateReplay.feedback.note, 'newer B state');
  assert.deepEqual(lateReplay, currentBeforeReplay);
  assert.notEqual(lateReplay, afterB);
  assert.notEqual(lateReplay.feedback, afterB.feedback);
  assert.notEqual(lateReplay.actualCorrections, afterB.actualCorrections);
  assert.deepEqual(afterB, currentBeforeReplay, 'late replay must not mutate current B state');
  assert.deepEqual(commandA, commandABeforeReplay, 'late replay must not mutate old command A');
});

test('Attack Round 5: historical command keys reject any changed intent field while leaving current state untouched', () => {
  const source = baseline('completed');
  const manualStepId = source.planSnapshot.steps[0].id;
  const commandA = correctionCommand(source, {
    commandKey: 'historical_intent_key'
  });
  const afterA = applyCorrection(source, commandA);
  const afterB = applyCorrection(afterA, correctionCommand(afterA, {
    expectedRevision: afterA.revision,
    commandKey: 'historical_intent_newer_b',
    nowMs: commandA.nowMs,
    actualCorrections: [{ stepId: manualStepId, actualReps: 18 }],
    feedback: feedback({ rpe: 6, note: 'current B intent' })
  }));
  const current = clone(afterB);
  const variants = [
    {
      ...clone(commandA),
      actualCorrections: [{ stepId: manualStepId, actualReps: 20 }]
    },
    {
      ...clone(commandA),
      feedback: feedback({ rpe: 4, note: 'changed feedback intent' })
    },
    {
      ...clone(commandA),
      nowMs: commandA.nowMs + 1
    },
    {
      ...clone(commandA),
      expectedRevision: commandA.expectedRevision + 1
    }
  ];

  for (const changedIntent of variants) {
    const commandBefore = clone(changedIntent);
    assert.throws(() => applyCorrection(afterB, changedIntent));
    assert.deepEqual(afterB, current);
    assert.deepEqual(changedIntent, commandBefore);
  }
});
