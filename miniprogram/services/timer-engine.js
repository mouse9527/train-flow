const {
  assertNowMs,
  assertStartInput,
  assertTimerSnapshot,
  copyTimerSnapshot,
  createExpirationOccurrenceId,
  CLOCK_BACKWARD_TOLERANCE_MS,
  TIMER_SNAPSHOT_VERSION
} = require('../domain/execution/timer-snapshot');

const ADJUSTMENT_SECONDS = 30;

function checkedAddMilliseconds(nowMs, seconds, label) {
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`${label} is outside the supported timer range`);
  }
  const result = nowMs + milliseconds;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} produces an unsafe deadline`);
  }
  return result;
}

function start(input, nowMs) {
  const data = assertStartInput(input);
  assertNowMs(nowMs);

  return {
    snapshotVersion: TIMER_SNAPSHOT_VERSION,
    mode: data.mode,
    status: 'running',
    durationSeconds: data.durationSeconds,
    remainingSecondsAtCheckpoint: data.durationSeconds,
    startedAt: nowMs,
    expectedEndAt: checkedAddMilliseconds(nowMs, data.durationSeconds, 'durationSeconds'),
    checkpointAt: nowMs,
    clockObservedAt: nowMs,
    pausedAt: null,
    pauseReason: null,
    expiredAt: null,
    adjustmentSeconds: 0,
    stepId: data.stepId,
    setNumber: data.setNumber
  };
}

function assertClockObservation(snapshot, nowMs) {
  if (snapshot.clockObservedAt - nowMs > CLOCK_BACKWARD_TOLERANCE_MS) {
    throw new Error('clock anomaly requires confirmation before changing timer state');
  }
}

function toClockAnomaly(snapshot, nowMs) {
  return {
    ...snapshot,
    status: 'paused',
    expectedEndAt: null,
    checkpointAt: nowMs,
    clockObservedAt: snapshot.clockObservedAt,
    pausedAt: nowMs,
    pauseReason: 'clock-anomaly',
    clockAnomaly: true,
    requiresConfirmation: true,
    reason: 'clock-anomaly',
    code: 'CLOCK_ANOMALY'
  };
}

function getRemaining(snapshot, nowMs) {
  assertTimerSnapshot(snapshot);
  assertNowMs(nowMs);

  if (snapshot.status === 'expired') {
    return 0;
  }
  if (snapshot.status === 'paused') {
    return snapshot.remainingSecondsAtCheckpoint;
  }
  assertClockObservation(snapshot, nowMs);
  return Math.max(0, Math.ceil((snapshot.expectedEndAt - nowMs) / 1_000));
}

function pause(snapshot, nowMs) {
  assertTimerSnapshot(snapshot);
  assertNowMs(nowMs);

  if (snapshot.status === 'paused') {
    return copyTimerSnapshot(snapshot);
  }
  if (snapshot.status !== 'running') {
    throw new Error(`cannot pause timer with status ${snapshot.status}`);
  }
  assertClockObservation(snapshot, nowMs);

  return {
    ...snapshot,
    status: 'paused',
    remainingSecondsAtCheckpoint: getRemaining(snapshot, nowMs),
    expectedEndAt: null,
    checkpointAt: nowMs,
    clockObservedAt: Math.max(snapshot.clockObservedAt, nowMs),
    pausedAt: nowMs,
    pauseReason: 'user'
  };
}

function resume(snapshot, nowMs) {
  assertTimerSnapshot(snapshot);
  assertNowMs(nowMs);

  if (snapshot.status === 'running') {
    return copyTimerSnapshot(snapshot);
  }
  if (snapshot.status !== 'paused') {
    throw new Error(`cannot resume timer with status ${snapshot.status}`);
  }
  if (snapshot.pauseReason !== 'clock-anomaly') {
    assertClockObservation(snapshot, nowMs);
  } else if (nowMs < snapshot.startedAt) {
    throw new Error('clock anomaly confirmation requires nowMs at or after startedAt');
  }

  const resumed = {
    ...snapshot,
    status: 'running',
    expectedEndAt: checkedAddMilliseconds(
      nowMs,
      snapshot.remainingSecondsAtCheckpoint,
      'remainingSecondsAtCheckpoint'
    ),
    checkpointAt: nowMs,
    clockObservedAt:
      snapshot.pauseReason === 'clock-anomaly'
        ? nowMs
        : Math.max(snapshot.clockObservedAt, nowMs),
    pausedAt: null,
    pauseReason: null
  };
  delete resumed.clockAnomaly;
  delete resumed.requiresConfirmation;
  delete resumed.reason;
  delete resumed.code;
  return resumed;
}

function assertAdjustment(deltaSeconds) {
  if (deltaSeconds !== ADJUSTMENT_SECONDS && deltaSeconds !== -ADJUSTMENT_SECONDS) {
    throw new TypeError(`timer adjustment must be +${ADJUSTMENT_SECONDS} or -${ADJUSTMENT_SECONDS}`);
  }
}

function adjust(snapshot, deltaSeconds, nowMs) {
  assertTimerSnapshot(snapshot);
  assertAdjustment(deltaSeconds);
  assertNowMs(nowMs);

  if (snapshot.status === 'expired') {
    throw new Error('cannot adjust an expired timer');
  }
  if (snapshot.pauseReason === 'clock-anomaly') {
    throw new Error('cannot adjust timer before confirming clock anomaly');
  }
  assertClockObservation(snapshot, nowMs);

  const adjustmentSeconds = snapshot.adjustmentSeconds + deltaSeconds;
  if (!Number.isSafeInteger(adjustmentSeconds)) {
    throw new RangeError('timer adjustmentSeconds is outside the supported range');
  }

  if (snapshot.status === 'paused') {
    const remainingAfterAdjustment = snapshot.remainingSecondsAtCheckpoint + deltaSeconds;
    if (!Number.isSafeInteger(remainingAfterAdjustment)) {
      throw new RangeError('adjusted remaining time is outside the supported range');
    }
    const adjustedRemaining = Math.max(0, remainingAfterAdjustment);
    return {
      ...snapshot,
      remainingSecondsAtCheckpoint: adjustedRemaining,
      checkpointAt: nowMs,
      clockObservedAt: Math.max(snapshot.clockObservedAt, nowMs),
      pausedAt: nowMs,
      adjustmentSeconds
    };
  }

  const adjustedDeadline = Math.max(
    nowMs,
    snapshot.startedAt,
    checkedAddMilliseconds(snapshot.expectedEndAt, deltaSeconds, 'adjusted deadline')
  );
  return {
    ...snapshot,
    remainingSecondsAtCheckpoint: Math.max(
      0,
      Math.ceil((adjustedDeadline - nowMs) / 1_000)
    ),
    expectedEndAt: adjustedDeadline,
    checkpointAt: nowMs,
    clockObservedAt: Math.max(snapshot.clockObservedAt, nowMs),
    adjustmentSeconds
  };
}

function expire(snapshot, nowMs) {
  assertTimerSnapshot(snapshot);
  assertNowMs(nowMs);

  if (snapshot.status === 'expired') {
    return copyTimerSnapshot(snapshot);
  }
  if (snapshot.status !== 'running') {
    throw new Error(`cannot expire timer with status ${snapshot.status}`);
  }
  if (getRemaining(snapshot, nowMs) > 0) {
    throw new Error('cannot expire timer before its deadline');
  }

  const expirationOccurrenceId = createExpirationOccurrenceId(snapshot);
  return {
    ...snapshot,
    status: 'expired',
    remainingSecondsAtCheckpoint: 0,
    expectedEndAt: null,
    checkpointAt: nowMs,
    clockObservedAt: Math.max(snapshot.clockObservedAt, nowMs),
    pausedAt: null,
    pauseReason: null,
    expiredAt: snapshot.expectedEndAt,
    expirationOccurrenceId
  };
}

function restore(snapshot, nowMs) {
  assertTimerSnapshot(snapshot);
  assertNowMs(nowMs);

  if (snapshot.status === 'expired' || snapshot.pauseReason === 'clock-anomaly') {
    return copyTimerSnapshot(snapshot);
  }

  if (snapshot.clockObservedAt - nowMs > CLOCK_BACKWARD_TOLERANCE_MS) {
    return toClockAnomaly(snapshot, nowMs);
  }

  if (snapshot.status === 'paused') {
    return copyTimerSnapshot(snapshot);
  }

  const remainingSecondsAtCheckpoint = getRemaining(snapshot, nowMs);
  if (remainingSecondsAtCheckpoint === 0) {
    return expire(snapshot, nowMs);
  }

  return {
    ...snapshot,
    remainingSecondsAtCheckpoint,
    checkpointAt: nowMs,
    clockObservedAt: Math.max(snapshot.clockObservedAt, nowMs)
  };
}

class TimerEngine {
  start(input, nowMs) {
    return start(input, nowMs);
  }

  getRemaining(snapshot, nowMs) {
    return getRemaining(snapshot, nowMs);
  }

  remaining(snapshot, nowMs) {
    return getRemaining(snapshot, nowMs);
  }

  pause(snapshot, nowMs) {
    return pause(snapshot, nowMs);
  }

  resume(snapshot, nowMs) {
    return resume(snapshot, nowMs);
  }

  adjust(snapshot, deltaSeconds, nowMs) {
    return adjust(snapshot, deltaSeconds, nowMs);
  }

  restore(snapshot, nowMs) {
    return restore(snapshot, nowMs);
  }

  expire(snapshot, nowMs) {
    return expire(snapshot, nowMs);
  }
}

function createTimerEngine() {
  return new TimerEngine();
}

module.exports = {
  ADJUSTMENT_SECONDS,
  CLOCK_BACKWARD_TOLERANCE_MS,
  TimerEngine,
  adjust,
  createTimerEngine,
  expire,
  getRemaining,
  pause,
  remaining: getRemaining,
  restore,
  resume,
  start
};
