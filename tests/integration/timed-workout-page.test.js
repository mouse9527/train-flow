const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  createTimedWorkoutRuntime
} = require('../../miniprogram/application/timed-workout-runtime');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const { StorageDouble, clone } = require('../helpers/storage-double');

const START_AT = 1785717300000; // 2026-08-03 08:35 Asia/Shanghai

function createHarness({ storage = new StorageDouble(), nowMs = START_AT } = {}) {
  let clock = nowMs;
  let commandSequence = 0;
  const notifications = [];
  const database = createLocalDatabase({ storage, now: () => clock });
  const plans = createDefaultPlans({ now: () => START_AT });
  database.commit((draft) => {
    draft.install = { deviceId: 'device_timed_page', createdAt: START_AT };
    draft.plans.push(...clone(plans));
  });
  const runtime = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_timed_page',
    commandKeyFactory: (type) => `page_${type}_${++commandSequence}`,
    notifyExpired: (occurrenceId) => notifications.push(occurrenceId)
  });
  return {
    database,
    notifications,
    plans,
    runtime,
    storage,
    setNow(value) {
      clock = value;
    }
  };
}

test('timed page runtime renders the confirmed workout facts and revisioned running controls', () => {
  const harness = createHarness();
  const loaded = harness.runtime.load({ planId: harness.plans[0].id });
  assert.equal(loaded.state, 'ready');
  assert.equal(loaded.step.name, '跑步机热身');
  assert.equal(loaded.positionLabel, '动作 1 / 7');
  assert.equal(loaded.elapsedLabel, '00:00');
  assert.equal(loaded.currentClockLabel, '08:35');
  assert.equal(loaded.recommendedEndLabel, '建议 09:10 前结束');
  assert.match(loaded.targetsLabel, /4\.0–4\.5 km\/h/);
  assert.match(loaded.targetsLabel, /坡度 0%/);
  assert.equal(loaded.timerLabel, '05:00');
  assert.equal(loaded.controls.start.disabled, false);
  assert.equal(loaded.controls.pause.disabled, true);

  const running = harness.runtime.start();
  assert.equal(running.state, 'running');
  assert.equal(running.controls.pause.disabled, false);
  assert.equal(running.controls.resume.disabled, true);

  harness.setNow(START_AT + 10_000);
  const paused = harness.runtime.pause();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.timerLabel, '04:50');
  assert.equal(paused.controls.resume.disabled, false);

  const extended = harness.runtime.adjustTimer(30);
  assert.equal(extended.timerLabel, '05:20');
  harness.setNow(START_AT + 20_000);
  const resumed = harness.runtime.resume();
  assert.equal(resumed.state, 'running');
  assert.equal(resumed.sessionRevision, 5);
  assert.deepEqual(
    harness.database.load().activeSession.processedCommands.map(({ type }) => type),
    ['start_session', 'start_step', 'pause', 'adjust_timer', 'resume']
  );
});

test('08:35 start, 08:37 hide and 08:41 show expires only the current step and notifies once', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();

  harness.setNow(START_AT + 2 * 60_000);
  harness.runtime.onHide();
  harness.setNow(START_AT + 6 * 60_000);
  const expired = harness.runtime.onShow();
  assert.equal(expired.state, 'expired-awaiting-confirmation');
  assert.equal(expired.currentStepIndex, 0);
  assert.equal(expired.step.name, '跑步机热身');
  assert.equal(expired.timerLabel, '00:00');
  assert.equal(expired.showNextConfirmation, true);
  assert.equal(expired.controls.next.disabled, false);
  assert.equal(expired.controls.skip.disabled, true);
  assert.equal(expired.controls.earlyComplete.disabled, true);
  assert.equal(harness.notifications.length, 1);

  harness.setNow(START_AT + 6 * 60_000 + 5_000);
  const repeated = harness.runtime.onShow();
  assert.equal(repeated.currentStepIndex, 0);
  assert.equal(harness.notifications.length, 1);

  harness.setNow(START_AT + 6 * 60_000 + 10_000);
  const next = harness.runtime.confirmNext();
  assert.equal(next.currentStepIndex, 1);
  assert.equal(next.step.name, '跑步机快走');
  assert.equal(next.state, 'running');
  assert.equal(next.timerLabel, '12:00');
});

test('expired occurrence notification stays deduplicated after runtime and page reconstruction', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();
  harness.setNow(START_AT + 6 * 60_000);

  const expired = harness.runtime.onShow();
  assert.equal(expired.state, 'expired-awaiting-confirmation');
  assert.equal(harness.notifications.length, 1);

  let rebuiltSequence = 0;
  const rebuilt = createTimedWorkoutRuntime({
    database: createLocalDatabase({
      storage: harness.storage,
      now: () => START_AT + 6 * 60_000 + 1_000
    }),
    now: () => START_AT + 6 * 60_000 + 1_000,
    idFactory: () => 'must_restore_existing_session',
    commandKeyFactory: (type) => `rebuilt_${type}_${++rebuiltSequence}`,
    notifyExpired: (occurrenceId) => harness.notifications.push(occurrenceId)
  });

  const restored = rebuilt.load({});
  assert.equal(restored.state, 'expired-awaiting-confirmation');
  assert.equal(restored.currentStepIndex, 0);
  assert.equal(harness.notifications.length, 1);
  assert.equal(new Set(harness.notifications).size, 1);
});

test('notification claim pointer failure stays retryable and rebuild delivers the occurrence', () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const innerDatabase = createLocalDatabase({ storage, now: () => clock });
  const plans = createDefaultPlans({ now: () => START_AT });
  innerDatabase.commit((draft) => {
    draft.install = { deviceId: 'device_notification_pointer_failure', createdAt: START_AT };
    draft.plans.push(...clone(plans));
  });

  let failNotificationPointer = true;
  const database = {
    load() {
      return innerDatabase.load();
    },
    commit(mutator, expectedRevision) {
      const before = innerDatabase.load();
      const preview = clone(before);
      mutator(preview);
      if (
        failNotificationPointer &&
        JSON.stringify(preview.notifications) !== JSON.stringify(before.notifications)
      ) {
        failNotificationPointer = false;
        storage.failNextWrite(
          'train_flow:v1:db:active',
          new Error('notification pointer write unavailable')
        );
      }
      return innerDatabase.commit(mutator, expectedRevision);
    }
  };
  const delivered = [];
  let firstSequence = 0;
  const first = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_notification_pointer_failure',
    commandKeyFactory: (type) => `notification_first_${type}_${++firstSequence}`,
    notifyExpired: (occurrenceId) => delivered.push(occurrenceId)
  });
  first.load({ planId: plans[0].id });
  first.start();
  clock = START_AT + 6 * 60_000;

  const expired = first.onShow();
  assert.equal(expired.state, 'expired-awaiting-confirmation');
  assert.equal(delivered.length, 0, 'ambiguous claim commit must not send before takeover');
  const ambiguous = innerDatabase.load();
  assert.deepEqual(
    ambiguous.notifications.expiredOccurrences,
    [],
    'a claim cannot be persisted as a terminal delivered occurrence'
  );

  let rebuiltSequence = 0;
  const rebuilt = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage, now: () => clock + 1_000 }),
    now: () => clock + 1_000,
    idFactory: () => 'must_restore_notification_pointer_failure',
    commandKeyFactory: (type) => `notification_rebuilt_${type}_${++rebuiltSequence}`,
    notifyExpired: (occurrenceId) => delivered.push(occurrenceId)
  });
  const restored = rebuilt.load({});
  assert.equal(restored.state, 'expired-awaiting-confirmation');
  assert.equal(delivered.length, 1);
  const finalSnapshot = rebuilt.database.load();
  assert.deepEqual(finalSnapshot.notifications.expiredOccurrences, delivered);

  rebuilt.render();
  assert.equal(delivered.length, 1, 'confirmed delivery must stay deduplicated');
});

