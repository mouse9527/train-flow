const { randomBytes } = require('node:crypto');

const {
  createCloudSyncHandlers,
  sha256
} = require('./index');

const COLLECTIONS = Object.freeze({
  accounts: 'tf_accounts',
  entities: 'tf_entities',
  operations: 'tf_operations',
  changes: 'tf_changes',
  purgeConfirmations: 'tf_purge_confirmations',
  purgeReceipts: 'tf_purge_receipts'
});
const PUBLIC_ERROR_CODES = new Set([
  'ACCOUNT_UNAVAILABLE',
  'CLOUD_SYNC_REQUEST_INVALID',
  'CLOUD_SYNC_UNAVAILABLE',
  'CURSOR_INVALID',
  'PURGE_CONFIRMATION_INVALID',
  'SYNC_ENTITY_ID_MISMATCH',
  'SYNC_OPERATION_INVALID',
  'SYNC_PAYLOAD_INVALID',
  'SYNC_PAYLOAD_TOO_LARGE',
  'SYNC_TOMBSTONE_PAYLOAD_INVALID'
]);

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function documentId(scope, ...parts) {
  return `${scope}_${sha256(JSON.stringify(parts))}`;
}

function dataFrom(result) {
  if (!result || !result.data) return null;
  const { _id: _documentId, ...data } = result.data;
  return data;
}

function isMissingDocument(error) {
  return Boolean(error && (
    error.errCode === -1 ||
    error.code === 'DATABASE_DOCUMENT_NOT_FOUND' ||
    /not\s*found|does not exist/i.test(String(error.message || ''))
  ));
}

async function readDocument(database, collectionName, id) {
  try {
    return dataFrom(await database.collection(collectionName).doc(id).get());
  } catch (error) {
    if (isMissingDocument(error)) return null;
    throw error;
  }
}

function writeDocument(database, collectionName, id, data) {
  return database.collection(collectionName).doc(id).set({ data });
}

function createTransactionAdapter(transaction) {
  return {
    getAccount(ownerId) {
      return readDocument(transaction, COLLECTIONS.accounts, documentId('account', ownerId));
    },
    putAccount(account) {
      return writeDocument(
        transaction,
        COLLECTIONS.accounts,
        documentId('account', account.ownerId),
        account
      );
    },
    getOperation(ownerId, opId) {
      return readDocument(
        transaction,
        COLLECTIONS.operations,
        documentId('operation', ownerId, opId)
      );
    },
    putOperation(operation) {
      return writeDocument(
        transaction,
        COLLECTIONS.operations,
        documentId('operation', operation.ownerId, operation.opId),
        operation
      );
    },
    getEntity(ownerId, entityType, entityId) {
      return readDocument(
        transaction,
        COLLECTIONS.entities,
        documentId('entity', ownerId, entityType, entityId)
      );
    },
    putEntity(entity) {
      return writeDocument(
        transaction,
        COLLECTIONS.entities,
        documentId('entity', entity.ownerId, entity.entityType, entity.entityId),
        entity
      );
    },
    appendChange(change) {
      return writeDocument(
        transaction,
        COLLECTIONS.changes,
        documentId('change', change.ownerId, change.epoch, change.sequence),
        change
      );
    }
  };
}

async function removeOwnerDocuments(database, collectionName, ownerId) {
  while (true) {
    const result = await database.collection(collectionName)
      .where({ ownerId })
      .limit(100)
      .get();
    const documents = result && Array.isArray(result.data) ? result.data : [];
    if (documents.length === 0) return;
    for (const document of documents) {
      if (!document || typeof document._id !== 'string') {
        throw runtimeError('CLOUD_SYNC_STORAGE_INVALID', 'Cloud sync storage is invalid');
      }
      await database.collection(collectionName).doc(document._id).remove();
    }
  }
}

