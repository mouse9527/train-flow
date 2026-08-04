const { createConflictState } = require('../domain/sync/entity-mapper');
const {
  applyAcceptedOperations,
  assertSyncOperation,
  selectPushableOperations
} = require('../domain/sync/sync-operation');
const {
  assertPushResult,
  assertRemoteSyncProvider
} = require('./remote-sync-provider');

function syncServiceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertDatabase(database) {
  if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
    throw syncServiceError('SyncService requires a LocalDatabase', 'SYNC_SERVICE_INVALID');
  }
}

function findOperation(outbox, opId) {
  const operation = outbox.find((candidate) => candidate && candidate.opId === opId) || null;
  if (operation) assertSyncOperation(operation);
  return operation;
}

class SyncService {
  constructor({ database, provider, now = Date.now }) {
    assertDatabase(database);
    assertRemoteSyncProvider(provider);
    if (typeof now !== 'function') {
      throw syncServiceError('SyncService now must be a function', 'SYNC_SERVICE_INVALID');
    }
    this.database = database;
    this.provider = provider;
    this.now = now;
  }

  async pushPending() {
    const snapshot = this.database.load();
    const selection = selectPushableOperations(snapshot.sync.outbox);
    if (selection.operations.length === 0) {
      return {
        attemptedOpIds: [],
        acceptedOpIds: [],
        unknownAcceptedOpIds: [],
        rejected: [],
        conflicts: [],
        unsupported: selection.unsupported
      };
    }

    const attemptedAt = this.now();
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt < 0) {
      throw syncServiceError('SyncService now must return a non-negative safe integer', 'SYNC_CLOCK_INVALID');
    }
    const selectedOpIds = new Set(selection.operations.map(({ opId }) => opId));
    const attemptedSnapshot = this.database.commit((draft) => {
      for (const operation of draft.sync.outbox) {
        if (!selectedOpIds.has(operation && operation.opId)) continue;
        assertSyncOperation(operation);
        if (attemptedAt < operation.createdAt) {
          throw syncServiceError('push attempt cannot predate operation creation', 'SYNC_CLOCK_INVALID');
        }
        operation.attemptCount += 1;
        operation.lastAttemptAt = attemptedAt;
        assertSyncOperation(operation);
      }
    }, snapshot.localRevision);
    const attemptedOperations = selection.operations.map(({ opId }) => {
      const operation = findOperation(attemptedSnapshot.sync.outbox, opId);
      if (!operation) {
        throw syncServiceError('selected push operation disappeared before provider call', 'SYNC_PUSH_RACE');
      }
      return cloneJson(operation);
    });

    const response = await this.provider.push({ operations: attemptedOperations });
    assertPushResult(response);

    const responseSnapshot = this.database.load();
    let accepted;
    this.database.commit((draft) => {
      accepted = applyAcceptedOperations(draft, response.accepted);
      for (const classification of response.conflicts) {
        const operation = findOperation(draft.sync.outbox, classification.opId);
        if (!operation) continue;
        const conflict = createConflictState({
          localOperation: operation,
          remoteChange: classification.remote,
          localEntity: operation.payload,
          detectedAt: attemptedAt
        });
        if (!draft.sync.conflicts.some(({ conflictId }) => conflictId === conflict.conflictId)) {
          draft.sync.conflicts.push(conflict);
        }
      }
      draft.sync.lastSyncedAt = attemptedAt;
      draft.sync.lastError = null;
    }, responseSnapshot.localRevision);

    return {
      attemptedOpIds: attemptedOperations.map(({ opId }) => opId),
      acceptedOpIds: accepted.acceptedOpIds,
      unknownAcceptedOpIds: accepted.unknownOpIds,
      rejected: cloneJson(response.rejected),
      conflicts: cloneJson(response.conflicts),
      unsupported: selection.unsupported
    };
  }
}

function createSyncService(options) {
  return new SyncService(options);
}

module.exports = { SyncService, createSyncService };