test('asynchronous notification API failure requeues the attempted delivery for rebuilt runtime retry', async () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const database = createLocalDatabase({ storage, now: () => clock });
  const plans = createDefaultPlans({ now: () => START_AT });
  database.commit((draft) => {
    draft.install = { deviceId: 'device_notification_api_failure', createdAt: START_AT };
    draft.plans.push(...clone(plans));
  });

  let attempts = 0;
  let rejectFirstAttempt;
  let firstSequence = 0;
  const first = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_notification_api_failure',
    commandKeyFactory: (type) => `notification_api_first_${type}_${++firstSequence}`,
    notifyExpired() {
      attempts += 1;
      const pendingAttempt = new Promise((resolve, reject) => {
        rejectFirstAttempt = reject;
      });
      pendingAttempt.catch(() => {});
      return pendingAttempt;
    }
  });
  first.load({ planId: plans[0].id });
  first.start();
  clock = START_AT + 6 * 60_000;

  const expired = first.onShow();
  assert.equal(expired.state, 'expired-awaiting-confirmation');
  assert.equal(attempts, 1);
  const attempted = database.load();
  assert.equal(attempted.notifications.expiredOccurrences.length, 0);
  assert.equal(attempted.notifications.pendingExpiredOccurrences.length, 0);
  assert.equal(attempted.notifications.attemptedExpiredOccurrences.length, 1);

  rejectFirstAttempt(new Error('notification API unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = database.load();
  assert.equal(pending.notifications.expiredOccurrences.length, 0);
  assert.equal(pending.notifications.pendingExpiredOccurrences.length, 1);
  assert.equal(pending.notifications.attemptedExpiredOccurrences.length, 0);

  const successfulDeliveries = [];
  let rebuiltSequence = 0;
  const rebuilt = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage, now: () => clock + 1_000 }),
    now: () => clock + 1_000,
    idFactory: () => 'must_restore_notification_api_failure',
    commandKeyFactory: (type) => `notification_api_rebuilt_${type}_${++rebuiltSequence}`,
    notifyExpired: (occurrenceId) => {
      attempts += 1;
      successfulDeliveries.push(occurrenceId);
      return Promise.resolve();
    }
  });
  rebuilt.load({});
  assert.equal(attempts, 2);
  assert.equal(successfulDeliveries.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const delivered = rebuilt.database.load();
  assert.deepEqual(delivered.notifications.expiredOccurrences, successfulDeliveries);
  assert.deepEqual(delivered.notifications.pendingExpiredOccurrences, []);
  assert.deepEqual(delivered.notifications.attemptedExpiredOccurrences, []);

  rebuilt.render();
  assert.equal(attempts, 2);
});

