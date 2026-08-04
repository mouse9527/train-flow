const { ENTITY_TYPES, mapRemoteChange } = require('../domain/sync/entity-mapper');
const { assertSyncOperation, entityKey } = require('../domain/sync/sync-operation');
const { DEFAULT_USER_SETTINGS } = require('../utils/constants');

const PROVIDER_METHODS = Object.freeze(['bootstrap', 'push', 'pull', 'purge']);
const BOOTSTRAP_RESULT_FIELDS = Object.freeze(['cursor', 'serverTime']);
const PUSH_RESULT_FIELDS = Object.freeze(['accepted', 'rejected', 'conflicts']);
const PULL_RESULT_FIELDS = Object.freeze(['changes', 'nextCursor', 'hasMore']);
const PURGE_RESULT_FIELDS = Object.freeze(['purgedAt']);
const ACCEPTED_FIELDS = Object.freeze([
  'opId',
  'entityType',
  'entityId',
  'serverRevision',
  'payloadHash'
]);
const REJECTED_FIELDS = Object.freeze(['opId', 'code']);
const CONFLICT_FIELDS = Object.freeze(['opId', 'remote']);

function providerError(message, code = 'REMOTE_SYNC_RESPONSE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function hasExactFields(value, fields) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => hasOwn(value, field))
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertCursor(cursor, label) {
  if (cursor !== null && (typeof cursor !== 'string' || cursor.length === 0)) {
    throw providerError(`${label} must be null or a non-empty string`);
  }
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw providerError(`${label} must be a non-negative safe integer`);
  }
}

function assertRemoteSyncProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw providerError('RemoteSyncProvider must be an object', 'REMOTE_SYNC_PROVIDER_INVALID');
  }
  for (const method of PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw providerError(
        `RemoteSyncProvider requires ${method}()`,
        'REMOTE_SYNC_PROVIDER_INVALID'
      );
    }
  }
  return provider;
}

function assertBootstrapResult(result) {
  if (!hasExactFields(result, BOOTSTRAP_RESULT_FIELDS)) {
    throw providerError('bootstrap result must use the closed V1 schema');
  }
  assertCursor(result.cursor, 'bootstrap cursor');
  assertNonNegativeSafeInteger(result.serverTime, 'bootstrap serverTime');
  return result;
}

function assertAccepted(receipt) {
  if (!hasExactFields(receipt, ACCEPTED_FIELDS)) {
    throw providerError('accepted receipt must use the closed V1 schema');
  }
  if (
    typeof receipt.opId !== 'string' || receipt.opId.length === 0 ||
    typeof receipt.entityType !== 'string' || receipt.entityType.length === 0 ||
    typeof receipt.entityId !== 'string' || receipt.entityId.length === 0 ||
    !Number.isSafeInteger(receipt.serverRevision) || receipt.serverRevision < 1 ||
    typeof receipt.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.payloadHash)
  ) {
    throw providerError('accepted receipt fields are invalid');
  }
}

function assertRejected(rejection) {
  if (!hasExactFields(rejection, REJECTED_FIELDS)) {
    throw providerError('rejected operation must use the closed V1 schema');
  }
  if (
    typeof rejection.opId !== 'string' || rejection.opId.length === 0 ||
    typeof rejection.code !== 'string' || rejection.code.length === 0
  ) {
    throw providerError('rejected operation fields are invalid');
  }
}

function assertConflict(conflict) {
  if (!hasExactFields(conflict, CONFLICT_FIELDS)) {
    throw providerError('conflict result must use the closed V1 schema');
  }
  if (typeof conflict.opId !== 'string' || conflict.opId.length === 0) {
    throw providerError('conflict opId is invalid');
  }
  mapRemoteChange(conflict.remote);
}

function assertPushResult(result) {
  if (!hasExactFields(result, PUSH_RESULT_FIELDS)) {
    throw providerError('push result must use the closed V1 schema');
  }
  if (!Array.isArray(result.accepted) || !Array.isArray(result.rejected) || !Array.isArray(result.conflicts)) {
    throw providerError('push result collections are invalid');
  }
  result.accepted.forEach(assertAccepted);
  result.rejected.forEach(assertRejected);
  result.conflicts.forEach(assertConflict);
  const opIds = [
    ...result.accepted.map(({ opId }) => opId),
    ...result.rejected.map(({ opId }) => opId),
    ...result.conflicts.map(({ opId }) => opId)
  ];
  if (new Set(opIds).size !== opIds.length) {
    throw providerError('push result cannot classify one opId more than once');
  }
  return result;
}

