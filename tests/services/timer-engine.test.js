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

test('Attack Round 2: 非整秒 absolute deadline 的 ±30 调整必须精确平移毫秒值且不修改输入', () => {
  const engine = loadEngine();
  const startAt = START_AT + 137;
  const running = timerOf(startStep(engine, { durationSeconds: 37 }, startAt));
  const original = JSON.parse(JSON.stringify(running));
  const adjustAt = startAt + 12_345;

  const added = timerOf(engine.adjust(running, 30, adjustAt));
  assert.deepEqual(running, original, 'adjust must not mutate its input snapshot');
  assert.equal(added.expectedEndAt, original.expectedEndAt + 30_000);
  assert.equal(added.expectedEndAt % 1_000, 137);
  assert.equal(remainingOf(engine.getRemaining(added, adjustAt)), 55);

  const restored = timerOf(engine.adjust(added, -30, adjustAt));
  assert.equal(restored.expectedEndAt, original.expectedEndAt);
  assert.equal(restored.expectedEndAt % 1_000, 137);
  assert.equal(restored.adjustmentSeconds, 0);
});

test('Attack Round 2: unsafe/non-finite 数值必须在所有入口 fail closed 且不产生半状态', () => {
  const engine = loadEngine();
  const valid = timerOf(startStep(engine));

  for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => engine.getRemaining(valid, nowMs), /nowMs|finite|safe|integer/i);
    assert.throws(() => engine.pause(valid, nowMs), /nowMs|finite|safe|integer/i);
    assert.throws(() => engine.restore(valid, nowMs), /nowMs|finite|safe|integer/i);
  }

  assert.throws(
    () => startStep(engine, { durationSeconds: Number.MAX_SAFE_INTEGER }),
    /duration|range|deadline|safe/i
  );
  assert.throws(
    () => startStep(engine, { durationSeconds: 1 }, Number.MAX_SAFE_INTEGER),
    /duration|range|deadline|safe/i
  );
  for (const deltaSeconds of [0, 29, -29, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => engine.adjust(valid, deltaSeconds, START_AT),
      /adjust|30|finite|safe|integer/i
    );
  }
});

test('Attack Round 2: 非法状态命令必须拒绝，重复合法命令必须返回独立快照且不修改输入', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));
  const paused = timerOf(engine.pause(running, START_AT + 1_000));
  const expired = timerOf(engine.expire(running, END_AT));
  const pausedBefore = JSON.parse(JSON.stringify(paused));
  const expiredBefore = JSON.parse(JSON.stringify(expired));

  assert.throws(() => engine.expire(paused, END_AT), /expire|paused|status/i);
  assert.throws(() => engine.pause(expired, END_AT), /pause|expired|status/i);
  assert.throws(() => engine.resume(expired, END_AT), /resume|expired|status/i);
  assert.throws(() => engine.adjust(expired, 30, END_AT), /adjust|expired|status/i);
  assert.deepEqual(paused, pausedBefore);
  assert.deepEqual(expired, expiredBefore);

  const pausedAgain = timerOf(engine.pause(paused, START_AT + 2_000));
  const runningAgain = timerOf(engine.resume(running, START_AT + 2_000));
  const expiredAgain = timerOf(engine.expire(expired, END_AT + 1_000));
  assert.deepEqual(pausedAgain, paused);
  assert.deepEqual(runningAgain, running);
  assert.deepEqual(expiredAgain, expired);
  assert.notStrictEqual(pausedAgain, paused);
  assert.notStrictEqual(runningAgain, running);
  assert.notStrictEqual(expiredAgain, expired);
});

test('Attack Round 2: occurrence ID 必须抵抗分隔符碰撞并在 JSON round-trip 后保持确定性', () => {
  const engine = loadEngine();
  const weirdStep = timerOf(
    startStep(engine, { stepId: 'step:["rest",2]:\n:\\:尾' }, START_AT + 137)
  );
  const otherStep = timerOf(
    startStep(engine, { stepId: 'step:["rest",2]:\n:\\:尾:' }, START_AT + 137)
  );

  const weirdExpired = timerOf(engine.expire(weirdStep, weirdStep.expectedEndAt));
  const otherExpired = timerOf(engine.expire(otherStep, otherStep.expectedEndAt));
  assert.notEqual(occurrenceIdOf(weirdExpired), occurrenceIdOf(otherExpired));

  const persistedRunning = JSON.parse(JSON.stringify(weirdStep));
  const persistedExpired = timerOf(
    engine.expire(persistedRunning, persistedRunning.expectedEndAt + 60_000)
  );
  assert.equal(occurrenceIdOf(persistedExpired), occurrenceIdOf(weirdExpired));
});

