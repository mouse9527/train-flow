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

function assertConfirmationCommand(command, label) {
  if (!hasExactFields(command, ['confirmationId'])) {
    throw applicationError(`${label} command must use the closed V1 schema`);
  }
  if (typeof command.confirmationId !== 'string' || command.confirmationId.length === 0) {
    throw applicationError(`${label} confirmationId is invalid`);
  }
  return command;
}

function assertRetryCommand(command) {
  if (!hasExactFields(command, ['source']) || !['manual', 'automatic'].includes(command.source)) {
    throw applicationError('retry command must use the closed V1 schema');
  }
  return command;
}

function assertResolveConflictCommand(command) {
  if (!hasExactFields(command, ['conflictId', 'action'])) {
    throw applicationError('resolveConflict command must use the closed V1 schema');
  }
  if (
    typeof command.conflictId !== 'string' || command.conflictId.length === 0 ||
    !['keep_remote', 'keep_local_as_copy', 'rebase'].includes(command.action)
  ) {
    throw applicationError('resolveConflict command is invalid');
  }
  return command;
}

function assertSyncService(syncService) {
  if (!syncService || typeof syncService !== 'object' || Array.isArray(syncService)) {
    throw applicationError('createSyncApplicationService requires a SyncService');
  }
  for (const method of [
    'bootstrap',
    'getSanitizedState',
    'previewEnable',
    'pushPending',
    'pullNextPage',
    'prepareRemotePurge',
    'purgeRemote',
    'recordFailure',
    'resolveConflict',
    'setEnabled'
  ]) {
    if (typeof syncService[method] !== 'function') {
      throw applicationError(`SyncService requires ${method}()`);
    }
  }
}

function createSyncApplicationService({ syncService } = {}) {
  assertSyncService(syncService);
  let inFlight = false;
  let phase = 'idle';
  let enableSequence = 0;
  const enableConfirmations = new Map();

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

  async function synchronizeCore({ pullLimit = 50, maxPullPages = 20 } = {}) {
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
  }

  async function runRecoverableSync() {
    phase = 'syncing';
    try {
      await syncService.bootstrap();
      const result = await synchronizeCore();
      return { ok: true, result, state: syncService.getSanitizedState({ phase: 'idle' }) };
    } catch (error) {
      return { ok: false, state: syncService.recordFailure(error) };
    } finally {
      phase = 'idle';
    }
  }

  return {
    getState() {
      return syncService.getSanitizedState({ phase });
    },

    prepareEnable(command) {
      assertEmptyCommand(command, 'prepareEnable');
      const preview = syncService.previewEnable();
      if (
        !preview ||
        !Number.isSafeInteger(preview.baselineLocalRevision) || preview.baselineLocalRevision < 0 ||
        typeof preview.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(preview.previewToken)
      ) {
        throw applicationError('SyncService enable preview is invalid', 'SYNC_ENABLE_PREVIEW_INVALID');
      }
      enableSequence += 1;
      const confirmationId = `sync_enable_${preview.baselineLocalRevision}_${enableSequence}`;
      enableConfirmations.clear();
      enableConfirmations.set(confirmationId, {
        expectedLocalRevision: preview.baselineLocalRevision,
        previewToken: preview.previewToken
      });
      return {
        confirmationId,
        scope: preview.scope,
        warning: '将把本机计划、训练记录和设置加入云端同步；本机仍是训练入口。'
      };
    },

    confirmEnable(command) {
      const validated = assertConfirmationCommand(command, 'confirmEnable');
      const confirmation = enableConfirmations.get(validated.confirmationId);
      if (!confirmation) {
        throw applicationError('confirmEnable confirmation is missing', 'SYNC_CONFIRMATION_INVALID');
      }
      enableConfirmations.delete(validated.confirmationId);
      return runExclusive(async () => {
        syncService.setEnabled({
          enabled: true,
          expectedLocalRevision: confirmation.expectedLocalRevision,
          previewToken: confirmation.previewToken
        });
        return runRecoverableSync();
      });
    },

    disable(command) {
      assertEmptyCommand(command, 'disable');
      return runExclusive(() => {
        const preview = syncService.previewEnable();
        syncService.setEnabled({
          enabled: false,
          expectedLocalRevision: preview.baselineLocalRevision
        });
        return { ok: true, state: syncService.getSanitizedState({ phase: 'idle' }) };
      });
    },

    retry(command) {
      assertRetryCommand(command);
      return runExclusive(() => {
        const state = syncService.getSanitizedState({ phase: 'idle' });
        if (!state.enabled) return { ok: true, skipped: 'disabled', state };
        return runRecoverableSync();
      });
    },

    resolveConflict(command) {
      const validated = assertResolveConflictCommand(command);
      return runExclusive(() => syncService.resolveConflict(validated));
    },

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
      return runExclusive(() => synchronizeCore({ pullLimit, maxPullPages }));
    }
  };
}

module.exports = { createSyncApplicationService };
