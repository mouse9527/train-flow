const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertPurgePreparationResult,
  createCloudBaseSyncProvider
} = require('../../miniprogram/services/cloudbase-sync-provider');
const {
  createDeterministicRemoteSyncProvider
} = require('../../miniprogram/services/remote-sync-provider');

const NOW = 1785719340000;

test('AC1/AC5: CloudBase provider uses only callable functions and a server-issued purge confirmation', async () => {
  const calls = [];
  const responses = {
    authBootstrap: { cursor: null, serverTime: NOW },
    syncPush: { accepted: [], rejected: [], conflicts: [] },
    syncPull: { changes: [], nextCursor: null, hasMore: false },
    accountPurge: null
  };
  const wxApi = {
    cloud: {
      async callFunction(request) {
        calls.push(structuredClone(request));
        if (request.name === 'accountPurge' && request.data.action === 'prepare') {
          return {
            result: {
              confirmationToken: 'purge_v1.server-issued-token',
              expiresAt: NOW + 300000
            }
          };
        }
        if (request.name === 'accountPurge' && request.data.action === 'confirm') {
          return { result: { purgedAt: NOW + 1 } };
        }
        return { result: responses[request.name] };
      }
    }
  };
  const provider = createCloudBaseSyncProvider({ wx: wxApi });

  await provider.bootstrap({ deviceId: 'device_client_boundary' });
  await provider.push({ operations: [] });
  await provider.pull({ cursor: null, limit: 25 });
  const prepared = await provider.preparePurge({ deviceId: 'device_client_boundary' });
  assertPurgePreparationResult(prepared);
  const receipt = await provider.purge({
    deviceId: 'device_client_boundary',
    confirmationToken: prepared.confirmationToken
  });

  assert.deepEqual(receipt, { purgedAt: NOW + 1 });
  assert.deepEqual(calls, [
    { name: 'authBootstrap', data: { deviceId: 'device_client_boundary', schemaVersion: 1 } },
    { name: 'syncPush', data: { operations: [] } },
    { name: 'syncPull', data: { cursor: null, limit: 25 } },
    { name: 'accountPurge', data: { action: 'prepare', deviceId: 'device_client_boundary' } },
    {
      name: 'accountPurge',
      data: {
        action: 'confirm',
        deviceId: 'device_client_boundary',
        confirmationToken: 'purge_v1.server-issued-token'
      }
    }
  ]);
  assert.equal(typeof wxApi.cloud.database, 'undefined', 'client provider must not query CloudBase collections');
});

test('AC5: deterministic provider binds purge confirmation to the requesting device and replays one receipt', async () => {
  const provider = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_fixture_owner',
    now: () => NOW
  });
  const prepared = await provider.preparePurge({ deviceId: 'device_fixture_one' });

  await assert.rejects(
    () => provider.purge({
      deviceId: 'device_fixture_two',
      confirmationToken: prepared.confirmationToken
    }),
    { code: 'PURGE_CONFIRMATION_INVALID' }
  );
  const first = await provider.purge({
    deviceId: 'device_fixture_one',
    confirmationToken: prepared.confirmationToken
  });
  const replay = await provider.purge({
    deviceId: 'device_fixture_one',
    confirmationToken: prepared.confirmationToken
  });

  assert.deepEqual(first, { purgedAt: NOW });
  assert.deepEqual(replay, first);
  assert.deepEqual(provider.calls.purge, [
    { deviceId: 'device_fixture_two', confirmationToken: '[redacted]' },
    { deviceId: 'device_fixture_one', confirmationToken: '[redacted]' },
    { deviceId: 'device_fixture_one', confirmationToken: '[redacted]' }
  ]);
});