test('reentrant runtime retries after the active notification attempt explicitly fails', async () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const database = createLocalDatabase({ storage, now: () => clock });
  const plans = createDefaultPlans({ now: () => START_AT });
  database.commit((draft) => {
    draft.install = { deviceId: 'device_notification_active_failure', createdAt: START_AT };
    draft.plans.push(...clone(plans));
  });

  let seedSequence = 0;
  const seed = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_notification_active_failure',
    commandKeyFactory: (type) => `notification_active_seed_${type}_${++seedSequence}`,
    notifyExpired() {}
  });
  seed.load({ planId: plans[0].id });
  seed.start();
  clock = START_AT + 6 * 60_000;

  let attempts = 0;
  let rejectActiveAttempt;
  let sequenceA = 0;
  const runtimeA = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage, now: () => clock }),
    now: () => clock,
    idFactory: () => 'must_restore_notification_active_failure_a',
    commandKeyFactory: (type) => `notification_active_a_${type}_${++sequenceA}`,
    notifyExpired() {
      attempts += 1;
      const activeAttempt = new Promise((resolve, reject) => {
        rejectActiveAttempt = reject;
      });
      activeAttempt.catch(() => {});
      return activeAttempt;
    }
  });

  const retriedDeliveries = [];
  let sequenceB = 0;
  const runtimeB = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage, now: () => clock }),
    now: () => clock,
    idFactory: () => 'must_restore_notification_active_failure_b',
    commandKeyFactory: (type) => `notification_active_b_${type}_${++sequenceB}`,
    notifyExpired(occurrenceId) {
      attempts += 1;
      retriedDeliveries.push(occurrenceId);
      return Promise.resolve();
    }
  });

  const expiredA = runtimeA.load({});
  assert.equal(expiredA.state, 'expired-awaiting-confirmation');
  assert.equal(attempts, 1);
  const attempted = runtimeA.database.load();
  assert.equal(attempted.notifications.expiredOccurrences.length, 0);
  assert.equal(attempted.notifications.pendingExpiredOccurrences.length, 0);
  assert.equal(attempted.notifications.attemptedExpiredOccurrences.length, 1);

  const expiredB = runtimeB.load({});
  assert.equal(expiredB.state, 'expired-awaiting-confirmation');
  runtimeB.render();
  assert.equal(attempts, 1, 'the active delivery guard must suppress reentrant delivery');

  rejectActiveAttempt(new Error('notification API unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = runtimeA.database.load();
  assert.equal(pending.notifications.expiredOccurrences.length, 0);
  assert.equal(pending.notifications.pendingExpiredOccurrences.length, 1);
  assert.equal(pending.notifications.attemptedExpiredOccurrences.length, 0);

  runtimeB.render();
  assert.equal(attempts, 2, 'the observing runtime must retry after explicit failure');
  assert.equal(retriedDeliveries.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const delivered = runtimeB.database.load();
  assert.deepEqual(delivered.notifications.expiredOccurrences, retriedDeliveries);
  assert.deepEqual(delivered.notifications.pendingExpiredOccurrences, []);
  assert.deepEqual(delivered.notifications.attemptedExpiredOccurrences, []);

  runtimeA.render();
  runtimeB.render();
  assert.equal(attempts, 2);
});

test('successful notification with delivered persistence failure leaves attempted state and never resends', async () => {
  const ACTIVE_KEY = 'train_flow:v1:db:active';
  const SLOT_KEYS = {
    a: 'train_flow:v1:db:a',
    b: 'train_flow:v1:db:b'
  };
  const storage = new StorageDouble();
  let clock = START_AT;
  const innerDatabase = createLocalDatabase({ storage, now: () => clock });
  const plans = createDefaultPlans({ now: () => START_AT });
  innerDatabase.commit((draft) => {
    draft.install = { deviceId: 'device_notification_delivery_failure', createdAt: START_AT };
    draft.plans.push(...clone(plans));
  });

  let failDeliveredWrite = true;
  const database = {
    load() {
      return innerDatabase.load();
    },
    commit(mutator, expectedRevision) {
      const before = innerDatabase.load();
      const preview = clone(before);
      mutator(preview);
      const deliveredBefore = before.notifications.expiredOccurrences.length;
      const deliveredAfter = preview.notifications.expiredOccurrences.length;
      if (failDeliveredWrite && deliveredAfter > deliveredBefore) {
        failDeliveredWrite = false;
        const activeSlot = storage.peek(ACTIVE_KEY);
        const targetSlot = activeSlot === 'a' ? 'b' : 'a';
        storage.failNextWrite(
          SLOT_KEYS[targetSlot],
          new Error('delivered snapshot write unavailable')
        );
      }
      return innerDatabase.commit(mutator, expectedRevision);
    }
  };

  const deliveries = [];
  let resolveDelivery;
  let firstSequence = 0;
  const first = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_notification_delivery_failure',
    commandKeyFactory: (type) => `notification_delivery_first_${type}_${++firstSequence}`,
    notifyExpired(occurrenceId) {
      deliveries.push(occurrenceId);
      return new Promise((resolve) => {
        resolveDelivery = resolve;
      });
    }
  });
  first.load({ planId: plans[0].id });
  first.start();
  clock = START_AT + 6 * 60_000;

  const expired = first.onShow();
  assert.equal(expired.state, 'expired-awaiting-confirmation');
  assert.equal(deliveries.length, 1);
  const inFlight = innerDatabase.load();
  assert.deepEqual(inFlight.notifications.pendingExpiredOccurrences, []);
  assert.deepEqual(inFlight.notifications.attemptedExpiredOccurrences, deliveries);
  assert.deepEqual(inFlight.notifications.expiredOccurrences, []);

  resolveDelivery();
  await new Promise((resolve) => setImmediate(resolve));
  const ambiguousSuccess = innerDatabase.load();
  assert.deepEqual(ambiguousSuccess.notifications.pendingExpiredOccurrences, []);
  assert.deepEqual(ambiguousSuccess.notifications.attemptedExpiredOccurrences, deliveries);
  assert.deepEqual(ambiguousSuccess.notifications.expiredOccurrences, []);

  let rebuiltSequence = 0;
  const rebuilt = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage, now: () => clock + 1_000 }),
    now: () => clock + 1_000,
    idFactory: () => 'must_restore_notification_delivery_failure',
    commandKeyFactory: (type) => `notification_delivery_rebuilt_${type}_${++rebuiltSequence}`,
    notifyExpired: (occurrenceId) => deliveries.push(occurrenceId)
  });
  const restored = rebuilt.load({});
  assert.equal(restored.state, 'expired-awaiting-confirmation');
  rebuilt.render();
  assert.equal(deliveries.length, 1, 'an ambiguous successful attempt must never be sent again');
});

test('reentrant runtimes produce at most one confirmed expiration delivery', () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const database = createLocalDatabase({ storage, now: () => clock });
  const plans = createDefaultPlans({ now: () => START_AT });
  database.commit((draft) => {
    draft.install = { deviceId: 'device_notification_concurrency', createdAt: START_AT };
    draft.plans.push(...clone(plans));
  });
  let seedSequence = 0;
  const seed = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_notification_concurrency',
    commandKeyFactory: (type) => `notification_seed_${type}_${++seedSequence}`,
    notifyExpired() {}
  });
  seed.load({ planId: plans[0].id });
  seed.start();
  clock = START_AT + 6 * 60_000;

  const confirmedDeliveries = [];
  let runtimeB;
  let sequenceA = 0;
  let sequenceB = 0;
  const runtimeA = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage, now: () => clock }),
    now: () => clock,
    idFactory: () => 'must_restore_notification_concurrency_a',
    commandKeyFactory: (type) => `notification_a_${type}_${++sequenceA}`,
    notifyExpired: (occurrenceId) => {
      confirmedDeliveries.push(`a:${occurrenceId}`);
      runtimeB.load({});
    }
  });
  runtimeB = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage, now: () => clock }),
    now: () => clock,
    idFactory: () => 'must_restore_notification_concurrency_b',
    commandKeyFactory: (type) => `notification_b_${type}_${++sequenceB}`,
    notifyExpired: (occurrenceId) => confirmedDeliveries.push(`b:${occurrenceId}`)
  });

  const restored = runtimeA.load({});
  assert.equal(restored.state, 'expired-awaiting-confirmation');
  assert.equal(confirmedDeliveries.length, 1);
  const occurrenceId = confirmedDeliveries[0].split(':').slice(1).join(':');
  const finalSnapshot = runtimeA.database.load();
  assert.deepEqual(finalSnapshot.notifications.expiredOccurrences, [occurrenceId]);
  assert.deepEqual(finalSnapshot.notifications.pendingExpiredOccurrences, []);

  runtimeA.render();
  runtimeB.render();
  assert.equal(confirmedDeliveries.length, 1);
});

test('expired second step disables previous and rejects correction with zero persistence', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();
  harness.setNow(START_AT + 1_000);
  harness.runtime.earlyComplete();
  harness.setNow(harness.runtime.session.timer.expectedEndAt);
  const expired = harness.runtime.onShow();
  const before = harness.database.load();

  assert.equal(expired.state, 'expired-awaiting-confirmation');
  assert.equal(expired.currentStepIndex, 1);
  assert.equal(expired.controls.previous.disabled, true);
  assert.throws(
    () => harness.runtime.previous(),
    (error) => error && error.code === 'SESSION_CONFIRM_NEXT_REQUIRED'
  );
  const after = harness.database.load();
  assert.equal(after.localRevision, before.localRevision);
  assert.equal(after.activeSession.sessionRevision, before.activeSession.sessionRevision);
  assert.equal(after.activeSession.currentStepIndex, 1);
  assert.equal(after.activeSession.timer.status, 'expired');
});

