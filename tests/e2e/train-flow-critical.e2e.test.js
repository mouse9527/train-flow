const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FIXED_CLOCK,
  createAnonymousOfflineAdapter
} = require('../fixtures/anonymous/train-flow-critical');
const {
  createPlanApplicationService
} = require('../../miniprogram/application/plan-application-service');
const {
  createRecordApplicationService
} = require('../../miniprogram/application/record-application-service');
const {
  createSettingsDataApplicationService
} = require('../../miniprogram/application/settings-application-service');
const {
  createStatisticsApplicationService
} = require('../../miniprogram/application/statistics-application-service');
const {
  createTimedWorkoutRuntime
} = require('../../miniprogram/application/timed-workout-runtime');
const {
  createWorkoutApplicationService
} = require('../../miniprogram/application/workout-application-service');
const {
  createSyncApplicationService
} = require('../../miniprogram/application/sync-application-service');
const {
  createPlanRepository
} = require('../../miniprogram/domain/planning/plan-repository');
const {
  createTrainingRecordRepository
} = require('../../miniprogram/domain/records/training-record-repository');
const {
  createSettingsRepository
} = require('../../miniprogram/domain/identity-settings/settings-repository');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  ENTITY_TYPES
} = require('../../miniprogram/domain/sync/entity-mapper');
const {
  createCloudBaseSyncProvider
} = require('../../miniprogram/services/cloudbase-sync-provider');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const {
  createDeterministicRemoteSyncProvider
} = require('../../miniprogram/services/remote-sync-provider');
const {
  createLocalStatisticsService
} = require('../../miniprogram/services/statistics-service');
const {
  createSyncService
} = require('../../miniprogram/services/sync-service');
const {
  createCloudSyncHandlers
} = require('../../cloudfunctions/shared');
const {
  createCloudSyncStoreDouble
} = require('../helpers/cloud-sync-store-double');

const ROOT = path.join(__dirname, '..', '..');

function remotePlanEnvelope(plan, nowMs) {
  return {
    ownerId: 'anonymous_remote_owner',
    entityType: ENTITY_TYPES.WORKOUT_PLAN,
    entityId: plan.id,
    serverRevision: 2,
    schemaVersion: 1,
    payload: structuredClone(plan),
    deleted: false,
    deletedAt: null,
    createdAt: nowMs,
    updatedAt: nowMs + 1,
    sourceDeviceId: 'anonymous_remote_device'
  };
}

test('C1 anonymous offline first launch reaches one terminal record and weekly statistics', () => {
  const adapter = createAnonymousOfflineAdapter();
  const database = createLocalDatabase({ storage: adapter, now: () => FIXED_CLOCK.startAt });
  database.commit((draft) => {
    draft.install = { deviceId: 'anonymous_device_critical', createdAt: FIXED_CLOCK.startAt };
  });
  const planRepository = createPlanRepository({ database, now: () => FIXED_CLOCK.startAt });
  const planApplication = createPlanApplicationService({ repository: planRepository });
  const initialized = planApplication.initializeDefaultPlans();
  const sessionRepository = createSessionRepository({ database });
  const workout = createWorkoutApplicationService({
    planRepository,
    sessionRepository,
    deviceId: 'anonymous_device_critical',
    idFactory: () => 'session_critical_offline',
    now: () => FIXED_CLOCK.startAt
  });

  assert.equal(initialized.plans.length, 7);
  let session = workout.startSession({
    planId: 'plan_20260803_builtin',
    commandKey: 'critical:start-session',
    nowMs: FIXED_CLOCK.startAt
  });
  let nowMs = FIXED_CLOCK.startAt;
  let sequence = 0;
  const apply = (type, payload = {}, at = nowMs) => {
    const result = workout.execute({
      type,
      expectedSessionRevision: session.sessionRevision,
      commandKey: `critical:${++sequence}:${type}`,
      nowMs: at,
      payload
    });
    session = result.session;
    nowMs = at;
    return result;
  };

  while (!['completed', 'aborted'].includes(session.status)) {
    const step = session.planSnapshot.steps[session.currentStepIndex];
    if (step.kind === 'timed') {
      apply('start_step', { stepId: step.id });
      apply('checkpoint', { reason: 'hide' }, session.timer.expectedEndAt);
      apply('confirm_next', { stepId: step.id }, session.timer.expiredAt);
      continue;
    }
    if (step.kind === 'strength') {
      const stepIndex = session.currentStepIndex;
      while (
        !['completed', 'aborted'].includes(session.status) &&
        session.currentStepIndex === stepIndex
      ) {
        const setNumber = session.currentSet;
        apply('complete_set', {
          stepId: step.id,
          setNumber,
          reps: step.reps,
          weightKg: 0
        });
        if (session.timer && session.timer.mode === 'rest') {
          apply('checkpoint', { reason: 'hide' }, session.timer.expectedEndAt);
          apply('start_set', { stepId: step.id, setNumber: session.currentSet }, session.timer.expiredAt);
        }
      }
      continue;
    }
    throw new Error(`unexpected step kind ${step.kind}`);
  }

  const recordRepository = createTrainingRecordRepository({ database });
  const statistics = createStatisticsApplicationService({
    service: createLocalStatisticsService({
      database,
      recordRepository,
      planRepository,
      now: () => nowMs
    })
  }).getView('2026-08-03');

  assert.equal(session.status, 'completed');
  assert.equal(recordRepository.list().length, 1);
  assert.equal(statistics.week.completionCountLabel, '1 / 6 次');
  assert.notEqual(statistics.metrics.activeMinutes.valueLabel, '0');
  assert.equal(statistics.metrics.strengthCount.valueLabel, '3');
  assert.equal(adapter.networkAttempts(), 0);
});