function createCloudBaseStore(database) {
  const command = database.command;
  return {
    runTransaction(work) {
      return database.runTransaction((transaction) => work(createTransactionAdapter(transaction)));
    },

    async bootstrapOwner({ ownerId, now }) {
      await database.runTransaction(async (transaction) => {
        const adapter = createTransactionAdapter(transaction);
        const current = await adapter.getAccount(ownerId);
        if (current && current.status === 'purging') {
          throw runtimeError('ACCOUNT_UNAVAILABLE', 'Cloud sync account is unavailable');
        }
        if (!current || current.status === 'purged') {
          await adapter.putAccount({
            ownerId,
            status: 'active',
            epoch: current ? current.epoch + 1 : 1,
            sequence: 0,
            createdAt: current ? current.createdAt : now,
            updatedAt: now
          });
        }
      });
      return { cursor: null };
    },

    async getOwnerSyncState(ownerId) {
      const account = await readDocument(
        database,
        COLLECTIONS.accounts,
        documentId('account', ownerId)
      );
      return account ? {
        status: account.status,
        epoch: account.epoch,
        sequence: account.sequence
      } : null;
    },

    async listChanges({ ownerId, epoch, afterSequence, limit }) {
      const result = await database.collection(COLLECTIONS.changes)
        .where({
          ownerId,
          epoch,
          sequence: command.gt(afterSequence)
        })
        .orderBy('sequence', 'asc')
        .limit(limit + 1)
        .get();
      const rows = result && Array.isArray(result.data) ? result.data : [];
      return {
        changes: rows.slice(0, limit),
        hasMore: rows.length > limit
      };
    },

    preparePurge(confirmation) {
      return writeDocument(
        database,
        COLLECTIONS.purgeConfirmations,
        documentId('purge-confirmation', confirmation.ownerId, confirmation.tokenHash),
        { ...confirmation, status: 'prepared' }
      );
    },

    async confirmPurge({ ownerId, deviceId, purpose, tokenHash, now }) {
      const confirmationId = documentId('purge-confirmation', ownerId, tokenHash);
      const receiptId = documentId('purge-receipt', ownerId, tokenHash);
      const phase = await database.runTransaction(async (transaction) => {
        const existingReceipt = await readDocument(
          transaction,
          COLLECTIONS.purgeReceipts,
          receiptId
        );
        if (existingReceipt) {
          if (
            existingReceipt.ownerId !== ownerId || existingReceipt.deviceId !== deviceId ||
            existingReceipt.purpose !== purpose || existingReceipt.tokenHash !== tokenHash
          ) {
            throw runtimeError('PURGE_CONFIRMATION_INVALID', 'Purge confirmation is invalid');
          }
          return { status: 'done', receipt: existingReceipt };
        }
        const confirmation = await readDocument(
          transaction,
          COLLECTIONS.purgeConfirmations,
          confirmationId
        );
        if (
          !confirmation || confirmation.ownerId !== ownerId ||
          confirmation.deviceId !== deviceId || confirmation.purpose !== purpose ||
          !['prepared', 'purging'].includes(confirmation.status) ||
          (confirmation.status === 'prepared' && confirmation.expiresAt <= now)
        ) {
          throw runtimeError('PURGE_CONFIRMATION_INVALID', 'Purge confirmation is invalid');
        }
        const adapter = createTransactionAdapter(transaction);
        const account = await adapter.getAccount(ownerId);
        const nextAccount = account || {
          ownerId,
          status: 'active',
          epoch: 1,
          sequence: 0,
          createdAt: now,
          updatedAt: now
        };
        if (confirmation.status === 'prepared') nextAccount.epoch += 1;
        nextAccount.status = 'purging';
        nextAccount.updatedAt = now;
        await adapter.putAccount(nextAccount);
        await writeDocument(transaction, COLLECTIONS.purgeConfirmations, confirmationId, {
          ...confirmation,
          status: 'purging',
          consumedAt: confirmation.consumedAt || now
        });
        return { status: 'purging' };
      });
      if (phase.status === 'done') return { purgedAt: phase.receipt.purgedAt };

      for (const collectionName of [
        COLLECTIONS.entities,
        COLLECTIONS.operations,
        COLLECTIONS.changes
      ]) {
        await removeOwnerDocuments(database, collectionName, ownerId);
      }

      return database.runTransaction(async (transaction) => {
        const existingReceipt = await readDocument(
          transaction,
          COLLECTIONS.purgeReceipts,
          receiptId
        );
        if (existingReceipt) return { purgedAt: existingReceipt.purgedAt };
        const confirmation = await readDocument(
          transaction,
          COLLECTIONS.purgeConfirmations,
          confirmationId
        );
        if (!confirmation || confirmation.status !== 'purging') {
          throw runtimeError('PURGE_CONFIRMATION_INVALID', 'Purge confirmation is invalid');
        }
        const adapter = createTransactionAdapter(transaction);
        const account = await adapter.getAccount(ownerId);
        if (!account || account.status !== 'purging') {
          throw runtimeError('PURGE_CONFIRMATION_INVALID', 'Purge confirmation is invalid');
        }
        const receipt = {
          ownerId,
          deviceId,
          purpose,
          tokenHash,
          receiptId,
          purgedAt: now
        };
        await writeDocument(transaction, COLLECTIONS.purgeReceipts, receiptId, receipt);
        await writeDocument(transaction, COLLECTIONS.purgeConfirmations, confirmationId, {
          ...confirmation,
          status: 'consumed',
          completedAt: now
        });
        await adapter.putAccount({
          ...account,
          status: 'purged',
          sequence: 0,
          updatedAt: now
        });
        return { purgedAt: now };
      });
    }
  };
}

function publicError(error) {
  if (error && PUBLIC_ERROR_CODES.has(error.code)) return error;
  return runtimeError('CLOUD_SYNC_FAILED', 'Cloud sync request failed');
}

function createCloudBaseRuntime({
  cloud = require('wx-server-sdk'),
  env = process.env,
  now = Date.now,
  logger = console
} = {}) {
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  const store = createCloudBaseStore(cloud.database());
  return {
    createHandlers() {
      return createCloudSyncHandlers({
        getTrustedContext: () => cloud.getWXContext(),
        store,
        env,
        now,
        randomBytes,
        logger
      });
    }
  };
}

async function invokeCloudFunction(functionName, event) {
  try {
    const handlers = createCloudBaseRuntime().createHandlers();
    if (typeof handlers[functionName] !== 'function') {
      throw runtimeError('CLOUD_SYNC_CONFIGURATION_INVALID', 'Cloud sync configuration is invalid');
    }
    return await handlers[functionName](event);
  } catch (error) {
    throw publicError(error);
  }
}

module.exports = {
  COLLECTIONS,
  createCloudBaseRuntime,
  createCloudBaseStore,
  invokeCloudFunction
};