test('skip, early complete and confirm next each persist one atomic revision with next timer started', () => {
  const scenarios = [
    {
      name: 'skip',
      commandType: 'skip_step_and_start_next',
      prepare(harness) {
        harness.runtime.load({ planId: harness.plans[0].id });
        harness.runtime.start();
      },
      act(harness) {
        return harness.runtime.skip();
      }
    },
    {
      name: 'early complete',
      commandType: 'early_complete_step_and_start_next',
      prepare(harness) {
        harness.runtime.load({ planId: harness.plans[0].id });
        harness.runtime.start();
      },
      act(harness) {
        return harness.runtime.earlyComplete();
      }
    },
    {
      name: 'confirm next',
      commandType: 'confirm_next_and_start_next',
      prepare(harness) {
        harness.runtime.load({ planId: harness.plans[0].id });
        harness.runtime.start();
        harness.setNow(START_AT + 6 * 60_000);
        harness.runtime.onShow();
      },
      act(harness) {
        return harness.runtime.confirmNext();
      }
    }
  ];

  for (const scenario of scenarios) {
    const harness = createHarness();
    scenario.prepare(harness);
    const before = harness.database.load();
    const view = scenario.act(harness);
    const after = harness.database.load();

    assert.equal(view.currentStepIndex, 1, scenario.name);
    assert.equal(view.state, 'running', scenario.name);
    assert.equal(view.timerLabel, '12:00', scenario.name);
    assert.equal(after.localRevision, before.localRevision + 1, scenario.name);
    assert.equal(
      after.activeSession.sessionRevision,
      before.activeSession.sessionRevision + 1,
      scenario.name
    );
    assert.equal(after.activeSession.processedCommands.at(-1).type, scenario.commandType);
  }
});

test('atomic next-step command leaves no half progression after back-half storage failure and retry', () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const innerDatabase = createLocalDatabase({ storage, now: () => clock });
  const plans = createDefaultPlans({ now: () => START_AT });
  innerDatabase.commit((draft) => {
    draft.install = { deviceId: 'device_atomic_failure', createdAt: START_AT };
    draft.plans.push(...clone(plans));
  });

  let failAtomicDraft = false;
  const database = {
    load() {
      return innerDatabase.load();
    },
    commit(mutator, expectedRevision) {
      const preview = clone(innerDatabase.load());
      mutator(preview);
      if (
        failAtomicDraft &&
        preview.activeSession &&
        preview.activeSession.currentStepIndex === 1 &&
        preview.activeSession.timer &&
        preview.activeSession.timer.status === 'running'
      ) {
        throw new Error('injected back-half auto-start storage failure');
      }
      return innerDatabase.commit(mutator, expectedRevision);
    }
  };
  let commandSequence = 0;
  const runtime = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_atomic_failure',
    commandKeyFactory: (type) => `atomic_${type}_${++commandSequence}`,
    notifyExpired() {}
  });
  runtime.load({ planId: plans[0].id });
  runtime.start();
  clock = START_AT + 5_000;
  const before = innerDatabase.load();
  failAtomicDraft = true;

  assert.throws(
    () => runtime.skip(),
    /injected back-half auto-start storage failure/
  );
  const afterFailure = innerDatabase.load();
  assert.equal(afterFailure.localRevision, before.localRevision);
  assert.equal(afterFailure.activeSession.currentStepIndex, 0);
  assert.equal(afterFailure.activeSession.timer.status, 'running');

  failAtomicDraft = false;
  const retried = runtime.skip();
  const afterRetry = innerDatabase.load();
  assert.equal(retried.currentStepIndex, 1);
  assert.equal(retried.state, 'running');
  assert.equal(afterRetry.localRevision, before.localRevision + 1);
  assert.equal(
    afterRetry.activeSession.sessionRevision,
    before.activeSession.sessionRevision + 1
  );
  assert.equal(
    afterRetry.activeSession.processedCommands.at(-1).type,
    'skip_step_and_start_next'
  );
});

test('clock rollback is visible, disables ordinary resume and requires explicit confirmation command', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();
  harness.setNow(START_AT + 10_000);
  harness.runtime.onHide();
  harness.setNow(START_AT + 4_999);

  const anomaly = harness.runtime.onShow();
  assert.equal(anomaly.state, 'clock-anomaly-awaiting-confirmation');
  assert.equal(anomaly.requiresConfirmation, true);
  assert.equal(anomaly.controls.resume.disabled, true);
  assert.equal(anomaly.controls.confirmClock.disabled, false);
  assert.throws(
    () => harness.runtime.resume(),
    (error) => error && error.code === 'SESSION_CLOCK_CONFIRMATION_REQUIRED'
  );

  harness.setNow(START_AT + 11_000);
  const confirmed = harness.runtime.confirmClockAnomaly();
  assert.equal(confirmed.state, 'running');
  assert.equal(confirmed.requiresConfirmation, false);
  assert.equal(confirmed.controls.confirmClock.disabled, true);
});

test('skip, previous, early complete and end workout preserve command revisions and valid states', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();
  harness.setNow(START_AT + 5_000);
  const skipped = harness.runtime.skip();
  assert.equal(skipped.currentStepIndex, 1);
  assert.equal(skipped.state, 'running');

  harness.setNow(START_AT + 10_000);
  const previous = harness.runtime.previous();
  assert.equal(previous.currentStepIndex, 0);
  assert.equal(previous.state, 'ready');
  assert.equal(previous.controls.previous.disabled, true);

  harness.runtime.start();
  harness.setNow(START_AT + 15_000);
  const early = harness.runtime.earlyComplete();
  assert.equal(early.currentStepIndex, 1);
  assert.equal(early.state, 'running');

  harness.setNow(START_AT + 20_000);
  const ended = harness.runtime.endWorkout();
  assert.equal(ended.state, 'aborted');
  assert.equal(ended.controls.end.disabled, true);
  assert.deepEqual(
    harness.database.load().activeSession.processedCommands.map(({ type }) => type),
    [
      'start_session',
      'start_step',
      'skip_step_and_start_next',
      'previous_step',
      'start_step',
      'early_complete_step_and_start_next',
      'abort'
    ]
  );
});

