const {
  buildWorkoutCompletionSummary,
  createWorkoutCompletionFact,
  normalizeWorkoutFeedback
} = require('./workout-application-service');
const { createLocalDatabase } = require('../services/local-database');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class WorkoutSummaryRuntime {
  constructor({ database = createLocalDatabase(), now = Date.now } = {}) {
    this.database = database;
    this.now = now;
    this.session = null;
  }

  load() {
    const snapshot = this.database.load();
    const session = snapshot.activeSession;
    if (!session || !['completed', 'aborted'].includes(session.status)) {
      throw new Error('没有可总结的已结束训练');
    }
    this.session = clone(session);
    const existing = snapshot.records.find(({ sourceSessionId }) => sourceSessionId === session.id);
    return {
      summary: buildWorkoutCompletionSummary(session),
      feedback: existing ? clone(existing.feedback) : normalizeWorkoutFeedback({}),
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
    const fact = createWorkoutCompletionFact(session, feedback);
    const savedAt = this.now();
    const existingIndex = snapshot.records.findIndex(
      ({ sourceSessionId }) => sourceSessionId === session.id
    );
    const existing = existingIndex === -1 ? null : snapshot.records[existingIndex];
    const record = {
      ...fact,
      id: existing ? existing.id : `record_${session.id}`,
      createdAt: existing ? existing.createdAt : savedAt,
      updatedAt: savedAt,
      revision: existing ? existing.revision + 1 : 1
    };
    const committed = this.database.commit((draft) => {
      const index = draft.records.findIndex(
        ({ sourceSessionId }) => sourceSessionId === session.id
      );
      if (index === -1) {
        draft.records.push(clone(record));
      } else {
        draft.records[index] = clone(record);
      }
    }, snapshot.localRevision);
    return {
      saved: true,
      fact: clone(committed.records.find(({ sourceSessionId }) => sourceSessionId === session.id))
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
