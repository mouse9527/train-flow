function stateKey(...parts) {
  return JSON.stringify(parts);
}

function createCloudSyncStoreDouble({ retryCallbacks = 0, failBeforeCommit = 0 } = {}) {
  let state = {
    accounts: {},
    entities: {},
    operations: {},
    changes: [],
    purgeConfirmations: {},
    purgeReceipts: {}
  };
  let queue = Promise.resolve();

  function transactionFor(draft) {
    return {
      getAccount(ownerId) {
        return structuredClone(draft.accounts[ownerId] || null);
      },
      putAccount(account) {
        draft.accounts[account.ownerId] = structuredClone(account);
      },
      getOperation(ownerId, opId) {
        return structuredClone(draft.operations[stateKey(ownerId, opId)] || null);
      },
      putOperation(operation) {
        draft.operations[stateKey(operation.ownerId, operation.opId)] = structuredClone(operation);
      },
      getEntity(ownerId, entityType, entityId) {
        return structuredClone(draft.entities[stateKey(ownerId, entityType, entityId)] || null);
      },
      putEntity(entity) {
        draft.entities[stateKey(entity.ownerId, entity.entityType, entity.entityId)] = structuredClone(entity);
      },
      appendChange(change) {
        draft.changes.push(structuredClone(change));
      }
    };
  }

  const store = {
    async bootstrapOwner({ ownerId, now }) {
      const current = state.accounts[ownerId] || null;
      if (current && current.status === 'purging') {
        const error = new Error('account unavailable');
        error.code = 'ACCOUNT_UNAVAILABLE';
        throw error;
      }
      if (!current || current.status === 'purged') {
        state.accounts[ownerId] = {
          ownerId,
          status: 'active',
          epoch: current ? current.epoch + 1 : 1,
          sequence: 0,
          createdAt: current ? current.createdAt : now,
          updatedAt: now
        };
      }
      return { cursor: null };
    },
    runTransaction(work) {
      const previous = queue;
      let release;
      queue = new Promise((resolve) => { release = resolve; });
      return previous.then(async () => {
        try {
          while (retryCallbacks > 0) {
            retryCallbacks -= 1;
            const discarded = structuredClone(state);
            await work(transactionFor(discarded));
          }
          const draft = structuredClone(state);
          const result = await work(transactionFor(draft));
          if (failBeforeCommit > 0) {
            failBeforeCommit -= 1;
            throw new Error('injected transaction failure');
          }
          state = draft;
          return structuredClone(result);
        } finally {
          release();
        }
      });
    },
    async listChanges({ ownerId, epoch, afterSequence, limit }) {
      const account = state.accounts[ownerId] || null;
      if (!account || account.status !== 'active' || account.epoch !== epoch) {
        const error = new Error('cursor unavailable');
        error.code = 'CURSOR_INVALID';
        throw error;
      }
      const raw = state.changes
        .filter((change) => (
          change.ownerId === ownerId &&
          change.epoch === epoch &&
          change.sequence > afterSequence
        ))
        .sort((left, right) => left.sequence - right.sequence);
      return {
        changes: structuredClone(raw.slice(0, limit)),
        hasMore: raw.length > limit
      };
    },
    async getOwnerSyncState(ownerId) {
      const account = state.accounts[ownerId] || null;
      return account ? {
        status: account.status,
        epoch: account.epoch,
        sequence: account.sequence
      } : null;
    },
    async preparePurge(confirmation) {
      state.purgeConfirmations[stateKey(confirmation.ownerId, confirmation.tokenHash)] =
        structuredClone(confirmation);
    },
    async confirmPurge({ ownerId, deviceId, purpose, tokenHash, now }) {
      const key = stateKey(ownerId, tokenHash);
      const receipt = state.purgeReceipts[key] || null;
      if (receipt) {
        if (receipt.deviceId !== deviceId || receipt.purpose !== purpose) {
          const error = new Error('confirmation invalid');
          error.code = 'PURGE_CONFIRMATION_INVALID';
          throw error;
        }
        return { purgedAt: receipt.purgedAt };
      }
      const confirmation = state.purgeConfirmations[key] || null;
      if (
        !confirmation || confirmation.deviceId !== deviceId ||
        confirmation.purpose !== purpose || confirmation.expiresAt <= now
      ) {
        const error = new Error('confirmation invalid');
        error.code = 'PURGE_CONFIRMATION_INVALID';
        throw error;
      }
      const account = state.accounts[ownerId] || {
        ownerId, status: 'active', epoch: 1, sequence: 0, createdAt: now, updatedAt: now
      };
      account.status = 'purging';
      account.epoch += 1;
      account.updatedAt = now;
      state.accounts[ownerId] = account;
      for (const keyName of Object.keys(state.entities)) {
        if (JSON.parse(keyName)[0] === ownerId) delete state.entities[keyName];
      }
      for (const keyName of Object.keys(state.operations)) {
        if (JSON.parse(keyName)[0] === ownerId) delete state.operations[keyName];
      }
      state.changes = state.changes.filter((change) => change.ownerId !== ownerId);
      delete state.purgeConfirmations[key];
      const result = { ownerId, deviceId, purpose, tokenHash, purgedAt: now };
      state.purgeReceipts[key] = result;
      account.status = 'purged';
      return { purgedAt: result.purgedAt };
    },
    snapshot() {
      return structuredClone(state);
    }
  };
  return store;
}

module.exports = { createCloudSyncStoreDouble };
