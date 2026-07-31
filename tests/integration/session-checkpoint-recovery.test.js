const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWorkoutApplicationService
} = require('../../miniprogram/application/workout-application-service');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createPlanRepository
} = require('../../miniprogram/domain/planning/plan-repository');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { computeChecksum } = require('../../miniprogram/utils/checksum');

const NOW = 1785717300000;
const SLOT_PREFIX = 'train_flow:v1:db:';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStorage() {
  const values = new Map();
  const writes = [];
  let failNextSlotWrite = false;
  return {
    values,
    writes,
    failNextSlotWrite() {
      failNextSlotWrite = true;
    },
    getStorageSync(key) {
      return clone(values.get(key));
    },
    setStorageSync(key, value) {
      writes.push({ key, value: clone(value) });
      if (failNextSlotWrite && (key === `${SLOT_PREFIX}a` || key === `${SLOT_PREFIX}b`)) {
        failNextSlotWrite = false;
        throw new Error('injected slot write failure');
      }
      values.set(key, clone(value));
    },
    removeStorageSync(key) {
      values.delete(key);
    }
  };
}

function snapshotWriteCount(storage) {
  return storage.writes.filter(({ key }) => key === `${SLOT_PREFIX}a` || key === `${SLOT_PREFIX}b`).length;
}

function createRuntime({
  storage = createStorage(),
  deviceId = 'device_origin',
  idFactory = () => 'session_persisted'
} = {}) {
  const database = createLocalDatabase({ storage, now: () => NOW });
  const plans = createDefaultPlans({ now: () => NOW });
  if (database.load().plans.length === 0) {
    database.commit((draft) => {
      draft.plans.push(...clone(plans));
    });
  }
  const planRepository = createPlanRepository({ database, now: () => NOW });
  const sessionRepository = createSessionRepository({ database });
  const service = createWorkoutApplicationService({
    planRepository,
    sessionRepository,
    deviceId,
    idFactory,
    now: () => NOW
  });
  return { database, plans, planRepository, service, sessionRepository, storage };
}

function start(runtime, overrides = {}) {
  return runtime.service.startSession({
    planId: runtime.plans[0].id,
    commandKey: 'start_persisted',
    nowMs: NOW,
    ...overrides
  });
}

test('start snapshots the plan in one A/B commit and rejects a second active Session', () => {
  const runtime = createRuntime();
  const beforeWrites = snapshotWriteCount(runtime.storage);
  const session = start(runtime);

  assert.equal(snapshotWriteCount(runtime.storage) - beforeWrites, 1);
  assert.equal(runtime.database.load().activeSession.id, session.id);
  assert.deepEqual(runtime.database.load().activeSession, session);

  const writesBeforeReplay = snapshotWriteCount(runtime.storage);
  const replayedStart = start(runtime);
  assert.deepEqual(replayedStart, session);
  assert.equal(snapshotWriteCount(runtime.storage), writesBeforeReplay);

  const writesBeforeCollision = snapshotWriteCount(runtime.storage);
  assert.throws(
    () => start(runtime, { commandKey: 'start_collision' }),
    (error) => error && error.code === 'SESSION_ACTIVE_EXISTS'
  );
  assert.equal(snapshotWriteCount(runtime.storage), writesBeforeCollision);

  runtime.database.commit((draft) => {
    draft.plans[0].title = 'edited after Session start';
    draft.plans[0].revision += 1;
    draft.plans[0].updatedAt += 1;
  });
  assert.notEqual(
    runtime.database.load().activeSession.planSnapshot.title,
    runtime.database.load().plans[0].title
  );
});

