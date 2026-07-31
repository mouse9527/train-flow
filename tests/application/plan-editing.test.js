const assert = require('node:assert/strict');
const test = require('node:test');

const {
  addDraftStep,
  createPlanDraft,
  estimateModeledSeconds,
  moveDraftStep,
  removeDraftStep,
  updateDraftStep,
  validatePlanDraft
} = require('../../miniprogram/domain/planning/plan-editor');
const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createPlanApplicationService
} = require('../../miniprogram/application/plan-application-service');
const {
  createPlanRepository
} = require('../../miniprogram/domain/planning/plan-repository');
const {
  createSessionRepository
} = require('../../miniprogram/domain/execution/session-repository');
const {
  createLocalDatabase
} = require('../../miniprogram/services/local-database');
const {
  createWorkoutApplicationService
} = require('../../miniprogram/application/workout-application-service');
const { StorageDouble } = require('../helpers/storage-double');

const FIXED_NOW = 1785717300000;

function sourcePlan(index = 0) {
  return createDefaultPlans({ now: () => FIXED_NOW })[index];
}

test('plan editor keeps a detached draft and supports add, remove and reorder without mutating persisted input', () => {
  const persisted = sourcePlan();
  const original = structuredClone(persisted);
  const draft = createPlanDraft(persisted);

  draft.title = '调整后的训练';
  updateDraftStep(draft, persisted.steps[0].id, {
    name: '调整后的热身',
    durationSeconds: 420,
    targets: {
      speedKph: { min: 4.2, max: 4.8 },
      inclinePercent: { min: 1, max: 2 }
    },
    optional: true,
    alternatives: ['椭圆机热身']
  });
  addDraftStep(draft, {
    id: 'step_custom_strength',
    kind: 'strength',
    name: '自定义力量动作'
  });
  moveDraftStep(draft, 'step_custom_strength', 'up');
  removeDraftStep(draft, persisted.steps[1].id);

  assert.deepEqual(persisted, original);
  assert.equal(draft.title, '调整后的训练');
  assert.equal(draft.steps.at(-2).id, 'step_custom_strength');
  assert.equal(draft.steps.some(({ id }) => id === persisted.steps[1].id), false);
  assert.deepEqual(draft.steps.map(({ order }) => order), [10, 20, 30, 40, 50, 60, 70]);
  assert.deepEqual(draft.steps[0].targets.speedKph, { min: 4.2, max: 4.8 });
  assert.deepEqual(draft.steps[0].alternatives, ['椭圆机热身']);
});

test('plan editor returns field-level errors for required and kind-specific values', () => {
  const draft = createPlanDraft(sourcePlan());
  draft.title = '';
  updateDraftStep(draft, draft.steps[0].id, {
    durationSeconds: 0,
    targets: {
      speedKph: { min: 6, max: 4 },
      inclinePercent: { min: 0, max: 1 }
    }
  });
  updateDraftStep(draft, draft.steps[3].id, {
    sets: 0,
    reps: 0,
    restSeconds: -1
  });

  const result = validatePlanDraft(draft);

  assert.equal(result.valid, false);
  assert.match(result.fieldErrors['plan.title'], /必填/);
  assert.match(result.fieldErrors['plan.steps[0].durationSeconds'], /大于 0/);
  assert.match(result.fieldErrors['plan.steps[0].targets.speedKph'], /最小值/);
  assert.match(result.fieldErrors['plan.steps[3].sets'], /大于 0/);
  assert.match(result.fieldErrors['plan.steps[3].reps'], /大于 0/);
  assert.match(result.fieldErrors['plan.steps[3].restSeconds'], /不能小于 0/);
});

test('required editor text rejects whitespace-only titles and step names', () => {
  const draft = createPlanDraft(sourcePlan());
  draft.title = '   ';
  draft.steps[0].name = '\t';

  const result = validatePlanDraft(draft);

  assert.equal(result.valid, false);
  assert.match(result.fieldErrors['plan.title'], /必填/);
  assert.match(result.fieldErrors['plan.steps[0].name'], /必填/);
});

