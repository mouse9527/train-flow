const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  SAFETY_ADVICE,
  buildWorkoutCompletionSummary,
  createWorkoutCompletionFact,
  normalizeWorkoutFeedback
} = require('../../miniprogram/application/workout-application-service');
const {
  createTimedWorkoutRuntime
} = require('../../miniprogram/application/timed-workout-runtime');
const {
  createWorkoutSummaryRuntime
} = require('../../miniprogram/application/workout-summary-runtime');
const {
  applyWorkoutCommand,
  createWorkoutSession
} = require('../../miniprogram/domain/execution/workout-session');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const {
  createWechatDeviceAdapter
} = require('../../miniprogram/services/wechat-device-adapter');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785717300000;
const PAIN_FIELDS = ['knee', 'lowerBack', 'ankleOrToe', 'dizziness'];

function customPlan(kind, { sets = 1, restSeconds = null } = {}) {
  const plans = createDefaultPlans({ now: () => START_AT });
  const source = kind === 'strength'
    ? plans[0].steps.find((step) => step.kind === 'strength')
    : kind === 'timed'
      ? plans[0].steps.find((step) => step.kind === 'timed')
      : plans[2].steps.find((step) => step.kind === 'manual');
  const plan = clone(plans[2]);
  plan.id = `plan_adequacy_${kind}`;
  plan.trainingDate = kind === 'strength' ? '2026-08-12' : kind === 'timed' ? '2026-08-11' : '2026-08-10';
  plan.templateSource = null;
  plan.steps = [{
    ...clone(source),
    id: `step_adequacy_${kind}`,
    order: 1,
    sets: kind === 'strength' ? sets : source.sets,
    restSeconds: kind === 'strength' ? restSeconds : source.restSeconds
  }];
  return plan;
}

function startSession(plan, id) {
  return createWorkoutSession({
    plan,
    sessionId: id,
    originDeviceId: 'device_adequacy',
    commandKey: `start_${id}`,
    nowMs: START_AT
  });
}

function transition(session, type, nowMs, payload = {}) {
  return applyWorkoutCommand(session, {
    type,
    expectedSessionRevision: session.sessionRevision,
    commandKey: `${type}_${session.sessionRevision}_${nowMs}`,
    nowMs,
    payload
  }).session;
}

function pausedSkippedCompletedSession() {
  const base = customPlan('manual');
  const second = { ...clone(base.steps[0]), id: 'step_adequacy_manual_second', order: 2 };
  base.steps.push(second);
  let session = startSession(base, 'session_active_duration');
  session = transition(session, 'pause', START_AT + 10_000, { reason: 'user' });
  session = transition(session, 'resume', START_AT + 100_000, { reason: 'user' });
  session = transition(session, 'skip_step', START_AT + 110_000, {
    stepId: session.planSnapshot.steps[0].id
  });
  session = transition(session, 'complete_step', START_AT + 130_000, {
    stepId: session.planSnapshot.steps[1].id
  });
  return session;
}

function abortedSession(id = 'session_adequacy_aborted') {
  let session = startSession(customPlan('manual'), id);
  session = transition(session, 'abort', START_AT + 65_000, { reason: 'user-ended-workout' });
  return session;
}

function completedSession(id = 'session_adequacy_completed') {
  let session = startSession(customPlan('manual'), id);
  session = transition(session, 'complete_step', START_AT + 45_000, {
    stepId: session.planSnapshot.steps[0].id
  });
  return session;
}

function databaseWithPlan(plan, settings = {}) {
  const database = createLocalDatabase({ storage: new StorageDouble(), now: () => START_AT });
  database.commit((draft) => {
    draft.install = { deviceId: 'device_adequacy_runtime', createdAt: START_AT };
    Object.assign(draft.settings, settings);
    draft.plans.push(clone(plan));
  });
  return database;
}

function databaseWithTerminal(session) {
  const database = createLocalDatabase({ storage: new StorageDouble(), now: () => session.endedAt });
  database.commit((draft) => {
    draft.install = { deviceId: session.originDeviceId, createdAt: START_AT };
    draft.activeSession = clone(session);
  });
  return database;
}

