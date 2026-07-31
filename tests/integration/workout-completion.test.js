const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

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
  createTimedWorkoutRuntime
} = require('../../miniprogram/application/timed-workout-runtime');
const {
  createWorkoutSummaryRuntime
} = require('../../miniprogram/application/workout-summary-runtime');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785717300000;

function manualPlan() {
  const plan = createDefaultPlans({ now: () => START_AT })[2];
  plan.id = 'plan_completion_manual';
  plan.trainingDate = '2026-08-10';
  plan.templateSource = null;
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
  assert.deepEqual(completed.feedback, {
    rpe: feedback.rpe,
    weightBeforeKg: feedback.weightBeforeKg,
    pain: feedback.pain,
    note: feedback.note
  });
  assert.equal(Object.hasOwn(completed.feedback, 'safetyAdvice'), false);
  assert.equal(Object.hasOwn(completed.feedback, 'hasSafetyAlarm'), false);
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

function createRuntimeHarness({ keepScreenOn = true } = {}) {
  let clock = START_AT;
  let sequence = 0;
  const deviceCalls = [];
  const database = createLocalDatabase({ storage: new StorageDouble(), now: () => clock });
  const plan = manualPlan();
  database.commit((draft) => {
    draft.install = { deviceId: 'device_completion_runtime', createdAt: START_AT };
    draft.settings.keepScreenOn = keepScreenOn;
    draft.plans.push(clone(plan));
  });
  const runtime = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_completion_runtime',
    commandKeyFactory: (type) => `completion_${type}_${++sequence}`,
    deviceAdapterFactory(settings) {
      assert.equal(settings.keepScreenOn, keepScreenOn);
      return {
        setKeepScreen(enabled) {
          deviceCalls.push(['screen', enabled]);
          return Promise.resolve({ supported: true });
        },
        notify(input) {
          deviceCalls.push(['notify', input]);
          return Promise.resolve({ delivered: true, degraded: false });
        }
      };
    }
  });
  return {
    database,
    deviceCalls,
    plan,
    runtime,
    setNow(value) { clock = value; }
  };
}

test('runtime honors keep-screen settings and releases on hide, terminal completion and unload', async () => {
  const harness = createRuntimeHarness();
  const loaded = harness.runtime.load({ planId: harness.plan.id });
  assert.notEqual(loaded.state, 'recovery-error', loaded.recoveryError && loaded.recoveryError.message);
  await Promise.resolve();
  assert.deepEqual(harness.deviceCalls[0], ['screen', true]);

  harness.runtime.onHide();
  harness.runtime.onShow();
  harness.setNow(START_AT + 90_000);
  harness.runtime.completeManual();
  harness.runtime.onUnload();
  await Promise.resolve();

  assert.deepEqual(
    harness.deviceCalls.filter(([kind]) => kind === 'screen').map(([, enabled]) => enabled),
    [true, false, true, false, false]
  );
  const terminalNotifications = harness.deviceCalls.filter(
    ([kind, input]) => kind === 'notify' && input.kind === 'session-completed'
  );
  assert.equal(terminalNotifications.length, 1);
  const rebuiltCalls = [];
  const rebuilt = createTimedWorkoutRuntime({
    database: harness.database,
    now: () => START_AT + 90_000,
    idFactory: () => 'must_not_replace_terminal_session',
    commandKeyFactory: (type) => `rebuilt_${type}`,
    deviceAdapterFactory() {
      return {
        setKeepScreen(enabled) {
          rebuiltCalls.push(['screen', enabled]);
          return Promise.resolve({ supported: true });
        },
        notify(input) {
          rebuiltCalls.push(['notify', input]);
          return Promise.resolve({ delivered: true });
        }
      };
    }
  });
  rebuilt.load({});
  await Promise.resolve();
  assert.equal(
    rebuiltCalls.some(([kind]) => kind === 'notify'),
    false,
    'terminal occurrence must remain deduplicated after runtime reconstruction'
  );

  const disabled = createRuntimeHarness({ keepScreenOn: false });
  disabled.runtime.load({ planId: disabled.plan.id });
  await Promise.resolve();
  assert.equal(disabled.deviceCalls.some(([kind, enabled]) => kind === 'screen' && enabled), false);
});