test('C2 lifecycle reconstruction emits one expiry boundary and terminal replay stays idempotent', () => {
  const adapter = createAnonymousOfflineAdapter();
  let nowMs = FIXED_CLOCK.startAt;
  let notifications = 0;
  const database = createLocalDatabase({ storage: adapter, now: () => nowMs });
  database.commit((draft) => {
    draft.install = { deviceId: 'anonymous_device_restart', createdAt: nowMs };
  });
  const runtime = (prefix) => {
    let sequence = 0;
    return createTimedWorkoutRuntime({
      database,
      now: () => nowMs,
      idFactory: () => 'session_critical_restart',
      commandKeyFactory: (type) => `${prefix}:${++sequence}:${type}`,
      notifyExpired() {
        notifications += 1;
      }
    });
  };

  const beforeRestart = runtime('before-restart');
  beforeRestart.load({ planId: 'plan_20260803_builtin' });
  beforeRestart.start();
  nowMs = FIXED_CLOCK.hideAt;
  beforeRestart.onHide();
  nowMs += 1_000;
  beforeRestart.onUnload();
  beforeRestart.destroy();

  nowMs = FIXED_CLOCK.restartAt;
  const afterRestart = runtime('after-restart');
  const restored = afterRestart.load();
  assert.equal(restored.state, 'expired-awaiting-confirmation');
  assert.equal(notifications, 1);
  afterRestart.onShow();
  assert.equal(notifications, 1);
  afterRestart.destroy();

  const reconstructedAgain = runtime('reconstructed-again');
  const restoredAgain = reconstructedAgain.load();
  assert.equal(restoredAgain.state, 'expired-awaiting-confirmation');
  assert.equal(notifications, 1);

  reconstructedAgain.confirmNext();
  while (reconstructedAgain.currentStep().kind === 'timed') {
    nowMs = reconstructedAgain.session.timer.expectedEndAt;
    const beforeBoundary = notifications;
    reconstructedAgain.onShow();
    assert.equal(notifications, beforeBoundary + 1);
    reconstructedAgain.onShow();
    assert.equal(notifications, beforeBoundary + 1);
    reconstructedAgain.confirmNext();
  }
  assert.equal(reconstructedAgain.currentStep().kind, 'strength');
  reconstructedAgain.onUnload();
  reconstructedAgain.destroy();

  const planRepository = createPlanRepository({ database, now: () => nowMs });
  const sessionRepository = createSessionRepository({ database });
  const workout = createWorkoutApplicationService({
    planRepository,
    sessionRepository,
    deviceId: 'anonymous_device_restart',
    idFactory: () => 'unused_session_id',
    now: () => nowMs
  });
  const strength = sessionRepository.loadActive();
  const strengthStep = strength.planSnapshot.steps[strength.currentStepIndex];
  const setCommand = {
    type: 'complete_set',
    expectedSessionRevision: strength.sessionRevision,
    commandKey: 'critical:set-replay',
    nowMs: nowMs + 1_000,
    payload: {
      stepId: strengthStep.id,
      setNumber: strength.currentSet,
      reps: strengthStep.reps,
      weightKg: 0
    }
  };
  const firstSet = workout.execute(setCommand);
  const replayedSet = workout.execute(setCommand);
  const strengthResult = replayedSet.session.stepResults.find(({ stepId }) => stepId === strengthStep.id);
  assert.equal(firstSet.replayed, false);
  assert.equal(replayedSet.replayed, true);
  assert.equal(strengthResult.setResults.length, 1);

  nowMs += 2_000;
  const afterSetRestart = runtime('after-set-restart');
  afterSetRestart.load();
  const restoredStrengthResult = afterSetRestart.session.stepResults.find(
    ({ stepId }) => stepId === strengthStep.id
  );
  assert.equal(restoredStrengthResult.setResults.length, 1);
  afterSetRestart.onUnload();
  afterSetRestart.destroy();

  const beforeSkip = sessionRepository.loadActive();
  nowMs += 1_000;
  const skipped = workout.execute({
    type: 'skip_step_and_start_next',
    expectedSessionRevision: beforeSkip.sessionRevision,
    commandKey: 'critical:skip-partial-strength',
    nowMs,
    payload: { stepId: strengthStep.id }
  });
  const skippedStrength = skipped.session.stepResults.find(({ stepId }) => stepId === strengthStep.id);
  assert.equal(skippedStrength.setResults.length, 1);
  const active = skipped.session;
  const terminalCommand = {
    type: 'abort',
    expectedSessionRevision: active.sessionRevision,
    commandKey: 'critical:terminal-replay',
    nowMs,
    payload: { reason: 'acceptance-boundary' }
  };
  const first = workout.execute(terminalCommand);
  const replay = workout.execute(terminalCommand);
  const records = createTrainingRecordRepository({ database }).list();

  assert.equal(first.session.status, 'aborted');
  assert.equal(replay.replayed, true);
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceSessionId, active.id);
  assert.equal(adapter.networkAttempts(), 0);
});