test('new step defaults expose only fields valid for its kind', () => {
  const expected = {
    timed: { durationSeconds: 600, sets: null, reps: null, restSeconds: null },
    strength: { durationSeconds: null, sets: 3, reps: 10, restSeconds: 60 },
    interval: { durationSeconds: 60, sets: 5, reps: null, restSeconds: 30 },
    manual: { durationSeconds: null, sets: 1, reps: 10, restSeconds: null },
    rest_day: { durationSeconds: null, sets: null, reps: null, restSeconds: null }
  };

  for (const [kind, fields] of Object.entries(expected)) {
    const draft = createPlanDraft(sourcePlan(6));
    removeDraftStep(draft, draft.steps[0].id);
    const step = addDraftStep(draft, {
      id: `step_new_${kind}`,
      kind,
      name: `${kind} step`
    });
    assert.deepEqual({
      durationSeconds: step.durationSeconds,
      sets: step.sets,
      reps: step.reps,
      restSeconds: step.restSeconds
    }, fields);
    assert.deepEqual(step.targets, {});
    assert.deepEqual(step.alternatives, []);
    assert.equal(step.optional, false);
  }
});

test('modeled duration uses the documented formula for every WorkoutStep kind', () => {
  assert.equal(estimateModeledSeconds([
    { kind: 'timed', durationSeconds: 120 },
    { kind: 'interval', sets: 3, durationSeconds: 40, restSeconds: 15 },
    { kind: 'strength', sets: 4, reps: 8, restSeconds: 60 },
    { kind: 'manual', sets: 2, reps: 12 },
    { kind: 'rest_day' }
  ]), 120 + (3 * 40) + (2 * 15) + (4 * 8 * 5) + (3 * 60) + (2 * 12 * 5));
});

function createRuntime({ idFactory = null } = {}) {
  const storage = new StorageDouble();
  const database = createLocalDatabase({ storage, now: () => FIXED_NOW });
  const repository = createPlanRepository({ database, now: () => FIXED_NOW + 60_000 });
  const application = createPlanApplicationService({
    repository,
    now: () => FIXED_NOW + 60_000,
    idFactory
  });
  application.initializeDefaultPlans();
  return { storage, database, repository, application };
}

