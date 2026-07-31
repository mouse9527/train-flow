const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyWorkoutCommand,
  createWorkoutSession
} = require('../../miniprogram/domain/execution/workout-session');
const {
  buildWorkoutCompletionSummary,
  createWorkoutCompletionFact,
  normalizeWorkoutFeedback
} = require('../../miniprogram/application/workout-application-service');
const {
  createWechatDeviceAdapter
} = require('../../miniprogram/services/wechat-device-adapter');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');

const START_AT = 1785717300000;

function manualPlan() {
  const plan = createDefaultPlans({ now: () => START_AT })[2];
  plan.id = 'plan_completion_manual';
  plan.steps = [{ ...plan.steps.find(({ kind }) => kind === 'manual'), order: 1 }];
  return plan;
}

function startedSession(id) {
  return createWorkoutSession({
    plan: manualPlan(),
    sessionId: id,
    originDeviceId: 'device_completion',
    commandKey: `start_${id}`,
    nowMs: START_AT
  });
}

function completedSession() {
  const session = startedSession('session_completed');
  return applyWorkoutCommand(session, {
    type: 'complete_step',
    expectedSessionRevision: session.sessionRevision,
    commandKey: 'complete_manual',
    nowMs: START_AT + 125_000,
    payload: { stepId: session.planSnapshot.steps[0].id }
  }).session;
}

function abortedSession() {
  const session = startedSession('session_aborted');
  return applyWorkoutCommand(session, {
    type: 'abort',
    expectedSessionRevision: session.sessionRevision,
    commandKey: 'abort_manual',
    nowMs: START_AT + 65_000,
    payload: { reason: 'user-ended-workout' }
  }).session;
}

test('completed and aborted summaries preserve honest status, active duration and step counts', () => {
  const completed = buildWorkoutCompletionSummary(completedSession());
  assert.equal(completed.status, 'completed');
  assert.equal(completed.elapsedActiveSeconds, 125);
  assert.equal(completed.elapsedLabel, '02:05');
  assert.equal(completed.completedStepCount, 1);
  assert.equal(completed.skippedStepCount, 0);

  const aborted = buildWorkoutCompletionSummary(abortedSession());
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.elapsedActiveSeconds, 65);
  assert.equal(aborted.completedStepCount, 0);
  assert.equal(aborted.skippedStepCount, 0);
  assert.equal(aborted.totalStepCount, 1);
});

test('feedback accepts explicit nullable values and rejects out-of-range or unstructured health input', () => {
  assert.deepEqual(normalizeWorkoutFeedback({
    rpe: 7,
    weightBeforeKg: 62.5,
    pain: {
      knee: true,
      lowerBack: false,
      ankleOrToe: false,
      dizziness: true
    },
    note: '训练后感觉偏累'
  }), {
    rpe: 7,
    weightBeforeKg: 62.5,
    pain: {
      knee: true,
      lowerBack: false,
      ankleOrToe: false,
      dizziness: true
    },
    note: '训练后感觉偏累',
    hasSafetyAlarm: true,
    safetyAdvice: '请立即停止训练，并根据症状严重程度寻求专业医疗或紧急帮助。'
  });

  assert.throws(() => normalizeWorkoutFeedback({ rpe: 0 }), /RPE.*1.*10/i);
  assert.throws(() => normalizeWorkoutFeedback({ rpe: 11 }), /RPE.*1.*10/i);
  assert.throws(() => normalizeWorkoutFeedback({ weightBeforeKg: -1 }), /weight/i);
  assert.throws(() => normalizeWorkoutFeedback({ weightBeforeKg: 62.55 }), /weight/i);
  assert.throws(() => normalizeWorkoutFeedback({ pain: { customDiagnosis: true } }), /pain/i);
  assert.throws(() => normalizeWorkoutFeedback({ note: 'x'.repeat(501) }), /note/i);
});

test('completion facts distinguish event types, carry validated feedback and are stable by occurrence', () => {
  const feedback = normalizeWorkoutFeedback({ rpe: 5, pain: { knee: true } });
  const completed = createWorkoutCompletionFact(completedSession(), feedback);
  const aborted = createWorkoutCompletionFact(abortedSession(), feedback);

  assert.equal(completed.eventType, 'WorkoutSessionCompleted');
  assert.equal(completed.status, 'completed');
  assert.equal(aborted.eventType, 'WorkoutSessionAborted');
  assert.equal(aborted.status, 'aborted');
  assert.notEqual(completed.occurrenceId, aborted.occurrenceId);
  assert.deepEqual(completed.feedback, feedback);
  assert.throws(
    () => applyWorkoutCommand(completedSession(), {
      type: 'abort',
      expectedSessionRevision: 2,
      commandKey: 'late_abort',
      nowMs: START_AT + 130_000,
      payload: { reason: 'too-late' }
    }),
    (error) => error && error.code === 'SESSION_TERMINAL'
  );
});

test('device notifications honor settings, deduplicate occurrences and degrade to visual feedback', async () => {
  const calls = [];
  const adapter = createWechatDeviceAdapter({
    wxApi: {
      vibrateLong({ fail }) {
        calls.push('vibrate');
        fail(new Error('vibration unavailable'));
      },
      showToast({ title, success }) {
        calls.push(`visual:${title}`);
        success();
      }
    },
    audioService: {
      async play() {
        calls.push('sound');
        throw new Error('audio unavailable');
      },
      async speak() {
        calls.push('voice');
        return { supported: false };
      }
    },
    settings: {
      vibrationEnabled: true,
      soundEnabled: true,
      voiceEnabled: true,
      keepScreenOn: true
    }
  });

  const first = await adapter.notify({
    occurrenceId: 'session:completed:1',
    kind: 'session-completed',
    visualMessage: '训练完成',
    voiceText: '训练完成'
  });
  const duplicate = await adapter.notify({
    occurrenceId: 'session:completed:1',
    kind: 'session-completed',
    visualMessage: '训练完成',
    voiceText: '训练完成'
  });

  assert.equal(first.delivered, true);
  assert.equal(first.degraded, true);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(calls, ['vibrate', 'sound', 'voice', 'visual:训练完成']);
});

test('alarm pain selection returns stop-and-seek-help guidance without diagnosis', () => {
  const feedback = normalizeWorkoutFeedback({ pain: { dizziness: true } });
  assert.equal(feedback.hasSafetyAlarm, true);
  assert.match(feedback.safetyAdvice, /停止训练/);
  assert.match(feedback.safetyAdvice, /寻求.*帮助/);
  assert.doesNotMatch(feedback.safetyAdvice, /诊断|确诊|疾病/);
});