test('commands checkpoint exactly once while replay, stale revision and key collision perform zero writes', () => {
  const runtime = createRuntime();
  const initial = start(runtime);
  const stepId = initial.planSnapshot.steps[0].id;
  const command = {
    type: 'start_step',
    expectedSessionRevision: 1,
    commandKey: 'start_step_persisted',
    nowMs: NOW,
    payload: { stepId }
  };
  const before = snapshotWriteCount(runtime.storage);
  const result = runtime.service.execute(command);

  assert.equal(snapshotWriteCount(runtime.storage) - before, 1);
  assert.equal(result.replayed, false);
  assert.equal(result.session.timer.stepId, stepId);

  const afterSuccess = snapshotWriteCount(runtime.storage);
  const replay = runtime.service.execute(command);
  assert.equal(replay.replayed, true);
  assert.equal(snapshotWriteCount(runtime.storage), afterSuccess);

  assert.throws(
    () => runtime.service.execute({
      ...command,
      payload: { stepId: 'different_step' }
    }),
    (error) => error && error.code === 'SESSION_COMMAND_KEY_REUSED'
  );
  assert.throws(
    () => runtime.service.execute({
      type: 'checkpoint',
      expectedSessionRevision: 1,
      commandKey: 'stale',
      nowMs: NOW + 1_000,
      payload: { reason: 'hide' }
    }),
    (error) => error && error.code === 'SESSION_REVISION_CONFLICT'
  );
  assert.equal(snapshotWriteCount(runtime.storage), afterSuccess);
});