test('unload and a new runtime restore the same timer while corruption stays recoverable', () => {
  const harness = createHarness();
  harness.runtime.load({ planId: harness.plans[0].id });
  harness.runtime.start();
  harness.setNow(START_AT + 15_000);
  harness.runtime.onUnload();

  harness.setNow(START_AT + 30_000);
  const restarted = createTimedWorkoutRuntime({
    database: createLocalDatabase({ storage: harness.storage, now: () => START_AT + 30_000 }),
    now: () => START_AT + 30_000,
    idFactory: () => 'must_not_replace_session',
    commandKeyFactory: (type) => `restart_${type}`,
    notifyExpired() {}
  });
  const restored = restarted.load({});
  assert.equal(restored.currentStepIndex, 0);
  assert.equal(restored.state, 'running');
  assert.equal(restored.timerLabel, '04:30');
  assert.equal(restored.sessionId, 'session_timed_page');

  const corrupt = createTimedWorkoutRuntime({
    database: {
      load() {
        throw new Error('Unable to read a valid AppDatabase snapshot: checksum mismatch');
      },
      commit() {
        throw new Error('corrupt storage must not be overwritten');
      }
    },
    now: () => START_AT,
    idFactory: () => 'unused',
    commandKeyFactory: () => 'unused',
    notifyExpired() {}
  });
  const recovery = corrupt.load({ planId: harness.plans[0].id });
  assert.equal(recovery.state, 'recovery-error');
  assert.equal(recovery.recoveryError.recoverable, true);
  assert.match(recovery.recoveryError.message, /checksum|snapshot/i);
});

function pageView(overrides = {}) {
  const enabled = { disabled: false };
  return {
    state: 'running',
    remainingSeconds: 120,
    deadlineReached: false,
    controls: {
      start: enabled,
      pause: enabled,
      resume: enabled,
      previous: enabled,
      next: enabled,
      skip: enabled,
      earlyComplete: enabled,
      subtract30: enabled,
      add30: enabled,
      end: enabled
    },
    ...overrides
  };
}