function assertPullResult(result) {
  if (!hasExactFields(result, PULL_RESULT_FIELDS)) {
    throw providerError('pull result must use the closed V1 schema');
  }
  if (!Array.isArray(result.changes) || typeof result.hasMore !== 'boolean') {
    throw providerError('pull result fields are invalid');
  }
  assertCursor(result.nextCursor, 'pull nextCursor');
  result.changes.forEach(mapRemoteChange);
  return result;
}

function assertPurgeResult(result) {
  if (!hasExactFields(result, PURGE_RESULT_FIELDS)) {
    throw providerError('purge result must use the closed V1 schema');
  }
  assertNonNegativeSafeInteger(result.purgedAt, 'purge purgedAt');
  return result;
}

function assertExactRequest(request, fields, label) {
  if (!hasExactFields(request, fields)) {
    throw providerError(`${label} request must use the closed V1 schema`, 'REMOTE_SYNC_REQUEST_INVALID');
  }
}

function parseCursor(cursor, changeCount) {
  if (cursor === null) return 0;
  if (typeof cursor !== 'string' || !/^cursor_(0|[1-9]\d*)$/.test(cursor)) {
    throw providerError('pull cursor is invalid', 'REMOTE_SYNC_REQUEST_INVALID');
  }
  const offset = Number(cursor.slice('cursor_'.length));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > changeCount) {
    throw providerError('pull cursor is out of range', 'REMOTE_SYNC_REQUEST_INVALID');
  }
  return offset;
}

function operationIdentity(operation) {
  return JSON.stringify({
    opId: operation.opId,
    deviceId: operation.deviceId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    action: operation.action,
    baseServerRevision: operation.baseServerRevision,
    payload: operation.payload,
    createdAt: operation.createdAt
  });
}

