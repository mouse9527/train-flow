const TIMER_MODES = Object.freeze(['step', 'rest']);
const TIMER_STATUSES = Object.freeze(['running', 'paused', 'expired']);
const TIMER_SNAPSHOT_VERSION = 1;
const BASE_SNAPSHOT_FIELDS = Object.freeze([
  'snapshotVersion',
  'mode',
  'status',
  'durationSeconds',
  'remainingSecondsAtCheckpoint',
  'startedAt',
  'expectedEndAt',
  'checkpointAt',
  'clockObservedAt',
  'pausedAt',
  'expiredAt',
  'adjustmentSeconds',
  'stepId',
  'setNumber'
]);
const EXPIRATION_FIELDS = Object.freeze(['expirationOccurrenceId']);
const CLOCK_ANOMALY_FIELDS = Object.freeze([
  'clockAnomaly',
  'requiresConfirmation',
  'reason',
  'code'
]);

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function assertPlainJsonObject(value, label) {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain JSON object without a custom prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} schema does not allow symbol fields`);
  }
  for (const field of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor.enumerable || !hasOwn(descriptor, 'value') || descriptor.value === undefined) {
      throw new TypeError(`${label} must contain only enumerable JSON data fields`);
    }
  }
}

function assertOwnFields(value, fields, label) {
  for (const field of fields) {
    if (!hasOwn(value, field)) {
      throw new TypeError(`${label} requires own field ${field}`);
    }
  }
}

function assertClosedFields(value, allowedFields, label) {
  const allowed = new Set(allowedFields);
  for (const field of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(field)) {
      throw new TypeError(`${label} contains unknown field ${field}`);
    }
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
  assertPlainJsonObject(snapshot, 'timer snapshot');
  assertOwnFields(snapshot, BASE_SNAPSHOT_FIELDS, 'timer snapshot');

  if (snapshot.snapshotVersion !== TIMER_SNAPSHOT_VERSION) {
    throw new TypeError(
      `timer snapshot version must be ${TIMER_SNAPSHOT_VERSION}`
    );
  }

  const stateFields = [...BASE_SNAPSHOT_FIELDS];
  if (snapshot.status === 'expired') {
    stateFields.push(...EXPIRATION_FIELDS);
    assertOwnFields(snapshot, EXPIRATION_FIELDS, 'expired timer snapshot');
  }
  const hasClockAnomaly = snapshot.status === 'paused' && hasOwn(snapshot, 'clockAnomaly');
  if (hasClockAnomaly) {
    stateFields.push(...CLOCK_ANOMALY_FIELDS);
    assertOwnFields(snapshot, CLOCK_ANOMALY_FIELDS, 'clock anomaly timer snapshot');
  }
  assertClosedFields(snapshot, stateFields, 'timer snapshot schema');

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
  assertSafeInteger(snapshot.clockObservedAt, 'timer snapshot clockObservedAt', { minimum: 0 });
  if (snapshot.clockObservedAt < snapshot.checkpointAt) {
    throw new TypeError('timer snapshot clockObservedAt cannot retreat behind checkpointAt');
  }
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

  if (hasClockAnomaly) {
    if (
      snapshot.clockAnomaly !== true ||
      snapshot.requiresConfirmation !== true ||
      snapshot.reason !== 'clock-anomaly' ||
      snapshot.code !== 'CLOCK_ANOMALY'
    ) {
      throw new TypeError('clock anomaly timer snapshot has an invalid confirmation state');
    }
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
  TIMER_SNAPSHOT_VERSION,
  TIMER_MODES,
  TIMER_STATUSES,
  assertNowMs,
  assertStartInput,
  assertTimerSnapshot,
  copyTimerSnapshot,
  createExpirationOccurrenceId
};
