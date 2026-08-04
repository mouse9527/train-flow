const {
  applyWorkoutCommand,
  assertWorkoutSession,
  cloneWorkoutSession,
  createSessionError,
  createWorkoutSession
} = require('./workout-session');
const {
  ensureTerminalTrainingRecord,
  findTrainingRecords
} = require('./training-record');
const { ENTITY_TYPES } = require('../sync/entity-mapper');
const { appendRepositorySyncMutation } = require('../sync/sync-operation');

function assertDatabase(database) {
  if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
    throw new Error('SessionRepository requires a LocalDatabase');
  }
}

function isTerminal(session) {
  return session.status === 'completed' || session.status === 'aborted';
}

function assertSessionIdAvailable(records, sessionId) {
  if (findTrainingRecords(records, sessionId).length > 0) {
    throw createSessionError(
      'Session ID is already reserved by a historical TrainingRecord',
      'SESSION_ID_REUSED'
    );
  }
}

function ensureTerminalRecordAndInvalidate(draft, session, nowMs, commandIdentity) {
  const existed = findTrainingRecords(draft.records, session.id).length > 0;
  const record = ensureTerminalTrainingRecord(draft.records, session);
  if (!existed) {
    draft.statisticsProjection = {
      dirty: true,
      reason: 'training-record-changed',
      recordId: record.id,
      recordRevision: record.revision,
      invalidatedAt: nowMs
    };
    appendRepositorySyncMutation(draft, {
      entityType: ENTITY_TYPES.TRAINING_RECORD,
      entityId: record.id,
      action: 'upsert',
      payload: record
    }, {
      commandIdentity,
      createdAt: nowMs,
      deviceId: session.originDeviceId
    });
  }
  return record;
}

class SessionRepository {
  constructor({ database }) {
    assertDatabase(database);
    this.database = database;
  }

  loadActive() {
    const session = this.database.load().activeSession;
    if (session === null) {
      return null;
    }
    assertWorkoutSession(session);
    return cloneWorkoutSession(session);
  }

  start({ plan, sessionId, originDeviceId, commandKey, nowMs }) {
    const candidate = createWorkoutSession({
      plan,
      sessionId,
      originDeviceId,
      commandKey,
      nowMs
    });
    const snapshot = this.database.load();
    if (snapshot.activeSession !== null) {
      assertWorkoutSession(snapshot.activeSession);
      const existingStart = snapshot.activeSession.processedCommands[0];
      const candidateStart = candidate.processedCommands[0];
      if (existingStart.key === commandKey) {
        if (existingStart.fingerprint === candidateStart.fingerprint) {
          return cloneWorkoutSession(snapshot.activeSession);
        }
        throw createSessionError(
          'Start command key was already used for another Session intent',
          'SESSION_COMMAND_KEY_REUSED'
        );
      }
      if (!isTerminal(snapshot.activeSession)) {
        throw createSessionError('Only one active Session is allowed', 'SESSION_ACTIVE_EXISTS');
      }
    }
    const committed = this.database.commit((draft) => {
      if (draft.activeSession !== null) {
        assertWorkoutSession(draft.activeSession);
        if (!isTerminal(draft.activeSession)) {
          throw createSessionError('Only one active Session is allowed', 'SESSION_ACTIVE_EXISTS');
        }
        ensureTerminalRecordAndInvalidate(
          draft,
          draft.activeSession,
          nowMs,
          `session.materialize:${draft.activeSession.id}:${draft.activeSession.sessionRevision}`
        );
      }
      assertSessionIdAvailable(draft.records, candidate.id);
      draft.activeSession = cloneWorkoutSession(candidate);
    }, snapshot.localRevision);
    assertWorkoutSession(committed.activeSession);
    return cloneWorkoutSession(committed.activeSession);
  }

  apply(command, { originDeviceId } = {}) {
    const snapshot = this.database.load();
    if (snapshot.activeSession === null) {
      throw createSessionError('No active Session exists', 'SESSION_NOT_FOUND');
    }
    assertWorkoutSession(snapshot.activeSession);
    if (snapshot.activeSession.originDeviceId !== originDeviceId) {
      throw createSessionError('Session belongs to another origin device', 'SESSION_DEVICE_MISMATCH');
    }
    const preview = applyWorkoutCommand(snapshot.activeSession, command);
    if (preview.replayed) {
      return preview;
    }

    const committed = this.database.commit((draft) => {
      if (draft.activeSession === null) {
        throw createSessionError('No active Session exists', 'SESSION_NOT_FOUND');
      }
      assertWorkoutSession(draft.activeSession);
      if (draft.activeSession.originDeviceId !== originDeviceId) {
        throw createSessionError('Session belongs to another origin device', 'SESSION_DEVICE_MISMATCH');
      }
      const applied = applyWorkoutCommand(draft.activeSession, command);
      if (applied.replayed) {
        throw createSessionError('Concurrent command already consumed this key', 'SESSION_COMMAND_RACE');
      }
      draft.activeSession = cloneWorkoutSession(applied.session);
      if (isTerminal(applied.session)) {
        ensureTerminalRecordAndInvalidate(
          draft,
          applied.session,
          command.nowMs,
          `session.apply:${applied.session.id}:${command.commandKey}`
        );
      }
    }, snapshot.localRevision);
    assertWorkoutSession(committed.activeSession);
    return { session: cloneWorkoutSession(committed.activeSession), replayed: false };
  }
}

function createSessionRepository(options) {
  return new SessionRepository(options);
}

module.exports = { SessionRepository, createSessionRepository };
