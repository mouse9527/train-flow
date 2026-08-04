# TrainFlow CloudBase sync functions

These functions are the only trusted path to the remote TrainFlow collections.
The Mini Program must not call `wx.cloud.database()` for these collections.
Caller identity comes from `cloud.getWXContext().OPENID` inside each invocation;
an `ownerId`, OpenID, revision or timestamp supplied by the client is never an
authorization fact.

## Secret configuration

Copy `.env.example` only as a list of variable names. Configure real values in
the CloudBase function environment (or another deployment Secret store), never
in Git, `cloudbaserc.json`, screenshots or logs.

- `TRAINFLOW_ALLOWED_OPENID_SHA256`: comma-separated SHA-256 hashes of allowed
  OpenIDs. This private deployment normally contains one hash.
- `TRAINFLOW_OWNER_HMAC_KEY`: at least 32 bytes; derives the opaque server owner.
- `TRAINFLOW_CURSOR_HMAC_KEY`: at least 32 bytes; encrypts/authenticates cursors.
- `TRAINFLOW_PURGE_HMAC_KEY`: at least 32 bytes; authenticates purge confirmation.
- `TRAINFLOW_PURGE_TTL_SECONDS`: integer from 30 through 900; `300` is recommended.

Do not print any of these values. Logs must also omit OpenID, ownerId, deviceId,
cursor, confirmation token and operation/domain payload.

## Collections and indexes

Create these server-only collections before deployment:

| Collection | Required key/index |
| --- | --- |
| `tf_accounts` | unique `ownerId` |
| `tf_entities` | unique `ownerId + entityType + entityId` |
| `tf_operations` | unique `ownerId + opId` |
| `tf_changes` | unique `ownerId + epoch + sequence`; query index in that order |
| `tf_purge_confirmations` | unique `ownerId + tokenHash` |
| `tf_purge_receipts` | unique `ownerId + receiptId` |

`cloudbase/database.rules.json` is the auditable source of truth for direct
client access. For every listed collection, apply the CloudBase rule body
`read: false` and `write: false` in the console or deployment automation. Cloud
functions retain server-side access; Mini Program clients receive none.

## Prepare and deploy

CloudBase uploads each function directory independently, so a sibling
`../shared` import would be missing at runtime. The canonical source lives in
`cloudfunctions/shared/`; materialize it into each deployable function package:

```sh
npm run cloud:prepare
```

The command creates `cloudfunctions/<name>/_shared/` for `authBootstrap`,
`syncPush`, `syncPull` and `accountPurge`. Generated copies are ignored by Git.
Review the printed SHA-256 digest, then use WeChat DevTools “上传并部署：云端安装依赖”
for each function. Every package pins stable `wx-server-sdk` `4.0.2` and overrides
fixed `axios` / `lodash.unset` releases. `npm audit --omit=dev` reports four HIGH
package entries propagated from one root advisory, `GHSA-p6mc-m468-83gw`, because
`@cloudbase/database` depends on `lodash.set` `4.3.2` and no fixed release exists.
That call is confined to CloudBase realtime/watch `updatedFields` merging;
TrainFlow exposes no `.watch()` path and rejects prototype keys at its request
boundary. Keep the lock files, block any future watch usage until the advisory is
fixed, and re-audit on every CloudBase dependency change. Do not override
`@cloudbase/node-sdk` across its major version merely to clear audit: the 4.x tree
requires a newer Node dependency/runtime contract that is not verified for this
deployment.

## Runtime contracts

- `authBootstrap({ deviceId, schemaVersion: 1 })` returns the current server time
  and a null initial cursor, causing a new device to pull authoritative history.
- `syncPush({ operations })` first validates closed V1 plan/record/settings wire
  schemas and rejects duplicate request `opId` values before any write, then runs
  one transaction per operation. The same `ownerId + opId` and semantic request
  replays its receipt; a changed request is rejected. Entity/tombstone, receipt
  and change feed are all-or-nothing.
- `syncPull({ cursor, limit })` queries `ownerId + epoch + sequence`, coalesces
  repeated entity revisions in the raw page and returns a new opaque cursor.
- `accountPurge` is two-stage. `prepare` creates a short-lived confirmation bound
  to owner, device and purpose. `confirm` consumes it, blocks sync with a
  `purging` account state, deletes owner-scoped data in restartable batches, and
  returns only `{ purgedAt }`. Replaying a completed confirmation returns the same
  payload-free receipt.

The offline test suite injects trusted context and database adapters. It never
requires a real CloudBase account or credential:

```sh
node --test tests/cloudfunctions/cloud-sync-security.test.js
```

References: [CloudBase database security rules](https://docs.cloudbase.net/database/security-rules),
[CloudBase secret handling](https://docs.cloudbase.net/recipes/secure-secrets-in-cloud-function),
and [WeChat `getWXContext`](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/utils/Cloud.getWXContext.html).