test('active duration excludes paused wall-clock time and summary reports non-zero skipped count', () => {
  const summary = buildWorkoutCompletionSummary(pausedSkippedCompletedSession());
  assert.equal(summary.elapsedActiveSeconds, 40);
  assert.equal(summary.elapsedLabel, '00:40');
  assert.equal(summary.completedStepCount, 1);
  assert.equal(summary.skippedStepCount, 1);
  assert.equal(summary.totalStepCount, 2);
});

test('RPE is required at save boundary, accepts 1 and 10, while empty optional weight/note remain valid', () => {
  assert.throws(() => normalizeWorkoutFeedback({}), /RPE.*required/i);
  assert.throws(() => normalizeWorkoutFeedback({ rpe: null }), /RPE.*required/i);
  for (const rpe of [1, 10]) {
    const feedback = normalizeWorkoutFeedback({ rpe, weightBeforeKg: null, note: '' });
    assert.equal(feedback.rpe, rpe);
    assert.equal(feedback.weightBeforeKg, null);
    assert.equal(feedback.note, '');
    assert.deepEqual(feedback.pain, {
      knee: false,
      lowerBack: false,
      ankleOrToe: false,
      dizziness: false
    });
  }
});

test('completed and aborted Sessions share one terminal guard for representative commands', () => {
  for (const terminal of [completedSession(), abortedSession()]) {
    const stepId = terminal.planSnapshot.steps[0].id;
    for (const [type, payload] of [
      ['start_step', { stepId }],
      ['pause', { reason: 'late' }],
      ['complete_step', { stepId }],
      ['abort', { reason: 'late' }],
      ['previous_step', {}]
    ]) {
      assert.throws(
        () => transition(terminal, type, terminal.endedAt + 1_000, payload),
        (error) => error && error.code === 'SESSION_TERMINAL',
        `${terminal.status} must reject ${type}`
      );
    }
  }
});

test('completed and aborted summary-to-record persistence is symmetric without event/status confusion', () => {
  const records = [];
  for (const session of [completedSession(), abortedSession()]) {
    const runtime = createWorkoutSummaryRuntime({
      database: databaseWithTerminal(session),
      now: () => session.endedAt + 1_000
    });
    assert.equal(runtime.load().summary.status, session.status);
    records.push(runtime.saveFeedback({ rpe: session.status === 'completed' ? 4 : 8 }).fact);
  }
  assert.deepEqual(records.map(({ status }) => status), ['completed', 'aborted']);
  assert.deepEqual(records.map(({ eventType }) => eventType), [
    'WorkoutSessionCompleted',
    'WorkoutSessionAborted'
  ]);
  assert.notEqual(records[0].occurrenceId, records[1].occurrenceId);
});

test('keep-screen stays off before step start, follows settings after start, and releases on every exit', async () => {
  const plan = customPlan('timed');
  const calls = [];
  let nowMs = START_AT;
  const runtime = createTimedWorkoutRuntime({
    database: databaseWithPlan(plan),
    now: () => nowMs,
    idFactory: () => 'session_keep_screen_completed',
    commandKeyFactory: (type) => `keep_completed_${type}_${nowMs}`,
    deviceAdapterFactory() {
      return {
        setKeepScreen(enabled) { calls.push(enabled); return Promise.resolve({ supported: true }); },
        notify() { return Promise.resolve({ delivered: true }); }
      };
    }
  });
  runtime.load({ planId: plan.id });
  assert.equal(calls.includes(true), false, 'ready state must not enable keep-screen');
  runtime.start();
  assert.equal(calls.at(-1), true);
  runtime.onHide();
  assert.equal(calls.at(-1), false);
  runtime.onShow();
  assert.equal(calls.at(-1), true);
  nowMs += 5_000;
  runtime.earlyComplete();
  assert.equal(calls.at(-1), false, 'completed path must release');
  runtime.onUnload();
  assert.equal(calls.at(-1), false, 'unload must release');

  const abortedCalls = [];
  const abortedRuntime = createTimedWorkoutRuntime({
    database: databaseWithPlan(plan),
    now: () => START_AT + 10_000,
    idFactory: () => 'session_keep_screen_aborted',
    commandKeyFactory: (type) => `keep_aborted_${type}`,
    deviceAdapterFactory() {
      return {
        setKeepScreen(enabled) { abortedCalls.push(enabled); return Promise.resolve({ supported: true }); },
        notify() { return Promise.resolve({ delivered: true }); }
      };
    }
  });
  abortedRuntime.load({ planId: plan.id });
  abortedRuntime.start();
  abortedRuntime.endWorkout();
  assert.equal(abortedCalls.at(-1), false, 'aborted path must release');
  await Promise.resolve();
});