test('editor session reserves historical step IDs and rejects removed or forged identities at add and save boundaries', () => {
  let removedId = null;
  const runtime = createRuntime({
    idFactory({ entity }) {
      if (entity === 'step' && removedId) return removedId;
      return `${entity}_editor_session_safe`;
    }
  });
  const editor = runtime.application.openPlanEditor({ planId: 'plan_20260803_builtin' });
  removedId = editor.draft.steps[0].id;
  const removed = structuredClone(editor.draft.steps[0]);
  runtime.application.removePlanDraftStep({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    stepId: removedId
  });

  assert.throws(
    () => runtime.application.addPlanDraftStep({
      editorSessionId: editor.editorSessionId,
      draft: editor.draft,
      kind: 'manual',
      name: '复用身份的不同动作'
    }),
    (error) => error && error.code === 'PLAN_STEP_ID_REUSED'
  );

  editor.draft.steps.push({
    ...removed,
    order: 80,
    kind: 'manual',
    name: '伪造身份动作',
    durationSeconds: null,
    sets: 1,
    reps: 10,
    restSeconds: null,
    targets: {}
  });
  const before = runtime.database.load();
  runtime.storage.clearOperations();
  const reused = runtime.application.savePlanDraft({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    expectedRevision: editor.expectedRevision
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.code, 'PLAN_STEP_ID_REUSED');
  assert.match(reused.fieldErrors['plan.steps'], /身份|重新加载/);
  assert.deepEqual(runtime.database.load(), before);
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);

  editor.draft.steps.pop();
  editor.draft.steps.push({ ...removed, id: 'step_forged_not_generated', order: 80 });
  const forged = runtime.application.savePlanDraft({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    expectedRevision: editor.expectedRevision
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'PLAN_STEP_ID_FORGED');
});

test('application-generated step IDs remain fresh after a draft step is deleted', () => {
  const runtime = createRuntime();
  const editor = runtime.application.openPlanEditor({ planId: 'plan_20260803_builtin' });

  const first = runtime.application.addPlanDraftStep({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    kind: 'manual',
    name: '临时动作'
  });
  removeDraftStep(editor.draft, first.id);
  const second = runtime.application.addPlanDraftStep({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    kind: 'manual',
    name: '新的动作'
  });

  assert.match(first.id, /^step_[A-Za-z0-9_-]+$/);
  assert.match(second.id, /^step_[A-Za-z0-9_-]+$/);
  assert.notEqual(second.id, first.id);
});

test('saving an editor draft updates the aggregate but leaves an active Session PlanSnapshot isolated', () => {
  const runtime = createRuntime();
  const sessionRepository = createSessionRepository({ database: runtime.database });
  const workout = createWorkoutApplicationService({
    planRepository: runtime.repository,
    sessionRepository,
    deviceId: 'device_plan_editor',
    idFactory: () => 'session_plan_editor',
    now: () => FIXED_NOW + 1_000
  });
  const started = workout.startSession({
    planId: 'plan_20260803_builtin',
    commandKey: 'start-before-edit'
  });
  const editor = runtime.application.openPlanEditor({ planId: started.planId });
  editor.draft.title = '适合今日器械的版本';
  updateDraftStep(editor.draft, editor.draft.steps[0].id, {
    name: '替代热身动作',
    durationSeconds: 420
  });

  const result = runtime.application.savePlanDraft({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    expectedRevision: editor.expectedRevision
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.revision, 2);
  assert.equal(runtime.repository.findById(started.planId).title, '适合今日器械的版本');
  assert.equal(runtime.database.load().activeSession.planSnapshot.title, started.planSnapshot.title);
  assert.equal(
    runtime.database.load().activeSession.planSnapshot.steps[0].name,
    started.planSnapshot.steps[0].name
  );
  assert.match(editor.futureStartNotice, /进行中的训练不变|下次开始/);
});

test('invalid and stale drafts return field errors with zero partial writes', () => {
  const runtime = createRuntime();
  const editor = runtime.application.openPlanEditor({ planId: 'plan_20260803_builtin' });
  const beforeInvalid = runtime.database.load();
  editor.draft.title = '';
  editor.draft.steps[0].durationSeconds = 0;
  runtime.storage.clearOperations();

  const invalid = runtime.application.savePlanDraft({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    expectedRevision: editor.expectedRevision
  });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'PLAN_VALIDATION_FAILED');
  assert.match(invalid.fieldErrors['plan.title'], /必填/);
  assert.deepEqual(runtime.database.load(), beforeInvalid);
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);

  const freshEditor = runtime.application.openPlanEditor({ planId: 'plan_20260803_builtin' });
  const winner = runtime.repository.save({
    ...runtime.repository.findById('plan_20260803_builtin'),
    title: '另一窗口先保存'
  }, freshEditor.expectedRevision);
  runtime.storage.clearOperations();
  freshEditor.draft.title = '过期窗口覆盖';

  const stale = runtime.application.savePlanDraft({
    editorSessionId: freshEditor.editorSessionId,
    draft: freshEditor.draft,
    expectedRevision: freshEditor.expectedRevision
  });

  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'PLAN_REVISION_CONFLICT');
  assert.match(stale.fieldErrors['plan.revision'], /重新加载/);
  assert.equal(runtime.repository.findById(winner.id).title, '另一窗口先保存');
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);
});

