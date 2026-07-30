const assert = require('node:assert/strict');
const test = require('node:test');

const START_AT = 1785717300000; // 2026-08-03 08:35 Asia/Shanghai
const END_AT = 1785717600000; // 08:40, five minutes later

function loadEngine() {
  const module = require('../../miniprogram/services/timer-engine');
  if (typeof module.createTimerEngine === 'function') {
    return module.createTimerEngine();
  }
  if (typeof module.TimerEngine === 'function') {
    return new module.TimerEngine();
  }
  for (const method of ['start', 'getRemaining', 'pause', 'resume', 'adjust', 'restore', 'expire']) {
    assert.equal(typeof module[method], 'function', `timer-engine must export ${method}()`);
  }
  return module;
}

function timerOf(result) {
  return result && (result.timerSnapshot || result.timer || result.snapshot || result);
}

function remainingOf(result) {
  if (typeof result === 'number') {
    return result;
  }
  const timer = timerOf(result);
  return result && result.remainingSeconds !== undefined
    ? result.remainingSeconds
    : timer.remainingSeconds !== undefined
      ? timer.remainingSeconds
      : timer.remainingSecondsAtCheckpoint;
}

function statusOf(result) {
  const timer = timerOf(result);
  return (result && (result.timerStatus || result.status)) || timer.status;
}

function occurrenceIdOf(result) {
  const timer = timerOf(result);
  return (
    (result &&
      (result.expirationOccurrenceId || result.occurrenceId || result.eventOccurrenceId)) ||
    timer.expirationOccurrenceId ||
    timer.occurrenceId ||
    timer.eventOccurrenceId
  );
}

function isClockAnomaly(result) {
  const timer = timerOf(result);
  return Boolean(
    (result &&
      (result.clockAnomaly ||
        result.requiresConfirmation ||
        result.reason === 'clock-anomaly' ||
        result.code === 'CLOCK_ANOMALY')) ||
      timer.clockAnomaly ||
      timer.requiresConfirmation ||
      timer.reason === 'clock-anomaly' ||
      timer.code === 'CLOCK_ANOMALY'
  );
}

function startStep(engine, overrides = {}, nowMs = START_AT) {
  return engine.start(
    {
      mode: 'step',
      durationSeconds: 300,
      stepId: 'step_20260803_treadmill_warmup',
      setNumber: null,
      ...overrides
    },
    nowMs
  );
}

test('Attack: start 必须只使用显式 nowMs 建立绝对 deadline，不能读取 Date.now 或依赖 interval', () => {
  const engine = loadEngine();
  const originalDateNow = Date.now;
  Date.now = () => {
    throw new Error('ambient Date.now must not be consulted');
  };
  let started;
  try {
    started = timerOf(startStep(engine));
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(started.mode, 'step');
  assert.equal(started.status, 'running');
  assert.equal(started.durationSeconds, 300);
  assert.equal(started.remainingSecondsAtCheckpoint, 300);
  assert.equal(started.startedAt, START_AT);
  assert.equal(started.checkpointAt, START_AT);
  assert.equal(started.expectedEndAt, END_AT);
  assert.equal(started.pausedAt, null);
  assert.equal(started.expiredAt, null);
  assert.equal(started.adjustmentSeconds, 0);
  assert.equal(started.stepId, 'step_20260803_treadmill_warmup');
  assert.equal(started.setNumber, null);
});

test('Attack: running remaining 必须使用 ceil 并在 exact boundary 与超时后 clamp 到零', () => {
  const engine = loadEngine();
  const timer = timerOf(startStep(engine));

  assert.equal(remainingOf(engine.getRemaining(timer, START_AT)), 300);
  assert.equal(remainingOf(engine.getRemaining(timer, START_AT + 1)), 300);
  assert.equal(remainingOf(engine.getRemaining(timer, END_AT - 1001)), 2);
  assert.equal(remainingOf(engine.getRemaining(timer, END_AT - 1000)), 1);
  assert.equal(remainingOf(engine.getRemaining(timer, END_AT - 1)), 1);
  assert.equal(remainingOf(engine.getRemaining(timer, END_AT)), 0);
  assert.equal(remainingOf(engine.getRemaining(timer, END_AT + 60_000)), 0);
});

test('Attack: pause 必须冻结 ceil 后的剩余秒数并清空 deadline；resume 从显式 nowMs 重建 deadline', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));
  const original = JSON.parse(JSON.stringify(running));
  const pauseAt = START_AT + 120_001;

  const paused = timerOf(engine.pause(running, pauseAt));

  assert.deepEqual(running, original, 'pause must not mutate its input snapshot');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.remainingSecondsAtCheckpoint, 180);
  assert.equal(paused.expectedEndAt, null);
  assert.equal(paused.pausedAt, pauseAt);
  assert.equal(paused.checkpointAt, pauseAt);

  const resumeAt = START_AT + 600_000;
  const pausedBeforeResume = JSON.parse(JSON.stringify(paused));
  const resumed = timerOf(engine.resume(paused, resumeAt));
  assert.deepEqual(paused, pausedBeforeResume, 'resume must not mutate its input snapshot');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.remainingSecondsAtCheckpoint, 180);
  assert.equal(resumed.expectedEndAt, resumeAt + 180_000);
  assert.equal(resumed.checkpointAt, resumeAt);
  assert.equal(resumed.pausedAt, null);
});