function createPageHarness({ confirm = true } = {}) {
  const calls = [];
  const runtime = {};
  for (const method of [
    'load', 'render', 'start', 'pause', 'resume', 'previous', 'confirmNext',
    'confirmClockAnomaly', 'skip', 'earlyComplete', 'adjustTimer', 'endWorkout', 'onHide', 'onShow',
    'onUnload', 'materializeDeadline'
  ]) {
    runtime[method] = (...args) => {
      calls.push([method, ...args]);
      return pageView();
    };
  }
  const intervalCallbacks = [];
  const timeoutCallbacks = [];
  const modalTitles = [];
  const wxApi = {
    getAccountInfoSync() {
      return { miniProgram: { envVersion: 'develop' } };
    },
    showModal(options) {
      modalTitles.push(options.title);
      options.success({ confirm, cancel: !confirm });
    },
    showToast({ success }) { success(); },
    vibrateLong({ success }) { success(); },
    setKeepScreenOn() {}
  };
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const definition = createWorkoutPageDefinition({
    runtimeFactory: () => runtime,
    fixtureRuntimeFactory: () => runtime,
    getWx: () => wxApi,
    setIntervalFn(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    clearIntervalFn() {},
    setTimeoutFn(callback) {
      timeoutCallbacks.push(callback);
      return timeoutCallbacks.length;
    },
    clearTimeoutFn() {}
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) {
      this.data = { ...this.data, ...next };
    }
  };
  return { calls, intervalCallbacks, modalTitles, page, timeoutCallbacks };
}

test('expiration adapter waits for callbacks and degrades vibration failure to visual feedback', async () => {
  const vibrateCalls = [];
  const toastCalls = [];
  let deviceAdapterFactory;
  const runtime = {
    load() {
      return pageView();
    }
  };
  const wxApi = {
    vibrateLong(options) {
      vibrateCalls.push(options);
    },
    showToast(options) {
      toastCalls.push(options);
    },
    setKeepScreenOn() {}
  };
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const definition = createWorkoutPageDefinition({
    runtimeFactory(options) {
      deviceAdapterFactory = options.deviceAdapterFactory;
      return runtime;
    },
    getWx: () => wxApi,
    setIntervalFn: () => 1,
    clearIntervalFn() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {}
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) {
      this.data = { ...this.data, ...next };
    }
  };
  page.onLoad({});
  const notificationAdapter = deviceAdapterFactory({
    vibrationEnabled: true,
    soundEnabled: false,
    voiceEnabled: false,
    keepScreenOn: true
  });

  let settled = false;
  const successful = notificationAdapter.notify({
    occurrenceId: 'occurrence_success',
    visualMessage: '计时结束'
  }).then(() => {
    settled = true;
  });
  assert.equal(vibrateCalls.length, 1);
  assert.equal(toastCalls.length, 0);
  await Promise.resolve();
  assert.equal(settled, false, 'synchronous undefined must not count as vibrate success');

  vibrateCalls[0].success();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toastCalls.length, 1);
  assert.equal(settled, false, 'toast must confirm through its success callback');
  toastCalls[0].success();
  await successful;
  assert.equal(settled, true);

  let degradedResult;
  const vibrateFailure = notificationAdapter.notify({
    occurrenceId: 'occurrence_vibrate_failure',
    visualMessage: '计时结束'
  }).then((result) => { degradedResult = result; });
  vibrateCalls[1].fail(new Error('vibrate unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toastCalls.length, 2, 'visual feedback must survive vibration failure');
  toastCalls[1].success();
  await vibrateFailure;
  assert.equal(degradedResult.delivered, true);
  assert.equal(degradedResult.degraded, true);

  const duplicate = await notificationAdapter.notify({
    occurrenceId: 'occurrence_vibrate_failure',
    visualMessage: '计时结束'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(vibrateCalls.length, 2);
});

test('page lifecycle delegates to the runtime while interval refresh never mutates Session state', () => {
  const harness = createPageHarness();
  harness.page.onLoad({ fixture: 'worked-sample', state: 'running', planId: 'ignored' });
  assert.deepEqual(harness.calls[0], ['load', { planId: undefined }]);
  assert.equal(harness.intervalCallbacks.length, 1);
  assert.equal(harness.timeoutCallbacks.length, 1);

  harness.intervalCallbacks[0]();
  assert.equal(harness.calls.at(-1)[0], 'render');
  assert.equal(harness.calls.some(([method]) => method === 'materializeDeadline'), false);

  harness.timeoutCallbacks[0]();
  assert.equal(harness.calls.at(-1)[0], 'materializeDeadline');
  const timeoutCountBeforeHide = harness.timeoutCallbacks.length;
  harness.page.onHide();
  assert.equal(harness.timeoutCallbacks.length, timeoutCountBeforeHide);
  harness.page.onShow();
  harness.page.onUnload();
  assert.deepEqual(
    harness.calls.slice(-3).map(([method]) => method),
    ['onHide', 'onShow', 'onUnload']
  );
});

test('PR review: page unload destroys the runtime adapter once after checkpoint success or throw', async (t) => {
  for (const checkpointMode of ['success', 'throw']) {
    await t.test(checkpointMode, () => {
      const storage = new StorageDouble();
      const database = createLocalDatabase({ storage, now: () => START_AT });
      const plan = createDefaultPlans({ now: () => START_AT })[0];
      database.commit((draft) => {
        draft.install = { deviceId: `device_unload_destroy_${checkpointMode}`, createdAt: START_AT };
        draft.plans.push(clone(plan));
      });
      let destroyCount = 0;
      let sequence = 0;
      const runtime = createTimedWorkoutRuntime({
        database,
        now: () => START_AT,
        idFactory: () => `session_unload_destroy_${checkpointMode}`,
        commandKeyFactory: (type) => `unload_destroy_${checkpointMode}_${type}_${++sequence}`,
        deviceAdapterFactory() {
          return {
            setKeepScreen() { return { supported: true }; },
            destroy() { destroyCount += 1; }
          };
        }
      });
      const {
        createWorkoutPageDefinition
      } = require('../../miniprogram/pages/workout/index');
      const definition = createWorkoutPageDefinition({
        runtimeFactory: () => runtime,
        getWx: () => ({}),
        setIntervalFn: () => 1,
        clearIntervalFn() {},
        setTimeoutFn: () => 1,
        clearTimeoutFn() {}
      });
      const page = {
        ...definition,
        data: clone(definition.data),
        setData(next) { this.data = { ...this.data, ...next }; }
      };
      page.onLoad({ planId: plan.id });
      if (checkpointMode === 'throw') {
        runtime.service.checkpointOnUnload = () => {
          throw new Error('checkpoint unload failed');
        };
        assert.throws(() => page.onUnload(), /checkpoint unload failed/);
      } else {
        page.onUnload();
      }
      page.onUnload();
      assert.equal(destroyCount, 1, 'runtime/device adapter destroy must be idempotent');
    });
  }
});

test('PR review: repeated page unload destroys the real InnerAudioContext exactly once', async () => {
  const storage = new StorageDouble();
  const database = createLocalDatabase({ storage, now: () => START_AT + 60_000 });
  const sourcePlan = createDefaultPlans({ now: () => START_AT })
    .find(({ steps }) => steps.some(({ kind }) => kind === 'manual'));
  const plan = {
    ...clone(sourcePlan),
    id: 'plan_audio_destroy_on_unload',
    trainingDate: '2026-08-12',
    templateSource: null,
    steps: [{
      ...clone(sourcePlan.steps.find(({ kind }) => kind === 'manual')),
      id: 'manual_audio_destroy_on_unload',
      order: 1
    }]
  };
  database.commit((draft) => {
    draft.install = { deviceId: 'device_audio_destroy_on_unload', createdAt: START_AT };
    draft.settings.keepScreenOn = true;
    draft.settings.vibrationEnabled = false;
    draft.settings.soundEnabled = true;
    draft.settings.voiceEnabled = false;
    draft.plans.push(plan);
  });
  let audioCreateCount = 0;
  let audioDestroyCount = 0;
  let sequence = 0;
  const wxApi = {
    createInnerAudioContext() {
      audioCreateCount += 1;
      return {
        src: null,
        play() {},
        destroy() { audioDestroyCount += 1; }
      };
    },
    setKeepScreenOn({ success }) { success(); },
    showToast({ success }) { success(); }
  };
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const definition = createWorkoutPageDefinition({
    runtimeFactory({ deviceAdapterFactory }) {
      return createTimedWorkoutRuntime({
        database,
        now: () => START_AT + 60_000,
        idFactory: () => 'session_audio_destroy_on_unload',
        commandKeyFactory: (type) => `audio_destroy_${type}_${++sequence}`,
        deviceAdapterFactory
      });
    },
    getWx: () => wxApi,
    setIntervalFn: () => 1,
    clearIntervalFn() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {}
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) { this.data = { ...this.data, ...next }; }
  };
  page.onLoad({ planId: plan.id });
  page.onStart();
  page.onCompleteManual({
    currentTarget: {
      dataset: {
        stepId: page.data.view.step.id,
        sessionRevision: page.data.view.sessionRevision
      }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(database.load().activeSession.status, 'completed');
  assert.equal(audioCreateCount, 1);

  page.onUnload();
  page.onUnload();
  assert.equal(audioDestroyCount, 1);
});

test('develop strength mode selects the deterministic fixture while release and planId navigation stay production-backed', () => {
  const calls = [];
  const productionRuntime = {
    load(input) {
      calls.push(['production.load', input]);
      return pageView();
    }
  };
  const fixtureRuntime = {
    load(input) {
      calls.push(['fixture.load', input]);
      return pageView();
    }
  };
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const makePage = (envVersion) => {
    const definition = createWorkoutPageDefinition({
      runtimeFactory(options) {
        calls.push(['production.factory', options]);
        return productionRuntime;
      },
      fixtureRuntimeFactory(options) {
        calls.push(['fixture.factory', options]);
        return fixtureRuntime;
      },
      getWx: () => ({
        getAccountInfoSync() {
          return { miniProgram: { envVersion } };
        },
        setKeepScreenOn() {}
      }),
      setIntervalFn: () => 1,
      clearIntervalFn() {},
      setTimeoutFn: () => 1,
      clearTimeoutFn() {}
    });
    return {
      ...definition,
      data: clone(definition.data),
      setData(next) { this.data = { ...this.data, ...next }; }
    };
  };

  makePage('develop').onLoad({ mode: 'strength', state: 'rest' });
  assert.equal(calls[0][0], 'fixture.factory');
  assert.equal(calls[0][1].mode, 'strength');
  assert.equal(calls[0][1].state, 'rest');
  assert.deepEqual(calls[1], ['fixture.load', { planId: undefined }]);

  calls.length = 0;
  makePage('release').onLoad({ mode: 'strength', state: 'expired' });
  assert.equal(calls[0][0], 'production.factory');
  assert.deepEqual(calls[1], ['production.load', { planId: undefined }]);

  calls.length = 0;
  makePage('develop').onLoad({ planId: 'plan_normal_navigation' });
  assert.equal(calls[0][0], 'production.factory');
  assert.deepEqual(calls[1], ['production.load', { planId: 'plan_normal_navigation' }]);
});

test('destructive and irreversible page controls require explicit confirmation', () => {
  const confirmed = createPageHarness({ confirm: true });
  confirmed.page.onLoad({});
  confirmed.page.onSkip();
  confirmed.page.onEarlyComplete();
  confirmed.page.onEndWorkout();
  assert.deepEqual(confirmed.modalTitles, ['跳过这个动作？', '提前完成这个动作？', '结束本次训练？']);
  assert.equal(confirmed.calls.filter(([method]) => method === 'skip').length, 1);
  assert.equal(confirmed.calls.filter(([method]) => method === 'earlyComplete').length, 1);
  assert.equal(confirmed.calls.filter(([method]) => method === 'endWorkout').length, 1);

  const cancelled = createPageHarness({ confirm: false });
  cancelled.page.onLoad({});
  cancelled.page.onEndWorkout();
  assert.equal(cancelled.calls.some(([method]) => method === 'endWorkout'), false);
});

test('Attack: repeated Skip taps share one pending confirmation and cannot skip the following exercise', () => {
  const calls = [];
  const pendingModals = [];
  const runtime = {
    load() { return pageView(); },
    skip() {
      calls.push('skip');
      return pageView();
    }
  };
  const wxApi = {
    showModal(options) { pendingModals.push(options); },
    setKeepScreenOn() {}
  };
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const definition = createWorkoutPageDefinition({
    runtimeFactory: () => runtime,
    getWx: () => wxApi,
    setIntervalFn: () => 1,
    clearIntervalFn() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {}
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) { this.data = { ...this.data, ...next }; }
  };
  page.onLoad({});

  page.onSkip();
  page.onSkip();
  assert.equal(
    pendingModals.length,
    1,
    'a second tap while confirmation is pending must not create a second destructive intent'
  );
  pendingModals[0].success({ confirm: true, cancel: false });
  assert.deepEqual(calls, ['skip']);
});

test('Attack: an unloaded page invalidates pending Skip callbacks before they can mutate Session state', () => {
  const calls = [];
  const pendingModals = [];
  const runtime = {
    load() { return pageView(); },
    onUnload() {
      calls.push('onUnload');
      return pageView();
    },
    skip() {
      calls.push('skip');
      return pageView();
    }
  };
  const wxApi = {
    showModal(options) { pendingModals.push(options); },
    setKeepScreenOn() {}
  };
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const definition = createWorkoutPageDefinition({
    runtimeFactory: () => runtime,
    getWx: () => wxApi,
    setIntervalFn: () => 1,
    clearIntervalFn() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {}
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) { this.data = { ...this.data, ...next }; }
  };
  page.onLoad({});
  page.onSkip();
  assert.equal(pendingModals.length, 1);

  page.onUnload();
  pendingModals[0].success({ confirm: true, cancel: false });
  pendingModals[0].complete();
  assert.deepEqual(
    calls,
    ['onUnload'],
    'a late modal callback from a destroyed page must not execute a destructive runtime command'
  );
});

test('Attack: repeated zero-rest strength taps keep the original step, set and revision intent with zero second write', () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const database = createLocalDatabase({ storage, now: () => clock });
  const sourcePlan = createDefaultPlans({ now: () => START_AT })
    .find(({ steps }) => steps.some(({ kind }) => kind === 'strength'));
  const sourceStrength = sourcePlan.steps.find(({ kind }) => kind === 'strength');
  const plan = {
    ...clone(sourcePlan),
    id: 'plan_strength_zero_rest_double_tap_page',
    trainingDate: '2026-08-10',
    title: '力量零休息双击页面夹具',
    templateSource: null,
    steps: [{
      ...clone(sourceStrength),
      id: 'strength_zero_rest_double_tap',
      order: 1,
      sets: 2,
      restSeconds: 0
    }]
  };
  database.commit((draft) => {
    draft.install = { deviceId: 'device_strength_zero_rest_page', createdAt: START_AT };
    draft.plans.push(plan);
  });
  let sequence = 0;
  const runtime = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_strength_zero_rest_page',
    commandKeyFactory: (type) => `strength_zero_rest_${type}_${++sequence}`
  });
  const toasts = [];
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const definition = createWorkoutPageDefinition({
    runtimeFactory: () => runtime,
    getWx: () => ({
      setKeepScreenOn() {},
      showToast(options) { toasts.push(options.title); }
    }),
    setIntervalFn: () => 1,
    clearIntervalFn() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {}
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) { this.data = { ...this.data, ...next }; }
  };
  page.onLoad({ planId: plan.id });
  const originalIntent = {
    currentTarget: {
      dataset: {
        stepId: page.data.view.step.id,
        setNumber: page.data.view.strength.currentSet,
        sessionRevision: page.data.view.sessionRevision
      }
    }
  };

  page.onCompleteSet(originalIntent);
  const afterFirst = database.load();
  assert.equal(afterFirst.activeSession.currentSet, 2);
  assert.equal(afterFirst.activeSession.stepResults[0].setResults.length, 1);
  clock += 1;
  page.onCompleteSet(originalIntent);

  const afterSecond = database.load();
  assert.equal(afterSecond.localRevision, afterFirst.localRevision, 'stale second tap must perform zero write');
  assert.equal(afterSecond.activeSession.status, 'in_progress');
  assert.equal(afterSecond.activeSession.currentSet, 2);
  assert.deepEqual(
    afterSecond.activeSession.stepResults[0].setResults.map(({ setNumber }) => setNumber),
    [1]
  );
  assert.equal(
    afterSecond.activeSession.processedCommands.filter(({ type }) => type === 'complete_set').length,
    1
  );
  assert.equal(toasts.length, 1, 'the stale strength intent should fail visibly');
});

test('Attack: repeated manual taps keep the original step and revision intent instead of completing the next action', () => {
  const storage = new StorageDouble();
  let clock = START_AT;
  const database = createLocalDatabase({ storage, now: () => clock });
  const sourcePlan = createDefaultPlans({ now: () => START_AT })
    .find(({ steps }) => steps.some(({ kind }) => kind === 'manual'));
  const sourceManual = sourcePlan.steps.find(({ kind }) => kind === 'manual');
  const plan = {
    ...clone(sourcePlan),
    id: 'plan_manual_double_tap_page',
    trainingDate: '2026-08-10',
    title: '手动双击页面夹具',
    templateSource: null,
    steps: [
      { ...clone(sourceManual), id: 'manual_double_tap_1', order: 1 },
      { ...clone(sourceManual), id: 'manual_double_tap_2', order: 2 }
    ]
  };
  database.commit((draft) => {
    draft.install = { deviceId: 'device_manual_double_tap_page', createdAt: START_AT };
    draft.plans.push(plan);
  });
  let sequence = 0;
  const runtime = createTimedWorkoutRuntime({
    database,
    now: () => clock,
    idFactory: () => 'session_manual_double_tap_page',
    commandKeyFactory: (type) => `manual_double_tap_${type}_${++sequence}`
  });
  const toasts = [];
  const {
    createWorkoutPageDefinition
  } = require('../../miniprogram/pages/workout/index');
  const definition = createWorkoutPageDefinition({
    runtimeFactory: () => runtime,
    getWx: () => ({
      setKeepScreenOn() {},
      showToast(options) { toasts.push(options.title); }
    }),
    setIntervalFn: () => 1,
    clearIntervalFn() {},
    setTimeoutFn: () => 1,
    clearTimeoutFn() {}
  });
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(next) { this.data = { ...this.data, ...next }; }
  };
  page.onLoad({ planId: plan.id });
  const originalIntent = {
    currentTarget: {
      dataset: {
        stepId: page.data.view.step.id,
        sessionRevision: page.data.view.sessionRevision
      }
    }
  };

  page.onCompleteManual(originalIntent);
  clock += 1;
  page.onCompleteManual(originalIntent);

  const persisted = database.load().activeSession;
  assert.equal(persisted.status, 'in_progress');
  assert.equal(persisted.currentStepIndex, 1);
  assert.equal(
    persisted.processedCommands.filter(({ type }) => type === 'complete_step').length,
    1,
    'the stale second tap must not complete the newly rendered manual step'
  );
  assert.equal(toasts.length, 1, 'the stale second intent should fail visibly without mutating Session');
});

test('PR review: terminal keep-screen release settles before summary navigation', async (t) => {
  for (const releaseMode of ['unsupported', 'reject', 'success']) {
    await t.test(releaseMode, async () => {
      const storage = new StorageDouble();
      const database = createLocalDatabase({ storage, now: () => START_AT });
      const sourcePlan = createDefaultPlans({ now: () => START_AT })
        .find(({ steps }) => steps.some(({ kind }) => kind === 'manual'));
      const plan = {
        ...clone(sourcePlan),
        id: `plan_terminal_release_${releaseMode}`,
        trainingDate: '2026-08-11',
        templateSource: null,
        steps: [{
          ...clone(sourcePlan.steps.find(({ kind }) => kind === 'manual')),
          id: `manual_terminal_release_${releaseMode}`,
          order: 1
        }]
      };
      database.commit((draft) => {
        draft.install = { deviceId: `device_terminal_release_${releaseMode}`, createdAt: START_AT };
        draft.settings.keepScreenOn = true;
        draft.settings.vibrationEnabled = false;
        draft.settings.soundEnabled = false;
        draft.settings.voiceEnabled = false;
        draft.plans.push(plan);
      });

      let settleRelease;
      const terminalRelease = new Promise((resolve, reject) => {
        settleRelease = releaseMode === 'reject'
          ? () => reject(new Error('terminal release rejected'))
          : () => resolve({ supported: releaseMode === 'success' });
      });
      let falseCallCount = 0;
      let sequence = 0;
      const runtime = createTimedWorkoutRuntime({
        database,
        now: () => START_AT + 60_000,
        idFactory: () => `session_terminal_release_${releaseMode}`,
        commandKeyFactory: (type) => `terminal_release_${releaseMode}_${type}_${++sequence}`,
        deviceAdapterFactory() {
          return {
            setKeepScreen(enabled) {
              if (!enabled && ++falseCallCount === 2) {
                return terminalRelease;
              }
              return Promise.resolve({ supported: true });
            },
            notify() {
              return Promise.reject(new Error('notification must not mask release result'));
            }
          };
        }
      });
      const modals = [];
      const redirects = [];
      const {
        createWorkoutPageDefinition
      } = require('../../miniprogram/pages/workout/index');
      const definition = createWorkoutPageDefinition({
        runtimeFactory: () => runtime,
        getWx: () => ({
          showModal(options) { modals.push(options); },
          redirectTo(options) { redirects.push(options); }
        }),
        setIntervalFn: () => 1,
        clearIntervalFn() {},
        setTimeoutFn: () => 1,
        clearTimeoutFn() {}
      });
      const page = {
        ...definition,
        data: clone(definition.data),
        setData(next) { this.data = { ...this.data, ...next }; }
      };
      page.onLoad({ planId: plan.id });
      page.onStart();
      page.onCompleteManual({
        currentTarget: {
          dataset: {
            stepId: page.data.view.step.id,
            sessionRevision: page.data.view.sessionRevision
          }
        }
      });

      assert.equal(database.load().activeSession.status, 'completed');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(redirects.length, 0, 'terminal release must settle before redirect');
      assert.equal(modals.length, 0, 'release result is still pending');

      settleRelease();
      await new Promise((resolve) => setImmediate(resolve));
      if (releaseMode === 'success') {
        assert.equal(modals.length, 0);
        assert.equal(redirects.length, 1, 'successful release should navigate automatically');
      } else {
        assert.equal(redirects.length, 0, 'failed release requires acknowledgement before redirect');
        assert.equal(modals.length, 1);
        assert.equal(modals[0].showCancel, false);
        assert.equal(modals[0].confirmText, '查看总结');
        assert.match(`${modals[0].title} ${modals[0].content}`, /常亮.*(?:关闭|释放).*失败/);
        assert.doesNotMatch(`${modals[0].title} ${modals[0].content}`, /设备提醒部分不可用/);
        modals[0].success({ confirm: true, cancel: false });
        modals[0].complete();
        assert.equal(redirects.length, 1, 'acknowledgement should navigate exactly once');
      }
      assert.match(redirects[0].url, /\/pages\/workout\/summary\/index\?sessionId=/);
      const modalCountAfterRedirect = modals.length;
      page.onUnload();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(redirects.length, 1, 'redirect-triggered unload must not navigate again');
      assert.equal(modals.length, modalCountAfterRedirect, 'redirect-triggered unload must not reopen modal');
    });
  }
});

test('workout page declares native timer components, large timer states and thumb-safe controls', () => {
  const root = path.resolve(__dirname, '../..');
  const pageJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/pages/workout/index.json'), 'utf8'));
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/workout/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/workout/index.wxss'), 'utf8');
  assert.deepEqual(pageJson.usingComponents, {
    'timer-display': '/components/timer-display/index'
  });
  for (const copy of ['进入下一步', '提前完成', '+30 秒', '-30 秒', '结束训练']) {
    assert.match(wxml, new RegExp(copy.replace('+', '\\+')));
  }
  assert.match(wxml, /expired-awaiting-confirmation/);
  assert.match(wxml, /requiresConfirmation/);
  assert.match(wxml, /确认时间后继续/);
  assert.match(wxml, /bindtap="onConfirmClockAnomaly"/);
  assert.match(
    wxml,
    /bindtap="onCompleteSet"[^>]*data-step-id="\{\{view\.step\.id\}\}"[^>]*data-set-number="\{\{view\.strength\.currentSet\}\}"[^>]*data-session-revision="\{\{view\.sessionRevision\}\}"/
  );
  assert.match(wxml, /data-step-id="\{\{view\.step\.id\}\}"/);
  assert.match(wxml, /data-session-revision="\{\{view\.sessionRevision\}\}"/);
  assert.match(wxss, /padding-bottom:\s*calc\([^)]*env\(safe-area-inset-bottom\)/);
  assert.match(wxss, /min-height:\s*96rpx/);

  const timerJson = JSON.parse(fs.readFileSync(
    path.join(root, 'miniprogram/components/timer-display/index.json'),
    'utf8'
  ));
  assert.equal(timerJson.component, true);
  assert.equal(timerJson.usingComponents['progress-ring'], '/components/progress-ring/index');
});
