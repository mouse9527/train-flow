const { assertSyncOperation } = require('../domain/sync/sync-operation');
const {
  assertBootstrapResult,
  assertPullResult,
  assertPurgePreparationResult,
  assertPurgeResult,
  assertPushResult
} = require('./remote-sync-provider');

function providerError(message, code = 'CLOUD_SYNC_CLIENT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactFields(value, fields) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertDeviceRequest(request, label) {
  if (
    !hasExactFields(request, ['deviceId']) ||
    typeof request.deviceId !== 'string' ||
    request.deviceId.length === 0
  ) {
    throw providerError(`${label} request is invalid`, 'REMOTE_SYNC_REQUEST_INVALID');
  }
}

function createCloudBaseSyncProvider({ wx: wxApi } = {}) {
  if (
    !wxApi || !wxApi.cloud || typeof wxApi.cloud.callFunction !== 'function'
  ) {
    throw providerError('CloudBase callable functions are unavailable', 'CLOUD_SYNC_UNAVAILABLE');
  }

  async function call(name, data) {
    const response = await wxApi.cloud.callFunction({ name, data: cloneJson(data) });
    if (!response || typeof response !== 'object' || !Object.prototype.hasOwnProperty.call(response, 'result')) {
      throw providerError('CloudBase callable response is invalid', 'CLOUD_SYNC_UNAVAILABLE');
    }
    return cloneJson(response.result);
  }

  return {
    async bootstrap(request) {
      assertDeviceRequest(request, 'bootstrap');
      const result = await call('authBootstrap', {
        deviceId: request.deviceId,
        schemaVersion: 1
      });
      assertBootstrapResult(result);
      return result;
    },

    async push(request) {
      if (!hasExactFields(request, ['operations']) || !Array.isArray(request.operations)) {
        throw providerError('push request is invalid', 'REMOTE_SYNC_REQUEST_INVALID');
      }
      request.operations.forEach(assertSyncOperation);
      const result = await call('syncPush', { operations: request.operations });
      assertPushResult(result);
      return result;
    },

    async pull(request) {
      if (
        !hasExactFields(request, ['cursor', 'limit']) ||
        (request.cursor !== null && (typeof request.cursor !== 'string' || request.cursor.length === 0)) ||
        !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100
      ) {
        throw providerError('pull request is invalid', 'REMOTE_SYNC_REQUEST_INVALID');
      }
      const result = await call('syncPull', request);
      assertPullResult(result);
      return result;
    },

    async preparePurge(request) {
      assertDeviceRequest(request, 'preparePurge');
      const result = await call('accountPurge', {
        action: 'prepare',
        deviceId: request.deviceId
      });
      assertPurgePreparationResult(result);
      return result;
    },

    async purge(request) {
      if (
        !hasExactFields(request, ['deviceId', 'confirmationToken']) ||
        typeof request.deviceId !== 'string' || request.deviceId.length === 0 ||
        typeof request.confirmationToken !== 'string' || request.confirmationToken.length === 0
      ) {
        throw providerError('purge request is invalid', 'REMOTE_SYNC_REQUEST_INVALID');
      }
      const result = await call('accountPurge', {
        action: 'confirm',
        deviceId: request.deviceId,
        confirmationToken: request.confirmationToken
      });
      assertPurgeResult(result);
      return result;
    }
  };
}

module.exports = {
  assertPurgePreparationResult,
  createCloudBaseSyncProvider
};