test('an empty date gets a valid custom draft and persists with expected revision zero', () => {
  const runtime = createRuntime();
  const editor = runtime.application.openPlanEditor({ trainingDate: '2026-08-10' });

  assert.equal(editor.isNew, true);
  assert.equal(editor.expectedRevision, 0);
  assert.equal(editor.draft.trainingDate, '2026-08-10');
  assert.equal(editor.draft.steps.length, 1);
  editor.draft.title = '周一自定义训练';
  const saved = runtime.application.savePlanDraft({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    expectedRevision: editor.expectedRevision
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.plan.revision, 1);
  assert.equal(runtime.repository.findByDate('2026-08-10').id, editor.draft.id);
});

test('saving recalculates estimated duration from kind-specific modeled seconds without discarding the persisted baseline', () => {
  const runtime = createRuntime();
  const existing = runtime.application.openPlanEditor({ planId: 'plan_20260803_builtin' });
  existing.draft.steps[0].durationSeconds += 600;
  existing.draft.estimatedDurationSeconds = -1;

  const updated = runtime.application.savePlanDraft({
    editorSessionId: existing.editorSessionId,
    draft: existing.draft,
    expectedRevision: existing.expectedRevision
  });

  assert.equal(updated.ok, true);
  assert.equal(updated.plan.estimatedDurationSeconds, 2880);

  const created = runtime.application.openPlanEditor({ trainingDate: '2026-08-10' });
  created.draft.steps[0].durationSeconds = 420;
  created.draft.estimatedDurationSeconds = -9999;
  const savedNew = runtime.application.savePlanDraft({
    editorSessionId: created.editorSessionId,
    draft: created.draft,
    expectedRevision: created.expectedRevision
  });

  assert.equal(savedNew.ok, true);
  assert.equal(savedNew.plan.estimatedDurationSeconds, 420);
});

test('replacing an existing workout with only rest_day steps forces estimated duration to zero', () => {
  const runtime = createRuntime();
  const editor = runtime.application.openPlanEditor({ planId: 'plan_20260803_builtin' });

  for (const step of [...editor.draft.steps]) {
    runtime.application.removePlanDraftStep({
      editorSessionId: editor.editorSessionId,
      draft: editor.draft,
      stepId: step.id
    });
  }
  runtime.application.addPlanDraftStep({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    kind: 'rest_day',
    name: '休息与日常活动'
  });

  const saved = runtime.application.savePlanDraft({
    editorSessionId: editor.editorSessionId,
    draft: editor.draft,
    expectedRevision: editor.expectedRevision
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.plan.estimatedDurationSeconds, 0);
});

test('copy uses the detached editor draft including unsaved nested edits and recalculated duration', () => {
  const runtime = createRuntime();
  const editor = runtime.application.openPlanEditor({ planId: 'plan_20260803_builtin' });
  editor.draft.title = '尚未保存的复制来源';
  editor.draft.steps[0].durationSeconds += 120;
  editor.draft.steps[0].targets.speedKph.min = 3.7;
  editor.draft.estimatedDurationSeconds = 7;

  const copied = runtime.application.copyPlanToDate({
    editorSessionId: editor.editorSessionId,
    sourcePlanDraft: editor.draft,
    sourcePlanId: editor.draft.id,
    targetDate: '2026-08-10',
    commandKey: 'copy-unsaved-draft',
    copyIntentId: 'copy_intent_unsaved_draft'
  });

  assert.equal(copied.ok, true);
  assert.equal(copied.plan.title, '尚未保存的复制来源');
  assert.equal(copied.plan.steps[0].durationSeconds, 420);
  assert.equal(copied.plan.steps[0].targets.speedKph.min, 3.7);
  assert.equal(copied.plan.estimatedDurationSeconds, 2400);
  assert.equal(runtime.repository.findById(editor.draft.id).title, '熟悉器械与基础力量');
});

test('copy-to-empty-date is a deep copy and repeated confirmation is idempotent', () => {
  const runtime = createRuntime();
  const source = runtime.repository.findByDate('2026-08-03');

  const first = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: '2026-08-10',
    commandKey: 'copy-2026-08-03-to-10'
  });
  const repeated = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: '2026-08-10',
    commandKey: 'copy-2026-08-03-to-10'
  });

  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.plan.id, first.plan.id);
  assert.notEqual(first.plan.id, source.id);
  assert.ok(first.plan.steps.every((step, index) => step.id !== source.steps[index].id));
  assert.equal(runtime.repository.findRange('2026-08-10', '2026-08-10').length, 1);
  first.plan.steps[0].targets.speedKph.min = 99;
  assert.notEqual(runtime.repository.findByDate('2026-08-03').steps[0].targets.speedKph.min, 99);
});

