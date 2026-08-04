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

  const planRepository = createPlanRepository({ database, now: () => nowMs });
  const sessionRepository = createSessionRepository({ database });
  const workout = createWorkoutApplicationService({
    planRepository,
    sessionRepository,
    deviceId: 'anonymous_device_restart',
    idFactory: () => 'unused_session_id',
    now: () => nowMs
  });
  const active = sessionRepository.loadActive();
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
  history.deleteRecord({
    recordId: selected.id,
    expectedRevision: selected.revision,
    commandKey: 'critical:data:delete',
    nowMs: nowMs + 1
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
  const bytesBeforeInvalidImport = dataAdapter.storageBytes();
  assert.throws(() => settings.previewImport('{"packageVersion":'), /JSON|Unexpected|parse/i);
  assert.equal(dataAdapter.storageBytes(), bytesBeforeInvalidImport);

  const cancelPreview = settings.prepareLocalClear();
  assert.equal(cancelPreview.counts.plans, 7);
  assert.equal(dataAdapter.storageBytes(), bytesBeforeInvalidImport);
  const confirmPreview = settings.prepareLocalClear();
  const cleared = settings.confirmLocalClear(confirmPreview.confirmationId);

  assert.equal(sunday.isRestDay, true);
  assert.equal(sunday.canStartWorkout, false);
  assert.equal(cleared.purged, true);
  assert.deepEqual(dataDatabase.load().plans, []);
  assert.deepEqual(dataDatabase.load().records, []);
  assert.equal(adapter.networkAttempts(), 0);
  assert.equal(dataAdapter.networkAttempts(), 0);
});

test('C4 sync recovery/conflict/purge, trusted cloud owner and privacy scan cross public boundaries', async () => {
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
  const purgePreview = await sync.prepareRemotePurge();
  const purgeReceipt = await sync.purgeRemote({
    confirmationToken: purgePreview.confirmationToken
  });
  assert.equal(purgeReceipt.purgedAt, FIXED_CLOCK.startAt);

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
    encoding: 'utf8'
  });
  assert.equal(scan.status, 0, scan.stdout || scan.stderr);

  const negativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'train-flow-privacy-'));
  fs.mkdirSync(path.join(negativeRoot, 'miniprogram'), { recursive: true });
  fs.mkdirSync(path.join(negativeRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(negativeRoot, 'evidence/logs'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts/privacy-scan.sh'), path.join(negativeRoot, 'scripts/privacy-scan.sh'));
  fs.writeFileSync(
    path.join(negativeRoot, 'miniprogram/leak.js'),
    "const localPath = '/Users/example/private';\n" +
      "const appid = 'wx0123456789abcdef';\n" +
      "const appSecret = 'non-test-private-value';\n" +
      "const realName = 'private-person';\n" +
      'wx.cloud.database();\n'
  );
  fs.writeFileSync(path.join(negativeRoot, 'evidence/logs/request.log'), 'requestPayload: private\n');
  spawnSync('git', ['init', '-q'], { cwd: negativeRoot });
  spawnSync('git', ['add', '.'], { cwd: negativeRoot });
  const rejected = spawnSync('bash', ['scripts/privacy-scan.sh'], {
    cwd: negativeRoot,
    encoding: 'utf8',
    env: { ...process.env, PRIVACY_SCAN_ROOT: negativeRoot }
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout, /ABSOLUTE_USER_PATH miniprogram\/leak\.js/);
  assert.match(rejected.stdout, /REAL_WECHAT_APPID miniprogram\/leak\.js/);
  assert.match(rejected.stdout, /DIRECT_MINIPROGRAM_DATABASE miniprogram\/leak\.js/);
  assert.match(rejected.stdout, /PII_LITERAL miniprogram\/leak\.js/);
  assert.match(rejected.stdout, /CREDENTIAL_ASSIGNMENT miniprogram\/leak\.js/);
  assert.match(rejected.stdout, /EVIDENCE_LOG_PRIVATE_PAYLOAD evidence\/logs\/request\.log/);
  assert.doesNotMatch(rejected.stdout, /\/Users\/example|wx0123456789abcdef/);
});