test('C3 history, invalid import, cancel/confirm clear and Sunday rest share real local boundaries', () => {
  const adapter = createAnonymousOfflineAdapter();
  let nowMs = FIXED_CLOCK.startAt;
  const database = createLocalDatabase({ storage: adapter, now: () => nowMs });
  database.commit((draft) => {
    draft.install = { deviceId: 'anonymous_device_data', createdAt: nowMs };
  });
  const planRepository = createPlanRepository({ database, now: () => nowMs });
  const planApplication = createPlanApplicationService({ repository: planRepository });
  planApplication.initializeDefaultPlans();

  const sessionRepository = createSessionRepository({ database });
  const workout = createWorkoutApplicationService({
    planRepository,
    sessionRepository,
    deviceId: 'anonymous_device_data',
    idFactory: () => 'session_critical_data',
    now: () => nowMs
  });
  const active = workout.startSession({
    planId: 'plan_20260803_builtin',
    commandKey: 'critical:data:start',
    nowMs
  });
  nowMs += 60_000;
  workout.execute({
    type: 'abort',
    expectedSessionRevision: active.sessionRevision,
    commandKey: 'critical:data:abort',
    nowMs,
    payload: { reason: 'acceptance-history' }
  });

  const recordRepository = createTrainingRecordRepository({ database });
  const history = createRecordApplicationService({ repository: recordRepository });
  const historyView = history.getView();
  const selected = historyView.selectedRecord;
  assert.equal(historyView.records.length, 1);
  assert.equal(selected.status, 'aborted');
  const editDraft = history.createEditDraft(selected);
  editDraft.feedbackMissing = false;
  editDraft.feedback.rpe = 5;
  const corrected = history.correctRecord({
    recordId: selected.id,
    expectedRevision: selected.revision,
    commandKey: 'critical:data:correct',
    nowMs: nowMs + 1,
    draft: editDraft
  });
  assert.equal(corrected.feedback.rpe, 5);
  history.deleteRecord({
    recordId: selected.id,
    expectedRevision: corrected.revision,
    commandKey: 'critical:data:delete',
    nowMs: nowMs + 2
  });
  assert.equal(history.getView().records.length, 0);

  const dataAdapter = createAnonymousOfflineAdapter();
  const dataDatabase = createLocalDatabase({ storage: dataAdapter, now: () => nowMs });
  dataDatabase.commit((draft) => {
    draft.install = { deviceId: 'anonymous_device_controls', createdAt: nowMs };
  });
  const dataPlanRepository = createPlanRepository({ database: dataDatabase, now: () => nowMs });
  const dataPlanApplication = createPlanApplicationService({ repository: dataPlanRepository });
  dataPlanApplication.initializeDefaultPlans();
  const sunday = dataPlanApplication.getWeekPlan({
    weekStart: '2026-08-03',
    selectedDate: '2026-08-09'
  }).selectedDay;
  const settings = createSettingsDataApplicationService({
    repository: createSettingsRepository({ database: dataDatabase, now: () => nowMs }),
    database: dataDatabase,
    now: () => nowMs
  });
  const exported = settings.createExportPreview();
  assert.equal(exported.summary.plans, 7);
  const importAdapter = createAnonymousOfflineAdapter();
  const importDatabase = createLocalDatabase({ storage: importAdapter, now: () => nowMs });
  importDatabase.commit((draft) => {
    draft.install = { deviceId: 'anonymous_device_import', createdAt: nowMs };
  });
  const importSettings = createSettingsDataApplicationService({
    repository: createSettingsRepository({ database: importDatabase, now: () => nowMs }),
    database: importDatabase,
    now: () => nowMs
  });
  const bytesBeforeInvalidImport = importAdapter.storageBytes();
  assert.throws(() => importSettings.previewImport('{"packageVersion":'), /JSON|Unexpected|parse/i);
  assert.equal(importAdapter.storageBytes(), bytesBeforeInvalidImport);
  const importPreview = importSettings.previewImport(exported.jsonText);
  const imported = importSettings.confirmImport(exported.jsonText, importPreview.confirmationId);
  assert.equal(imported.applied, true);
  assert.equal(importDatabase.load().plans.length, 7);

  const bytesBeforeCancelledClear = importAdapter.storageBytes();
  const cancelPreview = importSettings.prepareLocalClear();
  assert.equal(cancelPreview.counts.plans, 7);
  assert.equal(importAdapter.storageBytes(), bytesBeforeCancelledClear);
  const confirmPreview = importSettings.prepareLocalClear();
  const cleared = importSettings.confirmLocalClear(confirmPreview.confirmationId);

  assert.equal(sunday.isRestDay, true);
  assert.equal(sunday.canStartWorkout, false);
  assert.equal(cleared.purged, true);
  assert.deepEqual(importDatabase.load().plans, []);
  assert.deepEqual(importDatabase.load().records, []);
  assert.equal(adapter.networkAttempts(), 0);
  assert.equal(dataAdapter.networkAttempts(), 0);
  assert.equal(importAdapter.networkAttempts(), 0);
});