test('Attack: ±30 adjustment 必须移动绝对 deadline、累计 adjustmentSeconds，并在减过头时 clamp 为零', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));
  const adjustAt = START_AT + 120_000;

  const added = timerOf(engine.adjust(running, 30, adjustAt));
  assert.equal(added.status, 'running');
  assert.equal(added.expectedEndAt, END_AT + 30_000);
  assert.equal(remainingOf(engine.getRemaining(added, adjustAt)), 210);
  assert.equal(added.adjustmentSeconds, 30);

  const subtracted = timerOf(engine.adjust(added, -30, adjustAt));
  assert.equal(subtracted.expectedEndAt, END_AT);
  assert.equal(remainingOf(engine.getRemaining(subtracted, adjustAt)), 180);
  assert.equal(subtracted.adjustmentSeconds, 0);

  const nearEnd = timerOf(startStep(engine, { durationSeconds: 10 }, START_AT));
  const clamped = timerOf(engine.adjust(nearEnd, -30, START_AT + 1_000));
  assert.equal(remainingOf(engine.getRemaining(clamped, START_AT + 1_000)), 0);
  assert.ok(clamped.expectedEndAt === null || clamped.expectedEndAt === START_AT + 1_000);
});

test('Attack: exact boundary expire 必须生成稳定 occurrence ID，重复 expire 不得改变 expiredAt 或重复边界', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));
  const expiredOnce = engine.expire(running, END_AT);
  const expiredTimer = timerOf(expiredOnce);
  const occurrenceId = occurrenceIdOf(expiredOnce);

  assert.equal(statusOf(expiredOnce), 'expired');
  assert.equal(remainingOf(expiredOnce), 0);
  assert.equal(expiredTimer.expiredAt, END_AT);
  assert.equal(typeof occurrenceId, 'string');
  assert.ok(occurrenceId.length > 0);

  const expiredAgain = engine.expire(expiredTimer, END_AT + 60_000);
  assert.equal(statusOf(expiredAgain), 'expired');
  assert.equal(timerOf(expiredAgain).expiredAt, END_AT);
  assert.equal(occurrenceIdOf(expiredAgain), occurrenceId);
});

test('Attack: 08:41 long-background restore 只能 expire 当前 08:35 timer 一次，不能隐式推进 step/set', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));
  const restoreAt = 1785717660000; // 08:41, one minute after this timer ended

  const restoredOnce = engine.restore(running, restoreAt);
  const restoredTimer = timerOf(restoredOnce);
  assert.equal(statusOf(restoredOnce), 'expired');
  assert.equal(remainingOf(restoredOnce), 0);
  assert.equal(restoredTimer.stepId, running.stepId);
  assert.notEqual(restoredOnce.nextStepStarted, true);
  assert.equal(restoredOnce.currentStepIndex, undefined);

  const restoredAgain = engine.restore(restoredTimer, restoreAt + 10_000);
  assert.equal(statusOf(restoredAgain), 'expired');
  assert.equal(timerOf(restoredAgain).expiredAt, restoredTimer.expiredAt);
  assert.equal(occurrenceIdOf(restoredAgain), occurrenceIdOf(restoredOnce));
});

