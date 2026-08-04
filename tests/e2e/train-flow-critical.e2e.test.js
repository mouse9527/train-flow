const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FIXED_CLOCK,
  createAnonymousOfflineAdapter
} = require('../fixtures/anonymous/train-flow-critical');
const {
  createPlanApplicationService
} = require('../../miniprogram/application/plan-application-service');
const {
  createStatisticsApplicationService
} = require('../../miniprogram/application/statistics-application-service');
const {
  createWorkoutApplicationService
} = require('../../miniprogram/application/workout-application-service');
const {
  createPlanRepository
} = require('../../miniprogram/domain/planning/plan-repository');
const {
  createTrainingRecordRepository
} = require('../../miniprogram/domain/records/training-record-repository');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const {
  createLocalStatisticsService
} = require('../../miniprogram/services/statistics-service');

test('C1 anonymous offline first launch reaches one terminal record and weekly statistics', () => {
  const adapter = createAnonymousOfflineAdapter();
  const database = createLocalDatabase({ storage: adapter, now: () => FIXED_CLOCK.startAt });
  database.commit((draft) => {
    draft.install = { deviceId: 'anonymous_device_critical', createdAt: FIXED_CLOCK.startAt };
  });
  const planRepository = createPlanRepository({ database, now: () => FIXED_CLOCK.startAt });
  const planApplication = createPlanApplicationService({ repository: planRepository });
  const initialized = planApplication.initializeDefaultPlans();
  const sessionRepository = createSessionRepository({ database });
  const workout = createWorkoutApplicationService({
    planRepository,
    sessionRepository,
    deviceId: 'anonymous_device_critical',
    idFactory: () => 'session_critical_offline',
    now: () => FIXED_CLOCK.startAt
  });

  assert.equal(initialized.plans.length, 7);
  let session = workout.startSession({
    planId: 'plan_20260803_builtin',
    commandKey: 'critical:start-session',
    nowMs: FIXED_CLOCK.startAt
  });
  let nowMs = FIXED_CLOCK.startAt;
  let sequence = 0;
  const apply = (type, payload = {}, at = nowMs) => {
    const result = workout.execute({
      type,
      expectedSessionRevision: session.sessionRevision,
      commandKey: `critical:${++sequence}:${type}`,
      nowMs: at,
      payload
    });
    session = result.session;
    nowMs = at;
    return result;
  };

  while (!['completed', 'aborted'].includes(session.status)) {
    const step = session.planSnapshot.steps[session.currentStepIndex];
    if (step.kind === 'timed') {
      apply('start_step', { stepId: step.id });
      apply('checkpoint', { reason: 'hide' }, session.timer.expectedEndAt);
      apply('confirm_next', { stepId: step.id }, session.timer.expiredAt);
      continue;
    }
    if (step.kind === 'strength') {
      const stepIndex = session.currentStepIndex;
      while (
        !['completed', 'aborted'].includes(session.status) &&
        session.currentStepIndex === stepIndex
      ) {
        const setNumber = session.currentSet;
        apply('complete_set', {
          stepId: step.id,
          setNumber,
          reps: step.reps,
          weightKg: 0
        });
        if (session.timer && session.timer.mode === 'rest') {
          apply('checkpoint', { reason: 'hide' }, session.timer.expectedEndAt);
          apply('start_set', { stepId: step.id, setNumber: session.currentSet }, session.timer.expiredAt);
        }
      }
      continue;
    }
    throw new Error(`unexpected step kind ${step.kind}`);
  }

  const recordRepository = createTrainingRecordRepository({ database });
  const statistics = createStatisticsApplicationService({
    service: createLocalStatisticsService({
      database,
      recordRepository,
      planRepository,
      now: () => nowMs
    })
  }).getView('2026-08-03');

  assert.equal(session.status, 'completed');
  assert.equal(recordRepository.list().length, 1);
  assert.equal(statistics.week.completionCountLabel, '1 / 6 次');
  assert.notEqual(statistics.metrics.activeMinutes.valueLabel, '0');
  assert.equal(statistics.metrics.strengthCount.valueLabel, '3');
  assert.equal(adapter.networkAttempts(), 0);
});