test('C4 sync recovery/conflict/purge, trusted cloud owner and privacy scan cross public boundaries', async (t) => {
  const temporaryRoots = [];
  t.after(() => {
    for (const temporaryRoot of temporaryRoots) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
  const adapter = createAnonymousOfflineAdapter();
  const database = createLocalDatabase({ storage: adapter, now: () => FIXED_CLOCK.startAt });
  database.commit((draft) => {
    draft.install = { deviceId: 'anonymous_device_sync', createdAt: FIXED_CLOCK.startAt };
  });
  const planRepository = createPlanRepository({ database, now: () => FIXED_CLOCK.startAt });
  const syncPlan = {
    ...structuredClone(createDefaultPlans()[0]),
    id: 'plan_critical_sync',
    trainingDate: '2026-08-10',
    templateSource: null,
    createdAt: FIXED_CLOCK.startAt,
    updatedAt: FIXED_CLOCK.startAt,
    revision: 1
  };
  planRepository.save(syncPlan, 0);
  const deterministic = createDeterministicRemoteSyncProvider({
    ownerId: 'anonymous_remote_owner',
    now: () => FIXED_CLOCK.startAt
  });
  let denyBootstrap = true;
  const recoverableProvider = {
    async bootstrap(request) {
      if (denyBootstrap) {
        denyBootstrap = false;
        const error = new Error('anonymous bootstrap denied once');
        error.code = 'CLOUD_SYNC_UNAVAILABLE';
        throw error;
      }
      return deterministic.bootstrap(request);
    },
    push: (request) => deterministic.push(request),
    pull: (request) => deterministic.pull(request),
    preparePurge: (request) => deterministic.preparePurge(request),
    purge: (request) => deterministic.purge(request)
  };
  const sync = createSyncApplicationService({
    syncService: createSyncService({
      database,
      provider: recoverableProvider,
      now: () => FIXED_CLOCK.startAt
    })
  });

  const enable = sync.prepareEnable();
  const denied = await sync.confirmEnable({ confirmationId: enable.confirmationId });
  assert.equal(denied.ok, false);
  assert.equal(denied.state.code, 'failure');
  const retried = await sync.retry({ source: 'manual' });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(sync.getState().code, 'synced');

  const local = planRepository.findById(syncPlan.id);
  const changed = {
    ...structuredClone(local),
    title: '匿名本机调整',
    revision: local.revision + 1,
    updatedAt: FIXED_CLOCK.startAt + 10
  };
  planRepository.save(changed, local.revision);
  const pending = database.load().sync.outbox.find(({ entityId }) => entityId === changed.id);
  deterministic.conflictOperation(pending.opId, remotePlanEnvelope({
    ...structuredClone(changed),
    title: '匿名云端调整',
    revision: changed.revision + 1,
    updatedAt: FIXED_CLOCK.startAt + 11
  }, FIXED_CLOCK.startAt));
  await sync.retry({ source: 'manual' });
  const conflict = sync.getState().conflicts[0];
  assert.equal(sync.getState().code, 'conflict');
  await sync.resolveConflict({ conflictId: conflict.conflictId, action: 'keep_remote' });
  await sync.retry({ source: 'manual' });
  assert.equal(planRepository.findById(changed.id).title, '匿名云端调整');
  const converged = sync.getState();
  assert.equal(converged.code, 'synced');
  assert.equal(converged.pendingCount, 0);
  assert.deepEqual(converged.conflicts, []);
  assert.deepEqual(database.load().sync.outbox, []);
  assert.equal(
    database.load().sync.conflicts.some(({ status }) => status !== 'resolved'),
    false
  );
  const purgePreview = await sync.prepareRemotePurge();
  const purgeReceipt = await sync.purgeRemote({
    confirmationToken: purgePreview.confirmationToken
  });
  const remoteAfterPurge = await deterministic.pull({ cursor: null, limit: 100 });
  assert.equal(purgeReceipt.purgedAt, FIXED_CLOCK.startAt);
  assert.deepEqual(remoteAfterPurge.changes, []);
  assert.equal(sync.getState().code, 'disabled');
  assert.equal(sync.getState().enabled, false);
  assert.notEqual(planRepository.findById(syncPlan.id), null);

  const cloudBase = createCloudBaseSyncProvider({ wx: adapter });
  await assert.rejects(
    cloudBase.bootstrap({ deviceId: 'anonymous_device_sync' }),
    (error) => error.code === 'NETWORK_OFFLINE'
  );
  assert.equal(adapter.networkAttempts(), 1);

  const trustedSubject = 'anonymous-trusted-subject';
  const cloudStore = createCloudSyncStoreDouble();
  const handlers = createCloudSyncHandlers({
    getTrustedContext: () => ({ OPENID: trustedSubject }),
    store: cloudStore,
    env: {
      TRAINFLOW_ALLOWED_OPENID_SHA256: createHash('sha256').update(trustedSubject).digest('hex'),
      TRAINFLOW_OWNER_HMAC_KEY: 'test-only-sentinel-owner-key-0000000000000000',
      TRAINFLOW_CURSOR_HMAC_KEY: 'test-only-sentinel-cursor-key-000000000000000',
      TRAINFLOW_PURGE_HMAC_KEY: 'test-only-sentinel-purge-key-000000000000000',
      TRAINFLOW_PURGE_TTL_SECONDS: '300'
    },
    now: () => FIXED_CLOCK.startAt,
    randomBytes: (size) => Buffer.alloc(size, 0x31),
    logger: { info() {}, warn() {}, error() {} }
  });
  await handlers.authBootstrap({
    deviceId: 'anonymous_cloud_device',
    schemaVersion: 1,
    ownerId: 'forged-event-owner'
  });
  const cloudSnapshot = cloudStore.snapshot();
  assert.equal(JSON.stringify(cloudSnapshot).includes('forged-event-owner'), false);
  assert.equal(Object.keys(cloudSnapshot.accounts).length, 1);

  const directClientSources = fs.readdirSync(path.join(ROOT, 'miniprogram'), {
    recursive: true,
    withFileTypes: true
  }).filter((entry) => entry.isFile()).map((entry) => (
    fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
  )).join('\n');
  assert.doesNotMatch(directClientSources, /wx\s*\.\s*cloud\s*\.\s*database\s*\(/);

  const scan = spawnSync('bash', [path.join(ROOT, 'scripts/privacy-scan.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PRIVACY_SCAN_REQUIRE_SCREENSHOTS: '0' }
  });
  assert.equal(scan.status, 0, scan.stdout || scan.stderr);
  const strictEvidenceScan = spawnSync('bash', [path.join(ROOT, 'scripts/privacy-scan.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PRIVACY_SCAN_REQUIRE_SCREENSHOTS: '1' }
  });
  assert.notEqual(strictEvidenceScan.status, 0);
  assert.match(strictEvidenceScan.stdout, /SCREENSHOT_EVIDENCE_ABSENT evidence\/screenshots/);
  const strictLogScan = spawnSync('bash', [path.join(ROOT, 'scripts/privacy-scan.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRIVACY_SCAN_REQUIRE_SCREENSHOTS: '0',
      PRIVACY_SCAN_REQUIRE_LOGS: '1'
    }
  });
  assert.notEqual(strictLogScan.status, 0);
  assert.match(strictLogScan.stdout, /LOG_EVIDENCE_ABSENT evidence\/logs/);

  const logCommands = {
    'critical-e2e': 'node --test tests/e2e/train-flow-critical.e2e.test.js',
    'full-suite': 'npm test',
    'privacy-scan': 'PRIVACY_SCAN_REQUIRE_SCREENSHOTS=0 PRIVACY_SCAN_REQUIRE_LOGS=0 bash scripts/privacy-scan.sh'
  };
  const validLogSummaries = {
    'critical-e2e': '# tests 4\n# pass 4\n# fail 0',
    'full-suite': '# tests 737\n# pass 737\n# fail 0',
    'privacy-scan': 'PRIVACY_SCAN_PASS tracked-content'
  };
  const commandLog = (kind, head, tree, summary = 'summary: anonymous pass') => (
    `command: ${logCommands[kind]}\n` +
      `source-head: ${head}\n` +
      `source-tree: ${tree}\n` +
      `${summary}\n` +
      'exit-code: 0\n'
  );
  const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const initializeEvidenceRepository = (prefix) => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    temporaryRoots.push(repositoryRoot);
    fs.mkdirSync(path.join(repositoryRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(repositoryRoot, 'evidence/logs'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'scripts/privacy-scan.sh'),
      path.join(repositoryRoot, 'scripts/privacy-scan.sh')
    );
    spawnSync('git', ['init', '-q'], { cwd: repositoryRoot });
    spawnSync('git', ['add', 'scripts'], { cwd: repositoryRoot });
    spawnSync('git', [
      '-c', 'user.name=Anonymous QA',
      '-c', 'user.email=qa@example.invalid',
      'commit', '-qm', 'capture source under test'
    ], { cwd: repositoryRoot });
    return {
      repositoryRoot,
      sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      }).stdout.trim(),
      sourceTree: spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      }).stdout.trim()
    };
  };

  const validLogRepository = initializeEvidenceRepository('train-flow-valid-logs-');
  const validLogRows = [];
  for (const [kind, file] of [
    ['critical-e2e', 'critical-e2e.log'],
    ['full-suite', 'full-suite.log'],
    ['privacy-scan', 'privacy-scan.log']
  ]) {
    const content = commandLog(
      kind,
      validLogRepository.sourceHead,
      validLogRepository.sourceTree,
      validLogSummaries[kind]
    );
    fs.writeFileSync(path.join(validLogRepository.repositoryRoot, 'evidence/logs', file), content);
    validLogRows.push(
      `${kind}\t${validLogRepository.sourceHead}\t${validLogRepository.sourceTree}` +
        `\t${digestOf(content)}\tPASS\t${file}`
    );
  }
  fs.writeFileSync(
    path.join(validLogRepository.repositoryRoot, 'evidence/logs/manifest.tsv'),
    'kind\thead\ttree\tsha256\tredaction_verdict\tfile\n' +
      `${validLogRows.join('\n')}\n`
  );
  spawnSync('git', ['add', 'evidence/logs'], { cwd: validLogRepository.repositoryRoot });
  spawnSync('git', [
    '-c', 'user.name=Anonymous QA',
    '-c', 'user.email=qa@example.invalid',
    'commit', '-qm', 'attach valid command logs'
  ], { cwd: validLogRepository.repositoryRoot });
  const acceptedLogs = spawnSync('bash', ['scripts/privacy-scan.sh'], {
    cwd: validLogRepository.repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRIVACY_SCAN_ROOT: validLogRepository.repositoryRoot,
      PRIVACY_SCAN_REQUIRE_SCREENSHOTS: '0',
      PRIVACY_SCAN_REQUIRE_LOGS: '1',
      PRIVACY_SCAN_EXPECTED_HEAD: validLogRepository.sourceHead,
      PRIVACY_SCAN_EXPECTED_TREE: validLogRepository.sourceTree
    }
  });
  assert.equal(acceptedLogs.status, 0, acceptedLogs.stdout || acceptedLogs.stderr);
  fs.mkdirSync(path.join(validLogRepository.repositoryRoot, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(validLogRepository.repositoryRoot, 'tests/stale-boundary.test.js'),
    "const sourceChangedAfterEvidence = true;\n"
  );
  spawnSync('git', ['add', 'tests/stale-boundary.test.js'], {
    cwd: validLogRepository.repositoryRoot
  });
  spawnSync('git', [
    '-c', 'user.name=Anonymous QA',
    '-c', 'user.email=qa@example.invalid',
    'commit', '-qm', 'change test boundary after evidence'
  ], { cwd: validLogRepository.repositoryRoot });
  const staleLogs = spawnSync('bash', ['scripts/privacy-scan.sh'], {
    cwd: validLogRepository.repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRIVACY_SCAN_ROOT: validLogRepository.repositoryRoot,
      PRIVACY_SCAN_REQUIRE_SCREENSHOTS: '0',
      PRIVACY_SCAN_REQUIRE_LOGS: '1',
      PRIVACY_SCAN_EXPECTED_HEAD: validLogRepository.sourceHead,
      PRIVACY_SCAN_EXPECTED_TREE: validLogRepository.sourceTree
    }
  });
  assert.notEqual(staleLogs.status, 0);
  assert.match(staleLogs.stdout, /LOG_SOURCE_STALE evidence\/logs\/manifest\.tsv/);

  const invalidLogRepository = initializeEvidenceRepository('train-flow-invalid-logs-');
  const invalidLogDir = path.join(invalidLogRepository.repositoryRoot, 'evidence/logs');
  const sharedLog = commandLog(
    'critical-e2e',
    invalidLogRepository.sourceHead,
    invalidLogRepository.sourceTree
  );
  const binaryLog = Buffer.concat([
    Buffer.from(commandLog(
      'critical-e2e',
      invalidLogRepository.sourceHead,
      invalidLogRepository.sourceTree,
      'requestPayload: must-remain-private'
    )),
    Buffer.from([0])
  ]);
  const arbitraryLog = 'arbitrary text without command provenance\n';
  const zeroSuiteLog = commandLog(
    'full-suite',
    invalidLogRepository.sourceHead,
    invalidLogRepository.sourceTree,
    '# tests 0\n# pass 0\n# fail 0'
  );
  fs.writeFileSync(path.join(invalidLogDir, 'shared.log'), sharedLog);
  fs.writeFileSync(path.join(invalidLogDir, 'empty.log'), '');
  fs.writeFileSync(path.join(invalidLogDir, 'binary.log'), binaryLog);
  fs.writeFileSync(path.join(invalidLogDir, 'arbitrary.log'), arbitraryLog);
  fs.writeFileSync(path.join(invalidLogDir, 'zero-suite.log'), zeroSuiteLog);
  const unresolvedHead = '0'.repeat(40);
  const unresolvedTree = '1'.repeat(40);
  fs.writeFileSync(
    path.join(invalidLogDir, 'manifest.tsv'),
    'kind\thead\ttree\tsha256\tredaction_verdict\tfile\n' +
      `critical-e2e\t${invalidLogRepository.sourceHead}\t${invalidLogRepository.sourceTree}` +
      `\t${digestOf(sharedLog)}\tPASS\tshared.log\n` +
      `full-suite\t${invalidLogRepository.sourceHead}\t${invalidLogRepository.sourceTree}` +
      `\t${digestOf(sharedLog)}\tPASS\tshared.log\n` +
      `privacy-scan\t${invalidLogRepository.sourceHead}\t${invalidLogRepository.sourceTree}` +
      `\t${digestOf(sharedLog)}\tPASS\tshared.log\n` +
      `critical-e2e\t${invalidLogRepository.sourceHead}\t${invalidLogRepository.sourceTree}` +
      `\t${digestOf('')}\tPASS\tempty.log\n` +
      `critical-e2e\t${invalidLogRepository.sourceHead}\t${invalidLogRepository.sourceTree}` +
      `\t${digestOf(binaryLog)}\tPASS\tbinary.log\n` +
      `critical-e2e\t${unresolvedHead}\t${unresolvedTree}` +
      `\t${digestOf(arbitraryLog)}\tPASS\tarbitrary.log\n` +
      `full-suite\t${invalidLogRepository.sourceHead}\t${invalidLogRepository.sourceTree}` +
      `\t${digestOf(zeroSuiteLog)}\tPASS\tzero-suite.log\n`
  );
  spawnSync('git', ['add', 'evidence/logs'], { cwd: invalidLogRepository.repositoryRoot });
  spawnSync('git', [
    '-c', 'user.name=Anonymous QA',
    '-c', 'user.email=qa@example.invalid',
    'commit', '-qm', 'attach invalid command logs'
  ], { cwd: invalidLogRepository.repositoryRoot });
  const rejectedLogs = spawnSync('bash', ['scripts/privacy-scan.sh'], {
    cwd: invalidLogRepository.repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRIVACY_SCAN_ROOT: invalidLogRepository.repositoryRoot,
      PRIVACY_SCAN_REQUIRE_SCREENSHOTS: '0',
      PRIVACY_SCAN_REQUIRE_LOGS: '1',
      PRIVACY_SCAN_EXPECTED_HEAD: invalidLogRepository.sourceHead,
      PRIVACY_SCAN_EXPECTED_TREE: invalidLogRepository.sourceTree
    }
  });
  assert.notEqual(rejectedLogs.status, 0);
  assert.match(rejectedLogs.stdout, /LOG_DUPLICATE_KIND evidence\/logs\/manifest\.tsv/);
  assert.match(rejectedLogs.stdout, /LOG_DUPLICATE_FILE evidence\/logs\/manifest\.tsv/);
  assert.match(rejectedLogs.stdout, /LOG_FILE_EMPTY evidence\/logs\/empty\.log/);
  assert.match(rejectedLogs.stdout, /LOG_FILE_BINARY evidence\/logs\/binary\.log/);
  assert.match(rejectedLogs.stdout, /EVIDENCE_LOG_BINARY evidence\/logs\/binary\.log/);
  assert.match(rejectedLogs.stdout, /LOG_CONTENT_INVALID evidence\/logs\/arbitrary\.log/);
  assert.match(rejectedLogs.stdout, /LOG_RESULT_INVALID evidence\/logs\/shared\.log/);
  assert.match(rejectedLogs.stdout, /LOG_RESULT_INVALID evidence\/logs\/zero-suite\.log/);
  assert.match(rejectedLogs.stdout, /LOG_SOURCE_UNRESOLVED evidence\/logs\/manifest\.tsv/);
  assert.match(rejectedLogs.stdout, /LOG_REQUIRED_KIND_MISSING evidence\/logs\/manifest\.tsv/);
  assert.doesNotMatch(rejectedLogs.stdout, /PII_LITERAL evidence\/logs\/manifest\.tsv/);
  assert.doesNotMatch(rejectedLogs.stdout, /must-remain-private/);

  const negativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'train-flow-privacy-'));
  temporaryRoots.push(negativeRoot);
  fs.mkdirSync(path.join(negativeRoot, 'miniprogram'), { recursive: true });
  fs.mkdirSync(path.join(negativeRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(negativeRoot, 'evidence/logs'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/privacy-scan.sh'), path.join(negativeRoot, 'scripts/privacy-scan.sh'));
  fs.writeFileSync(
    path.join(negativeRoot, 'miniprogram/leak.js'),
    "const localPath = '/Users/example/private';\n" + // PRIVACY_SCAN_TEST_SENTINEL
      "const appSecret = 'non-test-private-value';\n" + // PRIVACY_SCAN_TEST_SENTINEL
      "const realName = 'private-person';\n" + // PRIVACY_SCAN_TEST_SENTINEL
      'wx.cloud.database();\n'
  );
  fs.writeFileSync(
    path.join(negativeRoot, 'project.config.json'),
    '{"appid":"wx0123456789abcdef"}\n' // PRIVACY_SCAN_TEST_SENTINEL
  );
  fs.writeFileSync(
    path.join(negativeRoot, 'miniprogram/leak.json'),
    '{"appSecret":"private-value","realName":"private-person"}\n' // PRIVACY_SCAN_TEST_SENTINEL
  );
  fs.writeFileSync(
    path.join(negativeRoot, 'miniprogram/marked.js'),
    "const appSecret = 'must-still-fail'; // PRIVACY_SCAN_TEST_SENTINEL\n" // PRIVACY_SCAN_TEST_SENTINEL
  );
  fs.writeFileSync(
    path.join(negativeRoot, 'evidence/logs/request.log'),
    '{"requestPayload":"private"}\n'
  );
  fs.mkdirSync(path.join(negativeRoot, 'tests/e2e'), { recursive: true });
  fs.writeFileSync(
    path.join(negativeRoot, 'tests/e2e/train-flow-critical.e2e.test.js'),
    "const appSecret = 'unmarked-private-value';\n" // PRIVACY_SCAN_TEST_SENTINEL
  );
  spawnSync('git', ['init', '-q'], { cwd: negativeRoot });
  spawnSync('git', ['add', '.'], { cwd: negativeRoot });
  const rejected = spawnSync('bash', ['scripts/privacy-scan.sh'], {
    cwd: negativeRoot,
    encoding: 'utf8',
    env: { ...process.env, PRIVACY_SCAN_ROOT: negativeRoot }
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout, /ABSOLUTE_USER_PATH miniprogram\/leak\.js/);
  assert.match(rejected.stdout, /REAL_WECHAT_APPID project\.config\.json/);
  assert.match(rejected.stdout, /DIRECT_MINIPROGRAM_DATABASE miniprogram\/leak\.js/);
  assert.match(rejected.stdout, /PII_LITERAL miniprogram\/leak\.json/);
  assert.match(rejected.stdout, /CREDENTIAL_ASSIGNMENT miniprogram\/leak\.json/);
  assert.match(rejected.stdout, /CREDENTIAL_ASSIGNMENT miniprogram\/marked\.js/);
  assert.match(
    rejected.stdout,
    /CREDENTIAL_ASSIGNMENT tests\/e2e\/train-flow-critical\.e2e\.test\.js/
  );
  assert.match(rejected.stdout, /EVIDENCE_LOG_PRIVATE_PAYLOAD evidence\/logs\/request\.log/);
  assert.doesNotMatch( // PRIVACY_SCAN_TEST_SENTINEL
    rejected.stdout,
    /\/Users\/example|wx0123456789abcdef/ // PRIVACY_SCAN_TEST_SENTINEL
  );

  const emptyEvidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'train-flow-empty-evidence-'));
  temporaryRoots.push(emptyEvidenceRoot);
  fs.mkdirSync(path.join(emptyEvidenceRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(emptyEvidenceRoot, 'evidence/screenshots'), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'scripts/privacy-scan.sh'),
    path.join(emptyEvidenceRoot, 'scripts/privacy-scan.sh')
  );
  fs.writeFileSync(
    path.join(emptyEvidenceRoot, 'evidence/screenshots/manifest.tsv'),
    'route\thead\ttree\tsha256\tdata_source\tmanual_visual_verdict\tfile\n'
  );
  spawnSync('git', ['init', '-q'], { cwd: emptyEvidenceRoot });
  spawnSync('git', ['add', '.'], { cwd: emptyEvidenceRoot });
  spawnSync('git', [
    '-c', 'user.name=Anonymous QA',
    '-c', 'user.email=qa@example.invalid',
    'commit', '-qm', 'test evidence gate'
  ], { cwd: emptyEvidenceRoot });
  const emptyEvidence = spawnSync('bash', ['scripts/privacy-scan.sh'], {
    cwd: emptyEvidenceRoot,
    encoding: 'utf8',
    env: { ...process.env, PRIVACY_SCAN_ROOT: emptyEvidenceRoot }
  });
  assert.notEqual(emptyEvidence.status, 0);
  assert.match(emptyEvidence.stdout, /SCREENSHOT_MANIFEST_EMPTY evidence\/screenshots\/manifest\.tsv/);

  const traversalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'train-flow-evidence-path-'));
  temporaryRoots.push(traversalRoot);
  fs.mkdirSync(path.join(traversalRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(traversalRoot, 'evidence/screenshots'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/privacy-scan.sh'), path.join(traversalRoot, 'scripts/privacy-scan.sh'));
  const outsideBytes = Buffer.from('anonymous screenshot bytes');
  fs.writeFileSync(path.join(traversalRoot, 'evidence/outside.png'), outsideBytes);
  fs.writeFileSync(path.join(traversalRoot, 'evidence/screenshots/capture.png'), outsideBytes);
  fs.writeFileSync(
    path.join(traversalRoot, 'evidence/screenshots/unlisted.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  );
  fs.symlinkSync('../outside.png', path.join(traversalRoot, 'evidence/screenshots/link.png'));
  const outsideDigest = createHash('sha256').update(outsideBytes).digest('hex');
  fs.writeFileSync(
    path.join(traversalRoot, 'evidence/screenshots/manifest.tsv'),
    'route\thead\ttree\tsha256\tdata_source\tmanual_visual_verdict\tfile\n' +
      `/pages/today/index\t${'0'.repeat(40)}\t${'0'.repeat(40)}\t${outsideDigest}` +
      '\tanonymous-fixture\tPASS\tcapture.png\n' +
      `/pages/today/index\t${'0'.repeat(40)}\t${'0'.repeat(40)}\t${outsideDigest}` +
      '\tanonymous-fixture\tPASS\tlink.png\n' +
      `/pages/today/index\t${'0'.repeat(40)}\t${'0'.repeat(40)}\t${outsideDigest}` +
      '\tanonymous-fixture\tPASS\t../outside.png\n'
  );
  spawnSync('git', ['init', '-q'], { cwd: traversalRoot });
  spawnSync('git', [
    'add',
    'scripts',
    'evidence/screenshots/manifest.tsv',
    'evidence/screenshots/link.png',
    'evidence/screenshots/unlisted.png'
  ], { cwd: traversalRoot });
  spawnSync('git', [
    '-c', 'user.name=Anonymous QA',
    '-c', 'user.email=qa@example.invalid',
    'commit', '-qm', 'test evidence provenance'
  ], { cwd: traversalRoot });
  const traversalEvidence = spawnSync('bash', ['scripts/privacy-scan.sh'], {
    cwd: traversalRoot,
    encoding: 'utf8',
    env: { ...process.env, PRIVACY_SCAN_ROOT: traversalRoot }
  });
  assert.notEqual(traversalEvidence.status, 0);
  assert.match(
    traversalEvidence.stdout,
    /SCREENSHOT_PATH_INVALID evidence\/screenshots\/manifest\.tsv/
  );
  assert.match(
    traversalEvidence.stdout,
    /SCREENSHOT_SOURCE_UNRESOLVED evidence\/screenshots\/manifest\.tsv/
  );
  assert.match(
    traversalEvidence.stdout,
    /SCREENSHOT_FILE_UNTRACKED evidence\/screenshots\/capture\.png/
  );
  assert.match(
    traversalEvidence.stdout,
    /SCREENSHOT_FILE_SYMLINK evidence\/screenshots\/link\.png/
  );
  assert.match(
    traversalEvidence.stdout,
    /SCREENSHOT_SIGNATURE_INVALID evidence\/screenshots\/capture\.png/
  );
  assert.match(
    traversalEvidence.stdout,
    /SCREENSHOT_UNLISTED evidence\/screenshots\/unlisted\.png/
  );

  const staleSourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'train-flow-stale-source-'));
  temporaryRoots.push(staleSourceRoot);
  fs.mkdirSync(path.join(staleSourceRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(staleSourceRoot, 'evidence/screenshots'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/privacy-scan.sh'), path.join(staleSourceRoot, 'scripts/privacy-scan.sh'));
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00
  ]);
  fs.writeFileSync(path.join(staleSourceRoot, 'evidence/screenshots/capture.png'), pngBytes);
  spawnSync('git', ['init', '-q'], { cwd: staleSourceRoot });
  spawnSync('git', ['add', '.'], { cwd: staleSourceRoot });
  spawnSync('git', [
    '-c', 'user.name=Anonymous QA',
    '-c', 'user.email=qa@example.invalid',
    'commit', '-qm', 'capture product source'
  ], { cwd: staleSourceRoot });
  const staleHead = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: staleSourceRoot,
    encoding: 'utf8'
  }).stdout.trim();
  const staleTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: staleSourceRoot,
    encoding: 'utf8'
  }).stdout.trim();
  const pngDigest = createHash('sha256').update(pngBytes).digest('hex');
  fs.writeFileSync(
    path.join(staleSourceRoot, 'evidence/screenshots/manifest.tsv'),
    'route\thead\ttree\tsha256\tdata_source\tmanual_visual_verdict\tfile\n' +
      `/pages/today/index\t${staleHead}\t${staleTree}\t${pngDigest}` +
      '\tanonymous-fixture\tPASS\tcapture.png\n'
  );
  spawnSync('git', ['add', 'evidence/screenshots/manifest.tsv'], { cwd: staleSourceRoot });
  spawnSync('git', [
    '-c', 'user.name=Anonymous QA',
    '-c', 'user.email=qa@example.invalid',
    'commit', '-qm', 'attach stale evidence'
  ], { cwd: staleSourceRoot });
  const staleEvidence = spawnSync('bash', ['scripts/privacy-scan.sh'], {
    cwd: staleSourceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRIVACY_SCAN_ROOT: staleSourceRoot,
      PRIVACY_SCAN_REQUIRE_LOGS: '0'
    }
  });
  assert.notEqual(staleEvidence.status, 0);
  assert.match(
    staleEvidence.stdout,
    /SCREENSHOT_SOURCE_HEAD_MISMATCH evidence\/screenshots\/manifest\.tsv/
  );
});