test('sync throw, Promise rejection and release failure never roll back terminal commits and stay visible', async () => {
  for (const [terminalAction, expectedStatus, notifyMode] of [
    ['completeManual', 'completed', 'reject'],
    ['endWorkout', 'aborted', 'throw']
  ]) {
    const plan = customPlan('manual');
    const database = databaseWithPlan(plan);
    const runtime = createTimedWorkoutRuntime({
      database,
      now: () => START_AT + 20_000,
      idFactory: () => `session_device_failure_${expectedStatus}`,
      commandKeyFactory: (type) => `device_failure_${expectedStatus}_${type}`,
      deviceAdapterFactory() {
        return {
          setKeepScreen(enabled) {
            if (!enabled) return Promise.reject(new Error('release unavailable'));
            throw new Error('enable unavailable');
          },
          notify() {
            if (notifyMode === 'throw') throw new Error('notify unavailable');
            return Promise.reject(new Error('notify unavailable'));
          }
        };
      }
    });
    runtime.load({ planId: plan.id });
    runtime[terminalAction]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(database.load().activeSession.status, expectedStatus);
    assert.match(runtime.render().deviceNotice, /不可用|视觉提示/);
  }
});

test('disabled device settings suppress vibration/sound/voice, while aborted never masquerades as completion', async () => {
  const effects = [];
  const adapter = createWechatDeviceAdapter({
    wxApi: {
      vibrateLong() { effects.push('vibrate'); },
      showToast({ success }) { effects.push('visual'); success(); }
    },
    audioService: {
      play() { effects.push('sound'); return Promise.resolve({ supported: true }); },
      speak() { effects.push('voice'); return Promise.resolve({ supported: true }); }
    },
    settings: {
      vibrationEnabled: false,
      soundEnabled: false,
      voiceEnabled: false,
      keepScreenOn: false
    }
  });
  await adapter.notify({ occurrenceId: 'disabled-effects', visualMessage: '页面提醒' });
  assert.deepEqual(effects, ['visual']);

  const calls = [];
  const session = abortedSession('session_aborted_notification_policy');
  const runtime = createTimedWorkoutRuntime({
    database: databaseWithTerminal(session),
    now: () => session.endedAt,
    deviceAdapterFactory() {
      return {
        setKeepScreen() { return Promise.resolve({ supported: true }); },
        notify(input) { calls.push(input); return Promise.resolve({ delivered: true }); }
      };
    }
  });
  runtime.load({});
  await Promise.resolve();
  assert.equal(calls.some(({ kind }) => kind === 'session-completed'), false);
  assert.equal(calls.filter(({ kind }) => kind === 'session-aborted').length, 1);
});

test('rest expiration occurrence is labeled correctly and stays deduplicated across runtime reconstruction', async () => {
  const plan = customPlan('strength', { sets: 2, restSeconds: 1 });
  const database = databaseWithPlan(plan);
  let nowMs = START_AT;
  const firstCalls = [];
  let sequence = 0;
  const first = createTimedWorkoutRuntime({
    database,
    now: () => nowMs,
    idFactory: () => 'session_rest_occurrence',
    commandKeyFactory: (type) => `rest_first_${type}_${++sequence}`,
    deviceAdapterFactory() {
      return {
        setKeepScreen() { return Promise.resolve({ supported: true }); },
        notify(input) { firstCalls.push(input); return Promise.resolve({ delivered: true }); }
      };
    }
  });
  first.load({ planId: plan.id });
  first.completeSet({ reps: plan.steps[0].reps, weightKg: null });
  nowMs = first.session.timer.expectedEndAt;
  first.onShow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstCalls.filter(({ kind }) => kind === 'rest-expired').length, 1);

  const rebuiltCalls = [];
  const rebuilt = createTimedWorkoutRuntime({
    database,
    now: () => nowMs,
    idFactory: () => 'must_not_replace_rest_session',
    commandKeyFactory: (type) => `rest_rebuilt_${type}`,
    deviceAdapterFactory() {
      return {
        setKeepScreen() { return Promise.resolve({ supported: true }); },
        notify(input) { rebuiltCalls.push(input); return Promise.resolve({ delivered: true }); }
      };
    }
  });
  rebuilt.load({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rebuiltCalls.some(({ kind }) => kind === 'rest-expired'), false);
});

