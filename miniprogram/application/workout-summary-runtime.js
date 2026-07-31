const {
  buildWorkoutCompletionSummary,
  createWorkoutCompletionFact,
  createWorkoutFeedbackDraft,
  normalizeWorkoutFeedback
} = require('./workout-application-service');
const { createLocalDatabase } = require('../services/local-database');
const { canonicalize, computeChecksum } = require('../utils/checksum');

const TERMINAL_RECORD_FACT_FIELDS = Object.freeze([
  'schemaVersion',
  'occurrenceId',
  'eventType',
  'sourceSessionId',
  'status',
  'trainingDate',
  'startedAt',
  'endedAt',
  'elapsedActiveSeconds',
  'completedStepCount',
  'skippedStepCount',
  'totalStepCount',
  'planSnapshot',
  'stepResults'
]);
const STORED_FEEDBACK_FIELDS = Object.freeze([
  'rpe',
  'weightBeforeKg',
  'pain',
  'note'
]);
const TERMINAL_RECORD_FIELDS = new Set([
  ...TERMINAL_RECORD_FACT_FIELDS,
  'feedback',
  'sourceSessionFingerprint',
  'id',
  'createdAt',
  'updatedAt',
  'revision'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function terminalFactFingerprint(source) {
  return computeChecksum({
    sourceSessionId: source.sourceSessionId === undefined ? source.id : source.sourceSessionId,
    planSnapshot: source.planSnapshot,
    trainingDate: source.trainingDate,
    status: source.status,
    startedAt: source.startedAt,
    endedAt: source.endedAt,
    elapsedActiveSeconds: source.elapsedActiveSeconds,
    stepResults: source.stepResults
  });
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactFields(value, fields) {
  return isPlainObject(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function canonicalStoredFeedback(feedback) {
  if (!hasExactFields(feedback, STORED_FEEDBACK_FIELDS)) {
    return false;
  }
  try {
    const normalized = normalizeWorkoutFeedback(feedback);
    return STORED_FEEDBACK_FIELDS.every(
      (field) => canonicalize(feedback[field]) === canonicalize(normalized[field])
    );
  } catch (_error) {
    return false;
  }
}

function recordMetadataMatches(record, session) {
  return record.id === `record_${session.id}` &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0 &&
    Number.isSafeInteger(record.updatedAt) &&
    record.updatedAt >= 0 &&
    record.updatedAt >= record.createdAt &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 1;
}

function recordMatchesTerminalFact(record, session, fingerprint) {
  if (
    !isPlainObject(record) ||
    Object.keys(record).some((field) => !TERMINAL_RECORD_FIELDS.has(field)) ||
    TERMINAL_RECORD_FACT_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(record, field)
    ) ||
    !Object.prototype.hasOwnProperty.call(record, 'feedback') ||
    !Object.prototype.hasOwnProperty.call(record, 'id') ||
    !Object.prototype.hasOwnProperty.call(record, 'createdAt') ||
    !Object.prototype.hasOwnProperty.call(record, 'updatedAt') ||
    !Object.prototype.hasOwnProperty.call(record, 'revision') ||
    !recordMetadataMatches(record, session) ||
    !canonicalStoredFeedback(record.feedback)
  ) {
    return false;
  }

  const expectedFact = createWorkoutCompletionFact(session, {
    rpe: 1,
    weightBeforeKg: null,
    pain: {},
    note: ''
  });
  if (TERMINAL_RECORD_FACT_FIELDS.some(
    (field) => canonicalize(record[field]) !== canonicalize(expectedFact[field])
  )) {
    return false;
  }

  const derivedFingerprint = terminalFactFingerprint(record);
  if (
    Object.prototype.hasOwnProperty.call(record, 'sourceSessionFingerprint') &&
    record.sourceSessionFingerprint !== derivedFingerprint
  ) {
    return false;
  }
  return derivedFingerprint === fingerprint;
}

function findBoundRecord(records, session, fingerprint) {
  const canonicalRecordId = `record_${session.id}`;
  const candidates = records.filter(
    (record) => record && (
      record.sourceSessionId === session.id || record.id === canonicalRecordId
    )
  );
  if (candidates.length === 0) {
    return null;
  }
  if (
    candidates.length !== 1 ||
    !recordMatchesTerminalFact(candidates[0], session, fingerprint)
  ) {
    throw new Error('训练记录与当前总结不匹配，请重新打开后再试');
  }
  return candidates[0];
}

class WorkoutSummaryRuntime {
  constructor({ database = createLocalDatabase(), now = Date.now } = {}) {
    this.database = database;
    this.now = now;
    this.sessionFingerprint = null;
  }

  load() {
    const snapshot = this.database.load();
    const session = snapshot.activeSession;
    if (!session || !['completed', 'aborted'].includes(session.status)) {
      throw new Error('没有可总结的已结束训练');
    }
    this.sessionFingerprint = terminalFactFingerprint(session);
    const existing = findBoundRecord(snapshot.records, session, this.sessionFingerprint);
    return {
      summary: buildWorkoutCompletionSummary(session),
      feedback: existing
        ? normalizeWorkoutFeedback(existing.feedback)
        : createWorkoutFeedbackDraft(),
      saved: Boolean(existing)
    };
  }

  saveFeedback(input) {
    const feedback = normalizeWorkoutFeedback(input);
    const snapshot = this.database.load();
    const session = snapshot.activeSession;
    if (!session || !['completed', 'aborted'].includes(session.status)) {
      throw new Error('训练尚未结束，不能保存总结反馈');
    }
    if (
      this.sessionFingerprint &&
      terminalFactFingerprint(session) !== this.sessionFingerprint
    ) {
      throw new Error('训练总结已过期，请重新打开后再保存反馈');
    }
    const fact = createWorkoutCompletionFact(session, feedback);
    const sessionFingerprint = terminalFactFingerprint(session);
    const savedAt = this.now();
    const existing = findBoundRecord(snapshot.records, session, sessionFingerprint);
    const record = {
      ...fact,
      sourceSessionFingerprint: sessionFingerprint,
      id: existing ? existing.id : `record_${session.id}`,
      createdAt: existing ? existing.createdAt : savedAt,
      updatedAt: savedAt,
      revision: existing ? existing.revision + 1 : 1
    };
    if (!recordMatchesTerminalFact(record, session, sessionFingerprint)) {
      throw new Error('训练记录生成失败，请重新打开后再保存反馈');
    }
    const committed = this.database.commit((draft) => {
      if (existing === null) {
        draft.records.push(clone(record));
      } else {
        const index = draft.records.findIndex(
          (candidate) => candidate && candidate.id === existing.id
        );
        if (index === -1) {
          throw new Error('训练记录已变化，请重新打开后再保存反馈');
        }
        draft.records[index] = clone(record);
      }
    }, snapshot.localRevision);
    return {
      saved: true,
      fact: clone(committed.records.find(
        (candidate) => candidate && candidate.id === record.id
      ))
    };
  }
}

function createWorkoutSummaryRuntime(options) {
  return new WorkoutSummaryRuntime(options);
}

function createDeveloperWorkoutSummaryRuntime({ status = 'completed' } = {}) {
  const summary = {
    sessionId: `session_fixture_${status}`,
    status: status === 'aborted' ? 'aborted' : 'completed',
    trainingDate: '2026-08-03',
    planTitle: '周一全身训练',
    elapsedActiveSeconds: status === 'aborted' ? 925 : 2040,
    elapsedLabel: status === 'aborted' ? '15:25' : '34:00',
    completedStepCount: status === 'aborted' ? 3 : 7,
    skippedStepCount: status === 'aborted' ? 1 : 0,
    totalStepCount: 7,
    endedAt: 1785719340000
  };
  let feedback = normalizeWorkoutFeedback(
    status === 'aborted'
      ? { rpe: 8, pain: { dizziness: true } }
      : { rpe: 5 }
  );
  return {
    load() {
      return { summary: clone(summary), feedback: clone(feedback), saved: false };
    },
    saveFeedback(input) {
      feedback = normalizeWorkoutFeedback(input);
      return { saved: true, fact: { ...clone(summary), feedback: clone(feedback) } };
    }
  };
}

module.exports = {
  WorkoutSummaryRuntime,
  createDeveloperWorkoutSummaryRuntime,
  createWorkoutSummaryRuntime
};