test('copy-to-existing-date requires confirmation and its exact expected revision before one atomic replacement', () => {
  const runtime = createRuntime();
  const source = runtime.repository.findByDate('2026-08-03');
  const target = runtime.repository.findByDate('2026-08-04');
  const before = runtime.database.load();
  runtime.storage.clearOperations();

  const unconfirmed = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'replace-2026-08-04'
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.code, 'PLAN_REPLACE_CONFIRMATION_REQUIRED');
  assert.equal(unconfirmed.targetPlanId, target.id);
  assert.equal(unconfirmed.targetRevision, target.revision);
  assert.equal(typeof unconfirmed.copyIntentId, 'string');
  assert.ok(unconfirmed.copyIntentId.length > 0);
  assert.deepEqual(runtime.database.load(), before);
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);

  const stale = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'replace-2026-08-04',
    confirmReplace: true,
    copyIntentId: unconfirmed.copyIntentId,
    expectedTargetPlanId: unconfirmed.targetPlanId,
    expectedTargetRevision: 0
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'PLAN_REVISION_CONFLICT');
  assert.match(stale.fieldErrors['plan.revision'], /重新加载/);
  assert.equal(runtime.repository.findByDate(target.trainingDate).id, target.id);

  runtime.storage.clearOperations();
  const replaced = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'replace-2026-08-04',
    confirmReplace: true,
    copyIntentId: unconfirmed.copyIntentId,
    expectedTargetPlanId: unconfirmed.targetPlanId,
    expectedTargetRevision: target.revision
  });
  const replayed = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'replace-2026-08-04-double-tap',
    confirmReplace: true,
    copyIntentId: unconfirmed.copyIntentId,
    expectedTargetPlanId: unconfirmed.targetPlanId,
    expectedTargetRevision: unconfirmed.targetRevision
  });

  assert.equal(replaced.ok, true);
  assert.equal(replaced.replaced, true);
  assert.notEqual(replaced.plan.id, target.id);
  assert.equal(runtime.repository.findById(target.id), null);
  assert.equal(runtime.database.load().plans.find(({ id }) => id === target.id).status, 'deleted');
  assert.equal(runtime.database.load().localRevision, before.localRevision + 1);
  assert.equal(runtime.storage.operations.filter(({ type }) => type === 'write').length, 2);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.plan.id, replaced.plan.id);
  assert.equal(runtime.repository.findRange(target.trainingDate, target.trainingDate).length, 1);
});

test('stale replacement confirmation rejects a different target plan with the same revision and performs zero writes', () => {
  const runtime = createRuntime();
  const source = runtime.repository.findByDate('2026-08-03');
  const targetA = runtime.repository.findByDate('2026-08-04');
  const preflight = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: targetA.trainingDate,
    commandKey: 'preflight-target-a'
  });

  runtime.repository.delete(targetA.id, targetA.revision);
  const targetB = runtime.repository.save({
    ...sourcePlan(2),
    id: 'plan_concurrent_target_b',
    trainingDate: targetA.trainingDate,
    title: '并发创建的目标 B',
    templateSource: null
  }, 0);
  const before = runtime.database.load();
  runtime.storage.clearOperations();

  const stale = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: targetA.trainingDate,
    commandKey: 'confirm-stale-target-a',
    confirmReplace: true,
    copyIntentId: preflight.copyIntentId,
    expectedTargetPlanId: preflight.targetPlanId,
    expectedTargetRevision: preflight.targetRevision
  });

  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'PLAN_REVISION_CONFLICT');
  assert.match(stale.fieldErrors['plan.revision'], /重新加载/);
  assert.deepEqual(runtime.repository.findByDate(targetA.trainingDate), targetB);
  assert.deepEqual(runtime.database.load(), before);
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);
});

test('stale replacement confirmation cannot downgrade to empty-date creation after its target is deleted', () => {
  const runtime = createRuntime();
  const source = runtime.repository.findByDate('2026-08-03');
  const target = runtime.repository.findByDate('2026-08-04');
  const preflight = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'preflight-before-delete'
  });

  runtime.repository.delete(target.id, target.revision);
  const before = runtime.database.load();
  runtime.storage.clearOperations();

  const stale = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'confirm-after-delete',
    confirmReplace: true,
    copyIntentId: preflight.copyIntentId,
    expectedTargetPlanId: preflight.targetPlanId,
    expectedTargetRevision: preflight.targetRevision
  });

  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'PLAN_REVISION_CONFLICT');
  assert.equal(runtime.repository.findByDate(target.trainingDate), null);
  assert.deepEqual(runtime.database.load(), before);
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);
});

