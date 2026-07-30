const TIMER_MODES = Object.freeze(['step', 'rest']);
const TIMER_STATUSES = Object.freeze(['running', 'paused', 'expired']);

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertSafeInteger(value, label, { minimum = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a finite safe integer`);
  }
}

function assertNullableSafeInteger(value, label) {
  if (value !== null) {
    assertSafeInteger(value, label, { minimum: 0 });
  }
}

function assertTimerIdentity({ mode, stepId, setNumber }) {
  if (!TIMER_MODES.includes(mode)) {
    throw new TypeError(`timer mode must be one of: ${TIMER_MODES.join(', ')}`);
  }
  if (typeof stepId !== 'string' || stepId.trim().length === 0) {
    throw new TypeError('timer stepId must be a non-empty string');
  }
  if (mode === 'step' && setNumber !== null) {
    throw new TypeError('step timer setNumber must be null');
  }
  if (mode === 'rest' && (!Number.isSafeInteger(setNumber) || setNumber < 1)) {
    throw new TypeError('rest timer setNumber must be a positive integer');
  }
}

function assertStartInput(input) {
  assertObject(input, 'timer start input');
  assertTimerIdentity(input);
  assertSafeInteger(input.durationSeconds, 'timer durationSeconds', { minimum: 1 });
}

function assertNowMs(nowMs) {
  assertSafeInteger(nowMs, 'nowMs', { minimum: 0 });
}

function assertTimerSnapshot(snapshot) {
  assertObject(snapshot, 'timer snapshot');
  assertTimerIdentity(snapshot);

  if (!TIMER_STATUSES.includes(snapshot.status)) {
    throw new TypeError(`timer snapshot status must be one of: ${TIMER_STATUSES.join(', ')}`);
  }

  assertSafeInteger(snapshot.durationSeconds, 'timer snapshot durationSeconds', { minimum: 1 });
  assertSafeInteger(
    snapshot.remainingSecondsAtCheckpoint,
    'timer snapshot remainingSecondsAtCheckpoint',
    { minimum: 0 }
  );
  assertSafeInteger(snapshot.startedAt, 'timer snapshot startedAt', { minimum: 0 });
  assertSafeInteger(snapshot.checkpointAt, 'timer snapshot checkpointAt', { minimum: 0 });
  assertNullableSafeInteger(snapshot.expectedEndAt, 'timer snapshot expectedEndAt');
  assertNullableSafeInteger(snapshot.pausedAt, 'timer snapshot pausedAt');
  assertNullableSafeInteger(snapshot.expiredAt, 'timer snapshot expiredAt');
  assertSafeInteger(snapshot.adjustmentSeconds, 'timer snapshot adjustmentSeconds');
  if (snapshot.adjustmentSeconds % 30 !== 0) {
    throw new TypeError('timer snapshot adjustmentSeconds must use 30-second increments');
  }

  if (snapshot.status === 'running') {
    if (snapshot.expectedEndAt === null) {
      throw new TypeError('running timer snapshot expectedEndAt deadline must be finite');
    }
    if (snapshot.pausedAt !== null || snapshot.expiredAt !== null) {
      throw new TypeError('running timer snapshot cannot have pausedAt or expiredAt');
    }
  }

  if (snapshot.status === 'paused') {
    if (snapshot.expectedEndAt !== null) {
      throw new TypeError('paused timer snapshot expectedEndAt deadline must be null');
    }
    if (snapshot.pausedAt === null || snapshot.expiredAt !== null) {
      throw new TypeError('paused timer snapshot requires pausedAt and cannot have expiredAt');
    }
  }

  if (snapshot.status === 'expired') {
    if (
      snapshot.expectedEndAt !== null ||
      snapshot.pausedAt !== null ||
      snapshot.expiredAt === null ||
      snapshot.remainingSecondsAtCheckpoint !== 0
    ) {
      throw new TypeError('expired timer snapshot has an invalid expiration boundary');
    }
    if (
      typeof snapshot.expirationOccurrenceId !== 'string' ||
      snapshot.expirationOccurrenceId.length === 0
    ) {
      throw new TypeError('expired timer snapshot requires an expiration occurrence ID');
    }
  }

  if (
    snapshot.clockAnomaly !== undefined &&
    typeof snapshot.clockAnomaly !== 'boolean'
  ) {
    throw new TypeError('timer snapshot clockAnomaly must be boolean');
  }
  if (
    snapshot.requiresConfirmation !== undefined &&
    typeof snapshot.requiresConfirmation !== 'boolean'
  ) {
    throw new TypeError('timer snapshot requiresConfirmation must be boolean');
  }

  return snapshot;
}

function copyTimerSnapshot(snapshot) {
  return { ...assertTimerSnapshot(snapshot) };
}

function createExpirationOccurrenceId(snapshot) {
  assertTimerSnapshot(snapshot);
  return `timer-expiration:${JSON.stringify([
    snapshot.mode,
    snapshot.stepId,
    snapshot.setNumber,
    snapshot.durationSeconds,
    snapshot.startedAt
  ])}`;
}

module.exports = {
  TIMER_MODES,
  TIMER_STATUSES,
  assertNowMs,
  assertStartInput,
  assertTimerSnapshot,
  copyTimerSnapshot,
  createExpirationOccurrenceId
};