function createDeterministicRemoteSyncProvider({
  ownerId = 'owner_fake',
  now = Date.now
} = {}) {
  if (typeof ownerId !== 'string' || ownerId.length === 0 || typeof now !== 'function') {
    throw providerError('fake provider options are invalid', 'REMOTE_SYNC_PROVIDER_INVALID');
  }
  const changes = [];
  const receipts = new Map();
  const identities = new Map();
  const revisions = new Map();
  const entities = new Map();
  const dispositions = new Map();
  const calls = { bootstrap: [], push: [], pull: [], purge: [] };
  let loseNextPush = false;

  const provider = {
    calls,

    rejectOperation(opId, code = 'REMOTE_REJECTED') {
      dispositions.set(opId, { status: 'rejected', code });
    },

    conflictOperation(opId, remote) {
      mapRemoteChange(remote);
      dispositions.set(opId, { status: 'conflict', remote: cloneJson(remote) });
    },

    loseNextPushResponse() {
      loseNextPush = true;
    },

    async bootstrap(request) {
      assertExactRequest(request, ['deviceId'], 'bootstrap');
      if (typeof request.deviceId !== 'string' || request.deviceId.length === 0) {
        throw providerError('bootstrap deviceId is invalid', 'REMOTE_SYNC_REQUEST_INVALID');
      }
      calls.bootstrap.push(cloneJson(request));
      const result = { cursor: changes.length === 0 ? null : `cursor_${changes.length}`, serverTime: now() };
      assertBootstrapResult(result);
      return cloneJson(result);
    },

    async push(request) {
      assertExactRequest(request, ['operations'], 'push');
      if (!Array.isArray(request.operations)) {
        throw providerError('push operations must be an array', 'REMOTE_SYNC_REQUEST_INVALID');
      }
      request.operations.forEach(assertSyncOperation);
      calls.push.push(cloneJson(request));
      const result = { accepted: [], rejected: [], conflicts: [] };
      for (const operation of request.operations) {
        const disposition = dispositions.get(operation.opId) || null;
        if (disposition && disposition.status === 'rejected') {
          result.rejected.push({ opId: operation.opId, code: disposition.code });
          continue;
        }
        if (disposition && disposition.status === 'conflict') {
          result.conflicts.push({ opId: operation.opId, remote: cloneJson(disposition.remote) });
          continue;
        }

        const identity = operationIdentity(operation);
        if (receipts.has(operation.opId)) {
          if (identities.get(operation.opId) !== identity) {
            throw providerError('opId was reused for another mutation', 'REMOTE_SYNC_IDEMPOTENCY_CONFLICT');
          }
          result.accepted.push(cloneJson(receipts.get(operation.opId)));
          continue;
        }

        const key = entityKey(operation.entityType, operation.entityId);
        const serverRevision = (revisions.get(key) || 0) + 1;
        revisions.set(key, serverRevision);
        const timestamp = now();
        const previous = entities.get(key) || null;
        let payload = operation.action === 'delete' ? null : cloneJson(operation.payload);
        if (operation.entityType === ENTITY_TYPES.USER_SETTINGS && operation.action === 'upsert') {
          const previousSettings = previous && !previous.deleted
            ? previous.payload
            : DEFAULT_USER_SETTINGS;
          payload = {
            ...cloneJson(previousSettings),
            ...cloneJson(operation.payload),
            schemaVersion: DEFAULT_USER_SETTINGS.schemaVersion,
            revision: previousSettings.revision + 1
          };
        }
        const remote = {
          ownerId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          serverRevision,
          schemaVersion: 1,
          payload,
          deleted: operation.action === 'delete',
          deletedAt: operation.action === 'delete' ? timestamp : null,
          createdAt: previous ? previous.createdAt : timestamp,
          updatedAt: timestamp,
          sourceDeviceId: operation.deviceId
        };
        const mapped = mapRemoteChange(remote);
        const receipt = {
          opId: operation.opId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          serverRevision,
          payloadHash: mapped.payloadHash
        };
        identities.set(operation.opId, identity);
        receipts.set(operation.opId, cloneJson(receipt));
        entities.set(key, cloneJson(remote));
        changes.push(cloneJson(remote));
        result.accepted.push(receipt);
      }
      assertPushResult(result);
      if (loseNextPush) {
        loseNextPush = false;
        throw providerError('fake provider lost the accepted push response', 'SYNC_RESPONSE_LOST');
      }
      return cloneJson(result);
    },

    async pull(request) {
      assertExactRequest(request, ['cursor', 'limit'], 'pull');
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw providerError('pull limit is invalid', 'REMOTE_SYNC_REQUEST_INVALID');
      }
      const offset = parseCursor(request.cursor, changes.length);
      calls.pull.push(cloneJson(request));
      const rawPage = changes.slice(offset, offset + request.limit);
      const latestByEntity = new Map();
      rawPage.forEach((change, index) => {
        latestByEntity.set(entityKey(change.entityType, change.entityId), { change, index });
      });
      const page = [...latestByEntity.values()]
        .sort((left, right) => left.index - right.index)
        .map(({ change }) => cloneJson(change));
      const nextOffset = offset + rawPage.length;
      const result = {
        changes: page,
        nextCursor: nextOffset === 0 ? null : `cursor_${nextOffset}`,
        hasMore: nextOffset < changes.length
      };
      assertPullResult(result);
      return cloneJson(result);
    },

    async purge(request) {
      assertExactRequest(request, ['confirmationToken'], 'purge');
      if (typeof request.confirmationToken !== 'string' || request.confirmationToken.length === 0) {
        throw providerError('purge confirmationToken is invalid', 'REMOTE_SYNC_REQUEST_INVALID');
      }
      calls.purge.push({ confirmationToken: '[redacted]' });
      changes.length = 0;
      receipts.clear();
      identities.clear();
      revisions.clear();
      entities.clear();
      dispositions.clear();
      const result = { purgedAt: now() };
      assertPurgeResult(result);
      return result;
    }
  };

  return provider;
}

module.exports = {
  assertBootstrapResult,
  assertPullResult,
  assertPurgeResult,
  assertPushResult,
  assertRemoteSyncProvider,
  createDeterministicRemoteSyncProvider
};