test('replacement confirmation rejects an incomplete target identity payload without writing', () => {
  const runtime = createRuntime();
  const source = runtime.repository.findByDate('2026-08-03');
  const target = runtime.repository.findByDate('2026-08-04');
  const preflight = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'preflight-incomplete-payload'
  });
  const before = runtime.database.load();
  runtime.storage.clearOperations();

  const invalid = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'confirm-incomplete-payload',
    confirmReplace: true,
    copyIntentId: preflight.copyIntentId,
    expectedTargetPlanId: preflight.targetPlanId
  });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'PLAN_REPLACE_CONFIRMATION_INVALID');
  assert.match(invalid.fieldErrors['plan.revision'], /重新加载/);
  assert.deepEqual(runtime.database.load(), before);
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);
});

test('a fresh copy intent can reuse a source revision after an intervening replacement while replaying itself once', () => {
  const runtime = createRuntime();
  const sourceA = runtime.repository.findByDate('2026-08-03');
  const sourceB = runtime.repository.findByDate('2026-08-05');
  const targetDate = '2026-08-04';

  function replaceFrom(source, commandKey) {
    const preflight = runtime.application.copyPlanToDate({
      sourcePlanId: source.id,
      targetDate,
      commandKey: `${commandKey}-preflight`
    });
    assert.equal(preflight.code, 'PLAN_REPLACE_CONFIRMATION_REQUIRED');
    return {
      preflight,
      result: runtime.application.copyPlanToDate({
        sourcePlanId: source.id,
        targetDate,
        commandKey: `${commandKey}-confirm`,
        confirmReplace: true,
        copyIntentId: preflight.copyIntentId,
        expectedTargetPlanId: preflight.targetPlanId,
        expectedTargetRevision: preflight.targetRevision
      })
    };
  }

  const firstA = replaceFrom(sourceA, 'first-a');
  const thenB = replaceFrom(sourceB, 'then-b');
  const beforeThird = runtime.database.load().localRevision;
  const secondA = replaceFrom(sourceA, 'second-a');
  const replay = runtime.application.copyPlanToDate({
    sourcePlanId: sourceA.id,
    targetDate,
    commandKey: 'second-a-double-tap',
    confirmReplace: true,
    copyIntentId: secondA.preflight.copyIntentId,
    expectedTargetPlanId: secondA.preflight.targetPlanId,
    expectedTargetRevision: secondA.preflight.targetRevision
  });

  assert.equal(firstA.result.ok, true);
  assert.equal(thenB.result.ok, true);
  assert.equal(secondA.result.ok, true);
  assert.notEqual(secondA.preflight.copyIntentId, firstA.preflight.copyIntentId);
  assert.notEqual(secondA.result.plan.id, firstA.result.plan.id);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.plan.id, secondA.result.plan.id);
  assert.equal(runtime.database.load().localRevision, beforeThird + 1);
  assert.equal(runtime.repository.findByDate(targetDate).id, secondA.result.plan.id);
});

test('different dialog tap keys replay one explicit copy intent', () => {
  const runtime = createRuntime();
  const source = runtime.repository.findByDate('2026-08-03');
  const target = runtime.repository.findByDate('2026-08-04');
  const beforeRevision = runtime.database.load().localRevision;

  const preflight = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'dialog-open'
  });
  const first = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'dialog-tap-1',
    confirmReplace: true,
    copyIntentId: preflight.copyIntentId,
    expectedTargetPlanId: preflight.targetPlanId,
    expectedTargetRevision: preflight.targetRevision
  });
  const second = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: target.trainingDate,
    commandKey: 'dialog-tap-2',
    confirmReplace: true,
    copyIntentId: preflight.copyIntentId,
    expectedTargetPlanId: preflight.targetPlanId,
    expectedTargetRevision: preflight.targetRevision
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.plan.id, first.plan.id);
  assert.equal(runtime.database.load().localRevision, beforeRevision + 1);
  assert.equal(runtime.repository.findRange(target.trainingDate, target.trainingDate).length, 1);
});

