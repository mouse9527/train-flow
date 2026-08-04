function applicationError(message, code = 'SYNC_APPLICATION_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasExactFields(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable === true && 'value' in descriptor;
  });
}

function hasAllowedFields(value, allowedFields) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => {
    if (typeof key !== 'string' || !allowedFields.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable === true && 'value' in descriptor;
  });
}

function assertEmptyCommand(command, label) {
  const value = command === undefined ? {} : command;
  if (!hasExactFields(value, [])) {
    throw applicationError(`${label} command must use the closed V1 schema`);
  }
  return value;
}

function assertPurgeCommand(command) {
  if (!hasExactFields(command, ['confirmationToken'])) {
    throw applicationError('purgeRemote command must use the closed V1 schema');
  }
  if (typeof command.confirmationToken !== 'string' || command.confirmationToken.length === 0) {
    throw applicationError('purgeRemote confirmationToken is invalid');
  }
  return command;
}

function assertSynchronizeCommand(command) {
  const value = command === undefined ? {} : command;
  if (!hasAllowedFields(value, ['maxPullPages', 'pullLimit'])) {
    throw applicationError('synchronizeOnce command must use the closed V1 schema');
  }
  const pullLimit = Object.prototype.hasOwnProperty.call(value, 'pullLimit') ? value.pullLimit : 50;
  const maxPullPages = Object.prototype.hasOwnProperty.call(value, 'maxPullPages')
    ? value.maxPullPages
    : 20;
  if (!Number.isSafeInteger(pullLimit) || pullLimit < 1 || pullLimit > 100) {
    throw applicationError('synchronizeOnce pullLimit must be an integer from 1 to 100');
  }
  if (!Number.isSafeInteger(maxPullPages) || maxPullPages < 1 || maxPullPages > 100) {
    throw applicationError('synchronizeOnce maxPullPages must be an integer from 1 to 100');
  }
  return { pullLimit, maxPullPages };
}

function assertSyncService(syncService) {
  if (!syncService || typeof syncService !== 'object' || Array.isArray(syncService)) {
    throw applicationError('createSyncApplicationService requires a SyncService');
  }
  for (const method of [
    'bootstrap',
    'pushPending',
    'pullNextPage',
    'prepareRemotePurge',
    'purgeRemote'
  ]) {
    if (typeof syncService[method] !== 'function') {
      throw applicationError(`SyncService requires ${method}()`);
    }
  }
}

function createSyncApplicationService({ syncService } = {}) {
  assertSyncService(syncService);
  let inFlight = false;

  async function runExclusive(task) {
    if (inFlight) {
      throw applicationError('a sync command is already in progress', 'SYNC_APPLICATION_BUSY');
    }
    inFlight = true;
    try {
      return await task();
    } finally {
      inFlight = false;
    }
  }

  return {
    bootstrap(command) {
      assertEmptyCommand(command, 'bootstrap');
      return runExclusive(() => syncService.bootstrap());
    },

    pushPending(command) {
      assertEmptyCommand(command, 'pushPending');
      return runExclusive(() => syncService.pushPending());
    },

    pullNextPage(command) {
      if (!hasExactFields(command, ['limit'])) {
        throw applicationError('pullNextPage command must use the closed V1 schema');
      }
      if (!Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 100) {
        throw applicationError('pullNextPage limit must be an integer from 1 to 100');
      }
      return runExclusive(() => syncService.pullNextPage({ limit: command.limit }));
    },

    purgeRemote(command) {
      const validated = assertPurgeCommand(command);
      return runExclusive(() => syncService.purgeRemote({
        confirmationToken: validated.confirmationToken
      }));
    },

    prepareRemotePurge(command) {
      assertEmptyCommand(command, 'prepareRemotePurge');
      return runExclusive(() => syncService.prepareRemotePurge());
    },

    synchronizeOnce(command) {
      const { pullLimit, maxPullPages } = assertSynchronizeCommand(command);
      return runExclusive(async () => {
        const push = await syncService.pushPending();
        const pullPages = [];
        let previousCursor;
        for (let pageNumber = 0; pageNumber < maxPullPages; pageNumber += 1) {
          const page = await syncService.pullNextPage({ limit: pullLimit });
          pullPages.push(page);
          if (!page.hasMore) return { push, pullPages };
          if (page.nextCursor === previousCursor) {
            throw applicationError('pull cursor did not advance', 'SYNC_CURSOR_STALLED');
          }
          previousCursor = page.nextCursor;
        }
        throw applicationError('synchronizeOnce exceeded maxPullPages', 'SYNC_PAGE_LIMIT_EXCEEDED');
      });
    }
  };
}

module.exports = { createSyncApplicationService };