test('summary runtime atomically saves one private completion fact without writing feedback to console', () => {
  const harness = createRuntimeHarness();
  const loadedWorkout = harness.runtime.load({ planId: harness.plan.id });
  assert.notEqual(
    loadedWorkout.state,
    'recovery-error',
    loadedWorkout.recoveryError && loadedWorkout.recoveryError.message
  );
  harness.setNow(START_AT + 95_000);
  harness.runtime.endWorkout();
  const summaryRuntime = createWorkoutSummaryRuntime({ database: harness.database });
  const loaded = summaryRuntime.load();
  assert.equal(loaded.summary.status, 'aborted');

  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logged.push(args);
  console.error = (...args) => logged.push(args);
  try {
    const saved = summaryRuntime.saveFeedback({
      rpe: 8,
      weightBeforeKg: 61.2,
      pain: { lowerBack: true },
      note: 'private-note-should-never-be-logged'
    });
    assert.equal(saved.saved, true);
    assert.equal(saved.fact.status, 'aborted');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(logged, []);
  const records = harness.database.load().records;
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceSessionId, 'session_completion_runtime');
  assert.equal(records[0].feedback.note, 'private-note-should-never-be-logged');

  summaryRuntime.saveFeedback({ rpe: 6 });
  assert.equal(harness.database.load().records.length, 1, 'source Session must materialize at most once');
});

test('keep-screen API failure stays non-blocking and becomes an observable runtime notice', async () => {
  const harness = createRuntimeHarness();
  const runtime = createTimedWorkoutRuntime({
    database: harness.database,
    now: () => START_AT,
    idFactory: () => 'session_keep_screen_failure',
    commandKeyFactory: (type) => `keep_screen_failure_${type}`,
    deviceAdapterFactory() {
      return {
        setKeepScreen() { return Promise.resolve({ supported: false }); },
        notify() { return Promise.resolve({ delivered: true }); }
      };
    }
  });
  const loaded = runtime.load({ planId: harness.plan.id });
  assert.notEqual(loaded.state, 'recovery-error');
  await Promise.resolve();
  const observed = runtime.render();
  assert.match(observed.deviceNotice, /常亮.*不可用/);
});

test('summary page exposes completed/aborted facts, validated feedback controls and safety advice', () => {
  const saved = [];
  const runtime = {
    load() {
      return {
        summary: {
          status: 'aborted',
          planTitle: '恢复与活动',
          elapsedLabel: '01:35',
          completedStepCount: 0,
          skippedStepCount: 0,
          totalStepCount: 1
        },
        feedback: normalizeWorkoutFeedback({}),
        saved: false
      };
    },
    saveFeedback(feedback) {
      saved.push(feedback);
      return { saved: true };
    }
  };
  const toastTitles = [];
  const {
    createWorkoutSummaryPageDefinition
  } = require('../../miniprogram/pages/workout/summary/index');
  const definition = createWorkoutSummaryPageDefinition({
    runtimeFactory: () => runtime,
    getWx: () => ({
      showToast({ title }) { toastTitles.push(title); }
    })
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) { this.data = { ...this.data, ...next }; }
  };

  page.onLoad({});
  assert.equal(page.data.summary.status, 'aborted');
  page.onRpeChange({ detail: { value: '7' } });
  page.onWeightInput({ detail: { value: '62.5' } });
  page.onPainChange({ currentTarget: { dataset: { field: 'dizziness' } }, detail: { value: true } });
  page.onNoteInput({ detail: { value: '仅保存在本机的备注' } });
  assert.match(page.data.safetyAdvice, /停止训练/);
  page.onSubmit();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].rpe, 7);
  assert.equal(saved[0].weightBeforeKg, 62.5);
  assert.equal(saved[0].pain.dizziness, true);
  assert.equal(saved[0].note, '仅保存在本机的备注');
  assert.deepEqual(toastTitles, ['反馈已保存在本机']);
});

test('mini program registers the real summary route and renders privacy/safety copy', () => {
  const root = path.resolve(__dirname, '../..');
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  assert.ok(appJson.pages.includes('pages/workout/summary/index'));

  const markup = fs.readFileSync(
    path.join(root, 'miniprogram/pages/workout/summary/index.wxml'),
    'utf8'
  );
  assert.match(markup, /实际训练时长/);
  assert.match(markup, /RPE/);
  assert.match(markup, /体重/);
  assert.match(markup, /膝|下背|脚踝|头晕/);
  assert.match(markup, /停止训练/);
  assert.match(markup, /不会用于诊断/);
  assert.match(markup, /仅保存在本机/);
});