test('a newer source revision creates a new copy intent and can explicitly refresh the same target date', () => {
  const runtime = createRuntime();
  const sourceV1 = runtime.repository.findByDate('2026-08-03');
  const target = runtime.repository.findByDate('2026-08-04');
  const sourceV1Preflight = runtime.application.copyPlanToDate({
    sourcePlanId: sourceV1.id,
    targetDate: target.trainingDate,
    commandKey: 'source-v1-copy-preflight'
  });
  const first = runtime.application.copyPlanToDate({
    sourcePlanId: sourceV1.id,
    targetDate: target.trainingDate,
    commandKey: 'source-v1-copy',
    confirmReplace: true,
    copyIntentId: sourceV1Preflight.copyIntentId,
    expectedTargetPlanId: sourceV1Preflight.targetPlanId,
    expectedTargetRevision: sourceV1Preflight.targetRevision
  });
  const sourceV2 = runtime.repository.save({
    ...runtime.repository.findById(sourceV1.id),
    title: '来源计划 revision 2'
  }, sourceV1.revision);

  const needsRefreshConfirmation = runtime.application.copyPlanToDate({
    sourcePlanId: sourceV2.id,
    targetDate: target.trainingDate,
    commandKey: 'source-v2-copy'
  });
  assert.equal(needsRefreshConfirmation.code, 'PLAN_REPLACE_CONFIRMATION_REQUIRED');

  const refreshed = runtime.application.copyPlanToDate({
    sourcePlanId: sourceV2.id,
    targetDate: target.trainingDate,
    commandKey: 'source-v2-copy-confirm',
    confirmReplace: true,
    copyIntentId: needsRefreshConfirmation.copyIntentId,
    expectedTargetPlanId: needsRefreshConfirmation.targetPlanId,
    expectedTargetRevision: needsRefreshConfirmation.targetRevision
  });
  assert.equal(refreshed.ok, true);
  assert.notEqual(refreshed.plan.id, first.plan.id);
  assert.equal(refreshed.plan.title, '来源计划 revision 2');
  assert.equal(runtime.repository.findByDate(target.trainingDate).id, refreshed.plan.id);
});

test('copying a plan onto its own training date fails closed and preserves the active source', () => {
  const runtime = createRuntime();
  const source = runtime.repository.findByDate('2026-08-03');
  const before = runtime.database.load();
  runtime.storage.clearOperations();

  const result = runtime.application.copyPlanToDate({
    sourcePlanId: source.id,
    targetDate: source.trainingDate,
    commandKey: 'copy-onto-self',
    confirmReplace: true,
    expectedTargetRevision: source.revision
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PLAN_COPY_SAME_DATE');
  assert.match(result.fieldErrors['plan.trainingDate'], /其他日期/);
  assert.deepEqual(runtime.repository.findById(source.id), source);
  assert.deepEqual(runtime.database.load(), before);
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);
});

test('closing editor sessions prevents stale tokens from writing and keeps the session registry bounded', () => {
  const runtime = createRuntime();
  const first = runtime.application.openPlanEditor({ planId: 'plan_20260803_builtin' });
  const second = runtime.application.openPlanEditor({ planId: 'plan_20260804_builtin' });
  assert.equal(runtime.application.editorSessions.size, 2);

  assert.equal(runtime.application.closePlanEditor(first.editorSessionId), true);
  assert.equal(runtime.application.editorSessions.size, 1);
  first.draft.title = '关闭后不应保存';
  const before = runtime.database.load();
  runtime.storage.clearOperations();
  const closedSave = runtime.application.savePlanDraft({
    editorSessionId: first.editorSessionId,
    draft: first.draft,
    expectedRevision: first.expectedRevision
  });
  assert.equal(closedSave.ok, false);
  assert.equal(closedSave.code, 'PLAN_EDITOR_SESSION_INVALID');
  assert.deepEqual(runtime.database.load(), before);
  assert.deepEqual(runtime.storage.operations.filter(({ type }) => type === 'write'), []);

  assert.equal(runtime.application.closePlanEditor(second.editorSessionId), true);
  assert.equal(runtime.application.closePlanEditor(second.editorSessionId), false);
  assert.equal(runtime.application.editorSessions.size, 0);
});