test('privacy remains silent across normalize, fact, save/load and device failure paths', async () => {
  const captured = [];
  const methods = ['log', 'error', 'warn', 'info', 'debug'];
  const originals = Object.fromEntries(methods.map((method) => [method, console[method]]));
  methods.forEach((method) => { console[method] = (...args) => captured.push([method, args]); });
  try {
    const session = completedSession('session_privacy_adequacy');
    const rawFeedback = {
      rpe: 6,
      weightBeforeKg: 60.1,
      pain: { knee: true },
      note: 'SYNTHETIC_PRIVATE_FEEDBACK_SENTINEL'
    };
    const feedback = normalizeWorkoutFeedback(rawFeedback);
    createWorkoutCompletionFact(session, feedback);
    const runtime = createWorkoutSummaryRuntime({ database: databaseWithTerminal(session) });
    runtime.load();
    runtime.saveFeedback(rawFeedback);
    runtime.load();
    const adapter = createWechatDeviceAdapter({
      wxApi: {
        vibrateLong() { throw new Error('synthetic failure'); },
        showToast({ fail }) { fail(new Error('synthetic visual failure')); }
      },
      audioService: {
        play() { return Promise.reject(new Error('synthetic audio failure')); },
        speak() { return Promise.reject(new Error('synthetic voice failure')); }
      },
      settings: {
        vibrationEnabled: true,
        soundEnabled: true,
        voiceEnabled: true,
        keepScreenOn: true
      }
    });
    await adapter.notify({ occurrenceId: 'privacy-device-failure', visualMessage: '训练提醒' });
  } finally {
    methods.forEach((method) => { console[method] = originals[method]; });
  }
  assert.deepEqual(captured, []);
});

test('source privacy scan and all safety alarm flags lock positive non-diagnostic guidance', () => {
  for (const field of PAIN_FIELDS) {
    const feedback = normalizeWorkoutFeedback({ rpe: 5, pain: { [field]: true } });
    assert.equal(feedback.safetyAdvice, SAFETY_ADVICE, field);
    assert.match(feedback.safetyAdvice, /停止训练/, field);
    assert.match(feedback.safetyAdvice, /严重程度/, field);
    assert.match(feedback.safetyAdvice, /寻求.*帮助/, field);
    assert.doesNotMatch(feedback.safetyAdvice, /你患有|确诊为|这是.*病/, field);
  }

  const root = path.resolve(__dirname, '../..');
  const sourceFiles = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(js|wxml|json|wxss)$/.test(entry.name)) sourceFiles.push(target);
    }
  }
  visit(path.join(root, 'miniprogram'));
  for (const file of sourceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /SYNTHETIC_PRIVATE_FEEDBACK_SENTINEL/, file);
    assert.doesNotMatch(
      source,
      /console\.(?:log|error|warn|info|debug)\s*\([^\n]*(?:feedback|rpe|pain|note|weight)/i,
      file
    );
  }
});

test('real WXML binds both terminal summaries, all feedback controls and the safety disclaimer', () => {
  const root = path.resolve(__dirname, '../..');
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'));
  const markup = fs.readFileSync(
    path.join(root, 'miniprogram/pages/workout/summary/index.wxml'),
    'utf8'
  );
  const pageSource = fs.readFileSync(
    path.join(root, 'miniprogram/pages/workout/summary/index.js'),
    'utf8'
  );
  assert.ok(appJson.pages.includes('pages/workout/summary/index'));
  assert.match(markup, /summary\.status === 'completed'/);
  assert.match(markup, /训练已中止/);
  assert.match(markup, /bindinput="onRpeChange"/);
  assert.match(markup, /bindinput="onWeightInput"/);
  assert.equal((markup.match(/bindchange="onPainChange"/g) || []).length, 4);
  assert.match(markup, /bindinput="onNoteInput"/);
  assert.match(markup, /bindtap="onSubmit"/);
  assert.match(markup, /停止训练/);
  assert.match(markup, /不会用于诊断/);
  for (const handler of ['onRpeChange', 'onWeightInput', 'onPainChange', 'onNoteInput', 'onSubmit']) {
    assert.match(pageSource, new RegExp(`${handler}\\(`));
  }
});