test('Attack Round 2: 连续容差内回拨不得通过 checkpointAt 后退累积绕过 5 秒异常阈值', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));

  const toleratedOnce = timerOf(engine.restore(running, START_AT - 5_000));
  assert.equal(toleratedOnce.status, 'running');
  assert.equal(toleratedOnce.remainingSecondsAtCheckpoint, 305);

  const cumulativeTenSeconds = timerOf(engine.restore(toleratedOnce, START_AT - 10_000));
  assert.equal(
    cumulativeTenSeconds.status,
    'paused',
    'two successive 5-second backward observations are a cumulative 10-second rollback'
  );
  assert.equal(isClockAnomaly(cumulativeTenSeconds), true);
  assert.equal(cumulativeTenSeconds.remainingSecondsAtCheckpoint, 305);
  assert.equal(cumulativeTenSeconds.expectedEndAt, null);

  const repeated = timerOf(engine.restore(cumulativeTenSeconds, START_AT - 20_000));
  assert.deepEqual(repeated, cumulativeTenSeconds, 'repeated anomaly restore must be idempotent');

  const confirmed = timerOf(engine.resume(repeated, START_AT + 60_000));
  assert.equal(confirmed.status, 'running');
  assert.equal(confirmed.expectedEndAt, START_AT + 365_000);
  assert.equal(isClockAnomaly(confirmed), false);
});

test('Attack Round 2: restore 只能接受 JSON plain TimerSnapshot，不能接受 prototype-backed 对象', () => {
  const engine = loadEngine();
  const valid = timerOf(startStep(engine));
  const inherited = Object.create(valid);

  assert.throws(
    () => engine.restore(inherited, START_AT + 1_000),
    /snapshot|plain|prototype|own|schema|JSON/i
  );
});

test('Attack Round 2: TimerSnapshot 必须是 closed JSON schema，不能携带业务 index 或 prototype key', () => {
  const engine = loadEngine();
  const valid = timerOf(startStep(engine));
  const withBusinessIndexes = {
    ...valid,
    currentStepIndex: 7,
    currentSet: 3,
    nextStepStarted: true
  };
  const withPrototypeKey = JSON.parse(
    `${JSON.stringify(valid).slice(0, -1)},"__proto__":{"polluted":true}}`
  );

  for (const snapshot of [withBusinessIndexes, withPrototypeKey]) {
    assert.throws(
      () => engine.restore(snapshot, START_AT + 1_000),
      /snapshot|plain|prototype|unknown|field|schema|JSON/i
    );
  }
  assert.equal({}.polluted, undefined);
});

test('Attack Round 2: expired 是终态边界，重复 restore/expire 与失败命令均不得改写 occurrence 或输入', () => {
  const engine = loadEngine();
  const running = timerOf(startStep(engine));
  const expired = timerOf(engine.restore(running, END_AT + 120_000));
  const before = JSON.parse(JSON.stringify(expired));

  const restored = timerOf(engine.restore(expired, END_AT + 240_000));
  const expiredAgain = timerOf(engine.expire(expired, END_AT + 240_000));
  assert.deepEqual(restored, before);
  assert.deepEqual(expiredAgain, before);
  assert.equal(occurrenceIdOf(restored), occurrenceIdOf(before));
  assert.equal(occurrenceIdOf(expiredAgain), occurrenceIdOf(before));

  assert.throws(() => engine.adjust(expired, -30, END_AT + 240_000), /adjust|expired/i);
  assert.throws(() => engine.pause(expired, END_AT + 240_000), /pause|expired/i);
  assert.throws(() => engine.resume(expired, END_AT + 240_000), /resume|expired/i);
  assert.deepEqual(expired, before);
});