test('Attack: backward clock jump 超过 5 秒必须暂停并要求确认；恰好 5 秒仍按 running 计算', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));

  const tolerated = engine.restore(running, START_AT - 5_000);
  assert.equal(statusOf(tolerated), 'running');
  assert.equal(isClockAnomaly(tolerated), false);
  assert.equal(remainingOf(tolerated), 305);

  const anomalous = engine.restore(running, START_AT - 5_001);
  const anomalyTimer = timerOf(anomalous);
  assert.equal(statusOf(anomalous), 'paused');
  assert.equal(isClockAnomaly(anomalous), true);
  assert.equal(remainingOf(anomalous), 300);
  assert.equal(anomalyTimer.expectedEndAt, null);
});

test('Attack: paused snapshot 经 JSON serialize/parse 后 restore 必须保持 paused 与冻结剩余值', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));
  const paused = timerOf(engine.pause(running, START_AT + 61_001));
  const persisted = JSON.parse(JSON.stringify(paused));

  const restored = engine.restore(persisted, START_AT + 3_600_000);

  assert.equal(statusOf(restored), 'paused');
  assert.equal(remainingOf(restored), 239);
  assert.equal(timerOf(restored).expectedEndAt, null);
  assert.deepEqual(JSON.parse(JSON.stringify(timerOf(restored))), timerOf(restored));
});

test('Attack: step/rest 的 expiration occurrence ID 必须稳定且按 timer identity 区分', () => {
  const engine = loadEngine();
  const step = timerOf(startStep(engine));
  const rest = timerOf(
    engine.start(
      {
        mode: 'rest',
        durationSeconds: 75,
        stepId: 'step_20260803_chest_press',
        setNumber: 2
      },
      START_AT
    )
  );

  const stepExpired = engine.expire(step, END_AT);
  const restExpired = engine.expire(rest, START_AT + 75_000);
  assert.equal(typeof occurrenceIdOf(stepExpired), 'string');
  assert.equal(typeof occurrenceIdOf(restExpired), 'string');
  assert.notEqual(occurrenceIdOf(stepExpired), occurrenceIdOf(restExpired));
  assert.equal(timerOf(restExpired).mode, 'rest');
  assert.equal(timerOf(restExpired).setNumber, 2);
});

test('Attack: malformed start 参数与非有限 nowMs 必须 fail closed', () => {
  const engine = loadEngine();
  for (const [input, nowMs] of [
    [{ mode: 'step', durationSeconds: 0, stepId: 'step-a', setNumber: null }, START_AT],
    [{ mode: 'step', durationSeconds: -1, stepId: 'step-a', setNumber: null }, START_AT],
    [{ mode: 'step', durationSeconds: 1.5, stepId: 'step-a', setNumber: null }, START_AT],
    [{ mode: 'future-mode', durationSeconds: 30, stepId: 'step-a', setNumber: null }, START_AT],
    [{ mode: 'step', durationSeconds: 30, stepId: '', setNumber: null }, START_AT],
    [{ mode: 'rest', durationSeconds: 30, stepId: 'step-a', setNumber: 0 }, START_AT],
    [{ mode: 'step', durationSeconds: 30, stepId: 'step-a', setNumber: null }, Number.NaN]
  ]) {
    assert.throws(() => engine.start(input, nowMs), /mode|duration|stepId|setNumber|nowMs|finite|integer/i);
  }
});

test('Attack: restore 必须拒绝 null、数组、未知 status/mode 与非法 deadline 的 future/malformed snapshot', () => {
  const engine = loadEngine();
  const valid = timerOf(startStep(engine));
  const invalidSnapshots = [
    null,
    [],
    { ...valid, status: 'future-suspended' },
    { ...valid, mode: 'future-mode' },
    { ...valid, expectedEndAt: null },
    { ...valid, checkpointAt: Number.NaN },
    { ...valid, durationSeconds: '300' }
  ];

  for (const snapshot of invalidSnapshots) {
    assert.throws(() => engine.restore(snapshot, START_AT), /snapshot|status|mode|deadline|expectedEndAt|checkpoint|duration|finite/i);
  }
});