test('hide/unload and application rebuild restore the same checkpoint for the origin device', () => {
  const runtime = createRuntime();
  const initial = start(runtime);
  const stepId = initial.planSnapshot.steps[0].id;
  runtime.service.execute({
    type: 'start_step',
    expectedSessionRevision: 1,
    commandKey: 'start_lifecycle_timer',
    nowMs: NOW,
    payload: { stepId }
  });
  const hidden = runtime.service.checkpointOnHide({
    expectedSessionRevision: 2,
    commandKey: 'hide_checkpoint',
    nowMs: NOW + 2_000
  });
  const unloaded = runtime.service.checkpointOnUnload({
    expectedSessionRevision: 3,
    commandKey: 'unload_checkpoint',
    nowMs: NOW + 3_000
  });

  assert.equal(hidden.session.elapsedActiveSeconds, 2);
  assert.equal(unloaded.session.elapsedActiveSeconds, 3);
  assert.equal(unloaded.session.timer.remainingSecondsAtCheckpoint, 297);

  const rebuilt = createRuntime({ storage: runtime.storage });
  const restored = rebuilt.service.restoreOnStartup({
    expectedSessionRevision: 4,
    commandKey: 'startup_restore',
    nowMs: NOW + 4_000
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.session.id, initial.id);
  assert.equal(restored.session.elapsedActiveSeconds, 4);
  assert.equal(restored.session.timer.remainingSecondsAtCheckpoint, 296);
});

test('sub-second elapsed remainder survives persistence and startup recovery', () => {
  const runtime = createRuntime();
  start(runtime);
  const hidden = runtime.service.checkpointOnHide({
    expectedSessionRevision: 1,
    commandKey: 'fractional_hide',
    nowMs: NOW + 500
  });

  assert.equal(hidden.session.elapsedActiveSeconds, 0);
  assert.equal(hidden.session.elapsedRemainderMilliseconds, 500);

  const rebuilt = createRuntime({ storage: runtime.storage });
  const restored = rebuilt.service.restoreOnStartup({
    expectedSessionRevision: 2,
    commandKey: 'fractional_restore',
    nowMs: NOW + 1_000
  });

  assert.equal(restored.ok, true);
  assert.equal(restored.session.elapsedActiveSeconds, 1);
  assert.equal(restored.session.elapsedRemainderMilliseconds, 0);
});

test('paused business progression performs zero writes until resume', () => {
  const runtime = createRuntime();
  const manualPlan = clone(runtime.plans.find((plan) =>
    plan.steps.some(({ kind }) => kind === 'manual')
  ));
  manualPlan.id = 'plan_paused_progression';
  manualPlan.steps = [{
    ...manualPlan.steps.find(({ kind }) => kind === 'manual'),
    order: 1
  }];
  runtime.database.commit((draft) => {
    draft.plans.push(manualPlan);
  });
  const session = runtime.service.startSession({
    planId: manualPlan.id,
    commandKey: 'paused_progression_start',
    nowMs: NOW
  });
  const stepId = session.planSnapshot.steps[0].id;
  runtime.service.execute({
    type: 'pause',
    expectedSessionRevision: 1,
    commandKey: 'paused_progression_pause',
    nowMs: NOW + 1_000,
    payload: { reason: 'user' }
  });
  const beforeRejectedCommand = clone(runtime.database.load().activeSession);
  const writesBeforeRejectedCommand = snapshotWriteCount(runtime.storage);

  assert.throws(
    () => runtime.service.execute({
      type: 'complete_step',
      expectedSessionRevision: 2,
      commandKey: 'paused_progression_rejected',
      nowMs: NOW + 2_000,
      payload: { stepId }
    }),
    (error) => error && error.code === 'SESSION_STATUS_INVALID'
  );
  assert.equal(snapshotWriteCount(runtime.storage), writesBeforeRejectedCommand);
  assert.deepEqual(runtime.database.load().activeSession, beforeRejectedCommand);

  runtime.service.execute({
    type: 'resume',
    expectedSessionRevision: 2,
    commandKey: 'paused_progression_resume',
    nowMs: NOW + 3_000,
    payload: { reason: 'user' }
  });
  const completed = runtime.service.execute({
    type: 'complete_step',
    expectedSessionRevision: 3,
    commandKey: 'paused_progression_complete',
    nowMs: NOW + 4_000,
    payload: { stepId }
  }).session;

  assert.equal(completed.status, 'completed');
  assert.equal(snapshotWriteCount(runtime.storage) - writesBeforeRejectedCommand, 2);
});

test('startup recovery persists TimerEngine rollback tolerance and clock anomaly boundaries', () => {
  for (const rollbackMilliseconds of [1, 5_000, 5_001]) {
    const runtime = createRuntime();
    const session = start(runtime, {
      commandKey: `rollback_integration_start_${rollbackMilliseconds}`
    });
    runtime.service.execute({
      type: 'start_step',
      expectedSessionRevision: 1,
      commandKey: `rollback_integration_timer_${rollbackMilliseconds}`,
      nowMs: NOW,
      payload: { stepId: session.planSnapshot.steps[0].id }
    });
    const anchored = runtime.service.checkpointOnHide({
      expectedSessionRevision: 2,
      commandKey: `rollback_integration_anchor_${rollbackMilliseconds}`,
      nowMs: NOW + 10_000
    }).session;
    const rebuilt = createRuntime({ storage: runtime.storage });
    const beforeRestore = snapshotWriteCount(runtime.storage);
    const restoreAt = anchored.lastCheckpointAt - rollbackMilliseconds;
    const restored = rebuilt.service.restoreOnStartup({
      expectedSessionRevision: 3,
      commandKey: `rollback_integration_restore_${rollbackMilliseconds}`,
      nowMs: restoreAt
    });

    assert.equal(restored.ok, true);
    assert.equal(snapshotWriteCount(runtime.storage) - beforeRestore, 1);
    assert.equal(restored.session.lastCheckpointAt, anchored.lastCheckpointAt);
    assert.equal(restored.session.elapsedActiveSeconds, anchored.elapsedActiveSeconds);

    if (rollbackMilliseconds <= 5_000) {
      assert.equal(restored.session.status, 'in_progress');
      assert.equal(restored.session.timer.status, 'running');
      assert.equal(restored.session.timer.checkpointAt, restoreAt);
      continue;
    }

    assert.equal(restored.session.status, 'paused');
    assert.equal(restored.session.timer.status, 'paused');
    assert.equal(restored.session.timer.pauseReason, 'clock-anomaly');
    assert.equal(restored.session.timer.requiresConfirmation, true);
    const confirmed = rebuilt.service.execute({
      type: 'confirm_clock_anomaly',
      expectedSessionRevision: 4,
      commandKey: 'rollback_integration_confirm',
      nowMs: restoreAt,
      payload: { reason: 'clock-confirmed' }
    }).session;
    assert.equal(confirmed.status, 'in_progress');
    assert.equal(confirmed.timer.status, 'running');
  }
});

test('non-origin device cannot continue and restore returns a recoverable error without writes', () => {
  const runtime = createRuntime();
  start(runtime);
  const otherDevice = createRuntime({ storage: runtime.storage, deviceId: 'device_other' });
  const before = snapshotWriteCount(runtime.storage);
  const restored = otherDevice.service.restoreOnShow({
    expectedSessionRevision: 1,
    commandKey: 'other_device_show',
    nowMs: NOW + 1_000
  });

  assert.equal(restored.ok, false);
  assert.equal(restored.error.code, 'SESSION_DEVICE_MISMATCH');
  assert.equal(restored.error.recoverable, true);
  assert.equal(snapshotWriteCount(runtime.storage), before);
  assert.equal(runtime.database.load().activeSession.originDeviceId, 'device_origin');
});

test('corrupt Session snapshots return recoverable state and preserve every stored byte', () => {
  const runtime = createRuntime();
  const session = start(runtime);
  runtime.service.execute({
    type: 'start_step',
    expectedSessionRevision: 1,
    commandKey: 'corrupt_timer_source',
    nowMs: NOW,
    payload: { stepId: session.planSnapshot.steps[0].id }
  });
  runtime.service.checkpointOnHide({
    expectedSessionRevision: 2,
    commandKey: 'corrupt_timer_checkpoint',
    nowMs: NOW + 1_000
  });

  for (const key of [`${SLOT_PREFIX}a`, `${SLOT_PREFIX}b`]) {
    const snapshot = clone(runtime.storage.values.get(key));
    if (!snapshot || !snapshot.activeSession) continue;
    snapshot.activeSession.timer.stepId = 'wrong_step_identity';
    delete snapshot.checksum;
    snapshot.checksum = computeChecksum(snapshot);
    runtime.storage.values.set(key, snapshot);
  }
  const before = clone([...runtime.storage.values.entries()]);
  const recovered = runtime.service.restoreOnStartup({
    expectedSessionRevision: 3,
    commandKey: 'corrupt_restore',
    nowMs: NOW + 2_000
  });

  assert.equal(recovered.ok, false);
  assert.equal(recovered.error.code, 'SESSION_RECOVERY_REQUIRED');
  assert.equal(recovered.error.recoverable, true);
  assert.deepEqual([...runtime.storage.values.entries()], before);
});

test('checksum-valid impossible Session state fails load and startup recovery without rewriting data', () => {
  const runtime = createRuntime();
  const session = start(runtime);
  runtime.service.execute({
    type: 'start_step',
    expectedSessionRevision: 1,
    commandKey: 'forged_matrix_timer',
    nowMs: NOW,
    payload: { stepId: session.planSnapshot.steps[0].id }
  });
  runtime.service.checkpointOnHide({
    expectedSessionRevision: 2,
    commandKey: 'forged_matrix_checkpoint',
    nowMs: NOW + 500
  });

  for (const key of [`${SLOT_PREFIX}a`, `${SLOT_PREFIX}b`]) {
    const snapshot = clone(runtime.storage.values.get(key));
    if (!snapshot || !snapshot.activeSession || snapshot.activeSession.timer === null) continue;
    snapshot.activeSession.status = 'paused';
    delete snapshot.checksum;
    snapshot.checksum = computeChecksum(snapshot);
    runtime.storage.values.set(key, snapshot);
  }
  const before = clone([...runtime.storage.values.entries()]);

  assert.throws(() => runtime.database.load(), /session|status|timer|paused|running/i);
  const recovered = runtime.service.restoreOnStartup({
    expectedSessionRevision: 3,
    commandKey: 'forged_matrix_restore',
    nowMs: NOW + 1_000
  });

  assert.equal(recovered.ok, false);
  assert.equal(recovered.error.code, 'SESSION_RECOVERY_REQUIRED');
  assert.equal(recovered.error.recoverable, true);
  assert.deepEqual([...runtime.storage.values.entries()], before);
});

test('checksum-valid missing current set history fails startup recovery without rewriting data', () => {
  const runtime = createRuntime();
  const strengthPlan = clone(runtime.plans[0]);
  strengthPlan.id = 'plan_strength_recovery';
  strengthPlan.trainingDate = '2026-08-10';
  strengthPlan.steps = [{ ...strengthPlan.steps[3], order: 1 }];
  runtime.database.commit((draft) => {
    draft.plans.push(strengthPlan);
  });
  const session = runtime.service.startSession({
    planId: strengthPlan.id,
    commandKey: 'missing_set_history_start',
    nowMs: NOW
  });
  runtime.service.execute({
    type: 'complete_set',
    expectedSessionRevision: 1,
    commandKey: 'missing_set_history_complete',
    nowMs: NOW + 1_000,
    payload: {
      stepId: session.planSnapshot.steps[0].id,
      setNumber: 1,
      reps: 12,
      weightKg: 20
    }
  });
  runtime.service.checkpointOnHide({
    expectedSessionRevision: 2,
    commandKey: 'missing_set_history_checkpoint',
    nowMs: NOW + 1_500
  });

  for (const key of [`${SLOT_PREFIX}a`, `${SLOT_PREFIX}b`]) {
    const snapshot = clone(runtime.storage.values.get(key));
    assert.equal(snapshot.activeSession.currentSet, 2);
    assert.equal(snapshot.activeSession.timer.mode, 'rest');
    snapshot.activeSession.stepResults = [];
    delete snapshot.checksum;
    snapshot.checksum = computeChecksum(snapshot);
    runtime.storage.values.set(key, snapshot);
  }
  const before = clone([...runtime.storage.values.entries()]);
  const beforeWrites = snapshotWriteCount(runtime.storage);

  assert.throws(() => runtime.database.load(), /session|currentSet|stepResult/i);
  const recovered = runtime.service.restoreOnStartup({
    expectedSessionRevision: 3,
    commandKey: 'missing_set_history_restore',
    nowMs: NOW + 2_000
  });

  assert.equal(recovered.ok, false);
  assert.equal(recovered.error.code, 'SESSION_RECOVERY_REQUIRED');
  assert.equal(recovered.error.recoverable, true);
  assert.equal(snapshotWriteCount(runtime.storage), beforeWrites);
  assert.deepEqual([...runtime.storage.values.entries()], before);
});

test('checksum-valid missing rest, forged duration and terminal shape fail recovery without writes', () => {
  const scenarios = [
    {
      name: 'missing-required-rest',
      prepare() {
        const runtime = createRuntime();
        const strengthPlan = clone(runtime.plans[0]);
        strengthPlan.id = 'plan_required_rest_recovery';
        strengthPlan.trainingDate = '2026-08-11';
        strengthPlan.steps = [{ ...strengthPlan.steps[3], order: 1 }];
        runtime.database.commit((draft) => {
          draft.plans.push(strengthPlan);
        });
        const session = runtime.service.startSession({
          planId: strengthPlan.id,
          commandKey: 'required_rest_start',
          nowMs: NOW
        });
        runtime.service.execute({
          type: 'complete_set',
          expectedSessionRevision: 1,
          commandKey: 'required_rest_complete',
          nowMs: NOW + 1_000,
          payload: {
            stepId: session.planSnapshot.steps[0].id,
            setNumber: 1,
            reps: 12,
            weightKg: 20
          }
        });
        runtime.service.checkpointOnHide({
          expectedSessionRevision: 2,
          commandKey: 'required_rest_checkpoint',
          nowMs: NOW + 1_500
        });
        return {
          runtime,
          expectedSessionRevision: 3,
          mutate(activeSession) {
            assert.equal(activeSession.currentSet, 2);
            assert.equal(activeSession.timer.mode, 'rest');
            activeSession.timer = null;
          }
        };
      }
    },
    {
      name: 'forged-planned-duration',
      prepare() {
        const runtime = createRuntime();
        const session = start(runtime, { commandKey: 'forged_duration_start' });
        runtime.service.execute({
          type: 'start_step',
          expectedSessionRevision: 1,
          commandKey: 'forged_duration_timer',
          nowMs: NOW,
          payload: { stepId: session.planSnapshot.steps[0].id }
        });
        runtime.service.checkpointOnHide({
          expectedSessionRevision: 2,
          commandKey: 'forged_duration_checkpoint',
          nowMs: NOW + 500
        });
        return {
          runtime,
          expectedSessionRevision: 3,
          mutate(activeSession) {
            assert.equal(activeSession.planSnapshot.steps[0].durationSeconds, 300);
            const timer = activeSession.timer;
            timer.durationSeconds = 1;
            timer.expectedEndAt = timer.startedAt + 1_000;
            timer.remainingSecondsAtCheckpoint = Math.ceil(
              (timer.expectedEndAt - timer.checkpointAt) / 1_000
            );
          }
        };
      }
    },
    {
      name: 'forged-completed-position',
      prepare() {
        const runtime = createRuntime();
        const singlePlan = clone(runtime.plans[0]);
        singlePlan.id = 'plan_terminal_shape_recovery';
        singlePlan.trainingDate = '2026-08-12';
        singlePlan.steps = [{ ...singlePlan.steps[0], order: 1 }];
        runtime.database.commit((draft) => {
          draft.plans.push(singlePlan);
        });
        const session = runtime.service.startSession({
          planId: singlePlan.id,
          commandKey: 'terminal_shape_recovery_start',
          nowMs: NOW
        });
        runtime.service.execute({
          type: 'start_step',
          expectedSessionRevision: 1,
          commandKey: 'terminal_shape_recovery_timer',
          nowMs: NOW,
          payload: { stepId: session.planSnapshot.steps[0].id }
        });
        const terminal = runtime.service.execute({
          type: 'confirm_next',
          expectedSessionRevision: 2,
          commandKey: 'terminal_shape_recovery_complete',
          nowMs: NOW + 300_000,
          payload: { stepId: session.planSnapshot.steps[0].id }
        }).session;
        return {
          runtime,
          expectedSessionRevision: 3,
          mutate(activeSession) {
            Object.assign(activeSession, clone(terminal));
            activeSession.currentStepIndex = 0;
            activeSession.stepResults[0].status = 'in_progress';
            activeSession.stepResults[0].completedAt = null;
          }
        };
      }
    }
  ];

  for (const scenario of scenarios) {
    const { runtime, expectedSessionRevision, mutate } = scenario.prepare();
    for (const key of [`${SLOT_PREFIX}a`, `${SLOT_PREFIX}b`]) {
      const snapshot = clone(runtime.storage.values.get(key));
      assert.ok(snapshot && snapshot.activeSession, `${scenario.name} requires both active slots`);
      mutate(snapshot.activeSession);
      delete snapshot.checksum;
      snapshot.checksum = computeChecksum(snapshot);
      runtime.storage.values.set(key, snapshot);
    }
    const before = clone([...runtime.storage.values.entries()]);
    const beforeWrites = snapshotWriteCount(runtime.storage);

    assert.throws(
      () => runtime.database.load(),
      /session|timer|rest|duration|completed|currentStepIndex|stepResult/i,
      scenario.name
    );
    const recovered = runtime.service.restoreOnStartup({
      expectedSessionRevision,
      commandKey: `${scenario.name}_restore`,
      nowMs: NOW + 301_000
    });

    assert.equal(recovered.ok, false, scenario.name);
    assert.equal(recovered.error.code, 'SESSION_RECOVERY_REQUIRED', scenario.name);
    assert.equal(recovered.error.recoverable, true, scenario.name);
    assert.equal(snapshotWriteCount(runtime.storage), beforeWrites, scenario.name);
    assert.deepEqual([...runtime.storage.values.entries()], before, scenario.name);
  }
});

test('application replaces completed and aborted Sessions while terminal commands remain rejected', () => {
  for (const terminalStatus of ['completed', 'aborted']) {
    const ids = [`session_${terminalStatus}`, `session_after_${terminalStatus}`];
    const runtime = createRuntime({ idFactory: () => ids.shift() });
    let terminal;

    if (terminalStatus === 'completed') {
      const singlePlan = clone(runtime.plans[0]);
      singlePlan.id = 'plan_single_completed';
      singlePlan.steps = [{ ...singlePlan.steps[0], order: 1 }];
      runtime.database.commit((draft) => {
        draft.plans.push(singlePlan);
      });
      const started = runtime.service.startSession({
        planId: singlePlan.id,
        commandKey: 'terminal_completed_start',
        nowMs: NOW
      });
      runtime.service.execute({
        type: 'start_step',
        expectedSessionRevision: 1,
        commandKey: 'terminal_completed_step_start',
        nowMs: NOW,
        payload: { stepId: started.planSnapshot.steps[0].id }
      });
      terminal = runtime.service.execute({
        type: 'confirm_next',
        expectedSessionRevision: 2,
        commandKey: 'terminal_completed_step_finish',
        nowMs: NOW + 300_000,
        payload: { stepId: started.planSnapshot.steps[0].id }
      }).session;
    } else {
      start(runtime, { commandKey: 'terminal_aborted_start' });
      terminal = runtime.service.execute({
        type: 'abort',
        expectedSessionRevision: 1,
        commandKey: 'terminal_aborted_finish',
        nowMs: NOW + 1_000,
        payload: { reason: 'user' }
      }).session;
    }

    assert.equal(terminal.status, terminalStatus);
    assert.throws(
      () => runtime.service.execute({
        type: 'checkpoint',
        expectedSessionRevision: terminal.sessionRevision,
        commandKey: `terminal_${terminalStatus}_rejected`,
        nowMs: terminal.endedAt + 1,
        payload: { reason: 'manual' }
      }),
      (error) => error && error.code === 'SESSION_TERMINAL'
    );

    const beforeReplacement = snapshotWriteCount(runtime.storage);
    const replacement = runtime.service.startSession({
      planId: runtime.plans[0].id,
      commandKey: `replacement_after_${terminalStatus}`,
      nowMs: terminal.endedAt + 2
    });

    assert.equal(replacement.id, `session_after_${terminalStatus}`);
    assert.equal(replacement.status, 'in_progress');
    assert.equal(snapshotWriteCount(runtime.storage) - beforeReplacement, 1);
    assert.deepEqual(runtime.database.load().activeSession, replacement);
  }
});

test('storage failure exposes the error and leaves the previously committed Session readable', () => {
  const runtime = createRuntime();
  const session = start(runtime);
  const before = clone(runtime.database.load().activeSession);
  runtime.storage.failNextSlotWrite();

  assert.throws(
    () => runtime.service.execute({
      type: 'start_step',
      expectedSessionRevision: 1,
      commandKey: 'write_failure',
      nowMs: NOW,
      payload: { stepId: session.planSnapshot.steps[0].id }
    }),
    /injected slot write failure/
  );
  assert.deepEqual(runtime.database.load().activeSession, before);
});
