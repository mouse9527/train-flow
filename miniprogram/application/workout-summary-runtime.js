const {
  buildWorkoutCompletionSummary,
  createWorkoutFeedbackDraft,
  normalizeWorkoutFeedback
} = require('./workout-application-service');
const {
  findTrainingRecords,
  isPlainObject,
  recordMatchesTerminalSource,
  terminalFactFingerprint,
  terminalSourceFromRecord
} = require('../domain/execution/training-record');
const {
  isDeletedTrainingRecord
} = require('../domain/records/training-record');
const {
  createTrainingRecordRepository
} = require('../domain/records/training-record-repository');
const { createLocalDatabase } = require('../services/local-database');
const { canonicalize } = require('../utils/checksum');

const STORED_FEEDBACK_FIELDS = Object.freeze([
  'rpe',
  'weightBeforeKg',
  'pain',
  'note'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function recordMatchesTerminalFact(record, source, { requireFingerprint = false } = {}) {
  if (!recordMatchesTerminalSource(record, source)) {
    return false;
  }
  if (record.feedback !== null && !canonicalStoredFeedback(record.feedback)) {
    return false;
  }
  const hasFingerprint = Object.prototype.hasOwnProperty.call(
    record,
    'sourceSessionFingerprint'
  );
  return (!requireFingerprint || hasFingerprint) &&
    (!hasFingerprint || record.sourceSessionFingerprint === terminalFactFingerprint(source));
}

function findBoundRecord(records, source, options) {
  const candidates = findTrainingRecords(records, source.id);
  if (candidates.length === 0) {
    return null;
  }
  if (
    candidates.length !== 1 ||
    isDeletedTrainingRecord(candidates[0]) ||
    !recordMatchesTerminalFact(candidates[0], source, options)
  ) {
    throw new Error('训练记录与当前总结不匹配，请重新打开后再试');
  }
  return candidates[0];
}

function requireRequestedSessionId(input) {
  if (
    !isPlainObject(input) ||
    typeof input.sessionId !== 'string' ||
    input.sessionId.length === 0
  ) {
    throw new Error('sessionId is required for workout summary');
  }
  return input.sessionId;
}

function resolveSummarySource(snapshot, sessionId) {
  const active = snapshot.activeSession;
  if (
    active &&
    active.id === sessionId &&
    ['completed', 'aborted'].includes(active.status)
  ) {
    return {
      source: active,
      record: findBoundRecord(snapshot.records, active)
    };
  }

  const candidates = findTrainingRecords(snapshot.records, sessionId);
  if (candidates.length === 0) {
    throw new Error('找不到指定训练的总结记录');
  }
  if (candidates.length !== 1) {
    throw new Error('指定训练存在冲突的总结记录');
  }
  const record = candidates[0];
  if (isDeletedTrainingRecord(record)) {
    throw new Error('指定训练的总结记录已删除');
  }
  let source;
  try {
    source = terminalSourceFromRecord(record);
  } catch (_error) {
    throw new Error('指定训练的总结记录已损坏');
  }
  if (!recordMatchesTerminalFact(record, source, { requireFingerprint: true })) {
    throw new Error('指定训练的总结记录已损坏或不匹配');
  }
  return { source, record };
}

class WorkoutSummaryRuntime {
  constructor({
    database = createLocalDatabase(),
    recordRepository = null,
    now = Date.now
  } = {}) {
    this.database = database;
    this.recordRepository = recordRepository || createTrainingRecordRepository({ database });
    this.now = now;
    this.boundSessionId = null;
    this.sessionFingerprint = null;
  }

  load(input) {
    const sessionId = requireRequestedSessionId(input);
    const snapshot = this.database.load();
    const { source, record } = resolveSummarySource(snapshot, sessionId);
    this.boundSessionId = sessionId;
    this.sessionFingerprint = terminalFactFingerprint(source);
    return {
      summary: buildWorkoutCompletionSummary(source),
      feedback: record && record.feedback !== null
        ? normalizeWorkoutFeedback(record.feedback)
        : createWorkoutFeedbackDraft(),
      saved: Boolean(record && record.feedback !== null)
    };
  }

  saveFeedback(input) {
    const feedback = normalizeWorkoutFeedback(input);
    if (!this.boundSessionId || !this.sessionFingerprint) {
      throw new Error('训练总结尚未绑定 sessionId，请重新打开后再保存反馈');
    }
    const snapshot = this.database.load();
    let resolved;
    try {
      resolved = resolveSummarySource(snapshot, this.boundSessionId);
    } catch (_error) {
      throw new Error('训练总结已过期，请重新打开后再保存反馈');
    }
    const { source, record: existing } = resolved;
    if (terminalFactFingerprint(source) !== this.sessionFingerprint) {
      throw new Error('训练总结已过期，请重新打开后再保存反馈');
    }
    const savedAt = Math.max(this.now(), existing ? existing.updatedAt : 0);
    const storedFeedback = {
      rpe: feedback.rpe,
      weightBeforeKg: feedback.weightBeforeKg,
      pain: feedback.pain,
      note: feedback.note
    };
    let record;
    try {
      record = this.recordRepository.correct({
        recordId: existing ? existing.id : `record_${source.id}`,
        expectedRevision: existing ? existing.revision : 0,
        commandKey: JSON.stringify([
          'workout-summary-feedback',
          source.id,
          existing ? existing.revision : 0,
          savedAt
        ]),
        nowMs: savedAt,
        actualCorrections: existing && existing.actualCorrections
          ? clone(existing.actualCorrections)
          : [],
        feedback: storedFeedback
      }, { source });
    } catch (_error) {
      throw new Error('训练记录已变化，请重新打开后再保存反馈');
    }
    return {
      saved: true,
      fact: clone(record)
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
