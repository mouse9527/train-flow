const assert = require('node:assert/strict');
const test = require('node:test');

const {
  StatisticsService
} = require('../../miniprogram/services/statistics-service');

function plan({ id, trainingDate, steps, status = 'scheduled' }) {
  return { id, trainingDate, status, steps };
}

function record({
  id,
  trainingDate,
  endedAt,
  elapsedActiveSeconds,
  status = 'completed',
  steps,
  results,
  feedback = null,
  revision = 1
}) {
  return {
    id,
    revision,
    status,
    trainingDate,
    endedAt,
    elapsedActiveSeconds,
    planSnapshot: { steps },
    stepResults: results,
    feedback
  };
}

const RANGE = { startDate: '2026-08-03', endDate: '2026-08-09' };

function fixtures() {
  const treadmill = { id: 'step_treadmill', kind: 'timed', name: '跑步机快走', durationSeconds: 720 };
  const chest = { id: 'step_chest', kind: 'strength', name: '综合训练器推胸' };
  const rowing = { id: 'step_rowing', kind: 'interval', name: '划船机间歇', durationSeconds: 60, sets: 8 };
  const back = { id: 'step_back', kind: 'strength', name: '高位下拉或坐姿拉背' };
  const rest = { id: 'step_rest', kind: 'rest_day', name: '完全休息' };

  const plans = [
    plan({ id: 'plan_mon', trainingDate: '2026-08-03', steps: [treadmill, chest] }),
    plan({ id: 'plan_tue', trainingDate: '2026-08-04', steps: [rest] }),
    plan({ id: 'plan_wed', trainingDate: '2026-08-05', steps: [rowing, back] })
  ];
  const monday = record({
    id: 'record_mon',
    trainingDate: '2026-08-03',
    endedAt: 1785719400000,
    elapsedActiveSeconds: 1800,
    steps: [treadmill, chest],
    results: [
      { stepId: treadmill.id, status: 'completed', actualDurationSeconds: 600, setResults: [] },
      {
        stepId: chest.id,
        status: 'completed',
        setResults: [
          { setNumber: 1, reps: 12, weightKg: 10 },
          { setNumber: 2, reps: 12, weightKg: 12 }
        ]
      }
    ],
    feedback: {
      rpe: 7,
      weightBeforeKg: 80.5,
      pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
      note: ''
    }
  });
  const wednesday = record({
    id: 'record_wed',
    trainingDate: '2026-08-05',
    endedAt: 1785892200000,
    elapsedActiveSeconds: 1200,
    steps: [rowing, back],
    results: [
      { stepId: rowing.id, status: 'completed', actualDurationSeconds: 420, setResults: [] },
      {
        stepId: back.id,
        status: 'completed',
        setResults: [{ setNumber: 1, reps: 10, weightKg: 15 }]
      }
    ],
    feedback: null
  });
  return { plans, monday, wednesday };
}

test('rebuild computes trustworthy weekly totals and recent trends from normalized trainingDate facts', () => {
  const { plans, monday, wednesday } = fixtures();
  const service = new StatisticsService({ now: () => 1786032000000 });

  const projection = service.rebuild([monday, wednesday], plans, RANGE);

  assert.deepEqual(projection.range, RANGE);
  assert.deepEqual(projection.summary, {
    completedCount: 2,
    plannedCount: 2,
    completionRate: 1,
    totalActiveSeconds: 3000,
    treadmillSeconds: 600,
    treadmillEstimated: false,
    rowingSeconds: 420,
    rowingEstimated: false,
    strengthCount: 2,
    streakDays: 1
  });
  assert.deepEqual(projection.latestStrength, {
    chest: { valueKg: 12, trainingDate: '2026-08-03' },
    back: { valueKg: 15, trainingDate: '2026-08-05' }
  });
  assert.deepEqual(projection.latestBodyWeight, {
    valueKg: 80.5,
    trainingDate: '2026-08-03'
  });
  assert.deepEqual(projection.recent.duration, [
    { trainingDate: '2026-08-03', value: 1800 },
    { trainingDate: '2026-08-05', value: 1200 }
  ]);
  assert.deepEqual(projection.recent.rpe, [
    { trainingDate: '2026-08-03', value: 7 },
    { trainingDate: '2026-08-05', value: null }
  ]);
  assert.deepEqual(projection.recent.weight, [
    { trainingDate: '2026-08-03', value: 80.5 },
    { trainingDate: '2026-08-05', value: null }
  ]);
  assert.equal(projection.builtAt, 1786032000000);
});

test('rebuild excludes rest days and preserves unknown completion, weight and RPE as null', () => {
  const service = new StatisticsService({ now: () => 1786032000000 });
  const restPlan = plan({
    id: 'plan_rest',
    trainingDate: '2026-08-09',
    steps: [{ id: 'rest', kind: 'rest_day', name: '完全休息' }]
  });

  const projection = service.rebuild([], [restPlan], RANGE);

  assert.equal(projection.summary.plannedCount, 0);
  assert.equal(projection.summary.completionRate, null);
  assert.deepEqual(projection.latestStrength, { chest: null, back: null });
  assert.equal(projection.latestBodyWeight, null);
  assert.deepEqual(projection.recent, { duration: [], rpe: [], weight: [] });
});

test('completed target fallback is marked as estimated and streak de-duplicates same-day records', () => {
  const treadmill = {
    id: 'step_treadmill_estimated',
    kind: 'timed',
    name: '跑步机热身',
    durationSeconds: 300
  };
  const rowing = {
    id: 'step_rowing_estimated',
    kind: 'interval',
    name: '划船机练习',
    durationSeconds: 60,
    sets: 3
  };
  const plans = [
    plan({ id: 'plan_mon', trainingDate: '2026-08-03', steps: [treadmill] }),
    plan({ id: 'plan_tue', trainingDate: '2026-08-04', steps: [rowing] })
  ];
  const records = [
    record({
      id: 'record_mon_a',
      trainingDate: '2026-08-03',
      endedAt: 100,
      elapsedActiveSeconds: 300,
      steps: [treadmill],
      results: [{ stepId: treadmill.id, status: 'completed', setResults: [] }]
    }),
    record({
      id: 'record_mon_b',
      trainingDate: '2026-08-03',
      endedAt: 200,
      elapsedActiveSeconds: 120,
      steps: [treadmill],
      results: [{ stepId: treadmill.id, status: 'completed', setResults: [] }]
    }),
    record({
      id: 'record_tue',
      trainingDate: '2026-08-04',
      endedAt: 300,
      elapsedActiveSeconds: 180,
      steps: [rowing],
      results: [{
        stepId: rowing.id,
        status: 'completed',
        setResults: [{ setNumber: 1 }, { setNumber: 2 }]
      }]
    })
  ];

  const projection = new StatisticsService({ now: () => 400 }).rebuild(records, plans, RANGE);

  assert.equal(projection.summary.treadmillSeconds, 600);
  assert.equal(projection.summary.treadmillEstimated, true);
  assert.equal(projection.summary.rowingSeconds, 120);
  assert.equal(projection.summary.rowingEstimated, true);
  assert.equal(projection.summary.streakDays, 2);
});

test('record create, edit and delete incremental updates remain identical to authoritative rebuilds', () => {
  const { plans, monday, wednesday } = fixtures();
  const service = new StatisticsService({ now: () => 1786032000000 });
  const empty = service.rebuild([], plans, RANGE);

  const afterCreate = service.applyRecordChanged(empty, null, monday);
  assert.deepEqual(
    service.publicProjection(afterCreate),
    service.publicProjection(service.rebuild([monday], plans, RANGE))
  );

  const initial = service.rebuild([monday, wednesday], plans, RANGE);
  const editedMonday = structuredClone(monday);
  editedMonday.revision = 2;
  editedMonday.elapsedActiveSeconds = 2100;
  editedMonday.stepResults[0].actualDurationSeconds = 900;
  editedMonday.stepResults[1].setResults[1].weightKg = 14;
  editedMonday.feedback.rpe = 8;
  const afterEdit = service.applyRecordChanged(initial, monday, editedMonday);
  assert.deepEqual(
    service.publicProjection(afterEdit),
    service.publicProjection(service.rebuild([editedMonday, wednesday], plans, RANGE))
  );

  const afterDelete = service.applyRecordChanged(afterEdit, editedMonday, null);
  assert.deepEqual(
    service.publicProjection(afterDelete),
    service.publicProjection(service.rebuild([wednesday], plans, RANGE))
  );
});

test('date boundaries reject impossible or inverted ranges instead of reinterpreting UTC timestamps', () => {
  const service = new StatisticsService();

  assert.throws(
    () => service.rebuild([], [], { startDate: '2026-02-30', endDate: '2026-03-07' }),
    /real calendar date/
  );
  assert.throws(
    () => service.rebuild([], [], { startDate: '2026-08-10', endDate: '2026-08-09' }),
    /must not be after/
  );
});
