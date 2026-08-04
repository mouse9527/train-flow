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
    { recordId: 'record_mon', trainingDate: '2026-08-03', value: 1800 },
    { recordId: 'record_wed', trainingDate: '2026-08-05', value: 1200 }
  ]);
  assert.deepEqual(projection.recent.rpe, [
    { recordId: 'record_mon', trainingDate: '2026-08-03', value: 7 },
    { recordId: 'record_wed', trainingDate: '2026-08-05', value: null }
  ]);
  assert.deepEqual(projection.recent.weight, [
    { recordId: 'record_mon', trainingDate: '2026-08-03', value: 80.5 },
    { recordId: 'record_wed', trainingDate: '2026-08-05', value: null }
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
  assert.equal(projection.summary.completedCount, 2);
  assert.equal(projection.summary.completionRate, 1);
  assert.equal(projection.summary.streakDays, 2);
});

test('weekly totals include both legal boundaries, exclude adjacent weeks and reset streak at a date gap', () => {
  const activeStep = { id: 'step_week_boundary', kind: 'manual', name: '边界训练' };
  const dates = ['2026-08-02', '2026-08-03', '2026-08-05', '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10'];
  const plans = dates.map((trainingDate) => plan({
    id: `plan_${trainingDate}`,
    trainingDate,
    steps: [activeStep]
  }));
  const records = dates.map((trainingDate, index) => record({
    id: `record_${trainingDate}`,
    trainingDate,
    endedAt: index + 1,
    elapsedActiveSeconds: 60,
    steps: [activeStep],
    results: [{ stepId: activeStep.id, status: 'completed', setResults: [] }]
  }));

  const projection = new StatisticsService({ now: () => 1_000 }).rebuild(records, plans, RANGE);

  assert.equal(projection.summary.plannedCount, 5);
  assert.equal(projection.summary.completedCount, 5);
  assert.equal(projection.summary.totalActiveSeconds, 300);
  assert.equal(projection.summary.streakDays, 3);
  assert.deepEqual(
    projection.recent.duration.map(({ trainingDate }) => trainingDate),
    ['2026-08-02', '2026-08-03', '2026-08-05', '2026-08-07', '2026-08-08', '2026-08-09']
  );
});

test('planning and classification use scheduled facts and structured targets before controlled name fallback', () => {
  const structuredTreadmill = {
    id: 'step_structured_treadmill',
    kind: 'timed',
    name: '匿名有氧 A',
    durationSeconds: 240,
    targets: { speedKph: { min: 4, max: 5 }, inclinePercent: { min: 0, max: 1 } }
  };
  const structuredRowing = {
    id: 'step_structured_rowing',
    kind: 'interval',
    name: '匿名有氧 B',
    durationSeconds: 30,
    sets: 4,
    targets: { cadenceSpm: { min: 18, max: 22 }, resistance: null }
  };
  const structuredBike = {
    id: 'step_structured_bike',
    kind: 'timed',
    name: '动感单车',
    durationSeconds: 90,
    targets: { resistance: { min: 3, max: 5 } }
  };
  const plans = [
    plan({ id: 'scheduled', trainingDate: '2026-08-03', steps: [structuredTreadmill] }),
    plan({ id: 'draft', trainingDate: '2026-08-04', steps: [structuredRowing], status: 'draft' }),
    plan({ id: 'cancelled', trainingDate: '2026-08-05', steps: [structuredRowing], status: 'cancelled' })
  ];
  const facts = record({
    id: 'record_structured_machine',
    trainingDate: '2026-08-03',
    endedAt: 500,
    elapsedActiveSeconds: 360,
    steps: [structuredTreadmill, structuredRowing, structuredBike],
    results: [
      { stepId: structuredTreadmill.id, status: 'completed', actualDurationSeconds: 240, setResults: [] },
      { stepId: structuredRowing.id, status: 'completed', actualDurationSeconds: 120, setResults: [] },
      { stepId: structuredBike.id, status: 'completed', actualDurationSeconds: 90, setResults: [] }
    ]
  });

  const projection = new StatisticsService({ now: () => 600 }).rebuild([facts], plans, RANGE);

  assert.equal(projection.summary.plannedCount, 1);
  assert.equal(projection.summary.treadmillSeconds, 240);
  assert.equal(projection.summary.rowingSeconds, 120);
});

test('aborted work contributes real completed activity but not completion rate or streak', () => {
  const treadmill = {
    id: 'step_aborted_treadmill',
    kind: 'timed',
    name: '跑步机快走',
    durationSeconds: 300
  };
  const strength = {
    id: 'step_aborted_strength',
    kind: 'strength',
    name: '综合训练器推胸'
  };
  const aborted = record({
    id: 'record_aborted_work',
    status: 'aborted',
    trainingDate: '2026-08-03',
    endedAt: 700,
    elapsedActiveSeconds: 420,
    steps: [treadmill, strength],
    results: [
      { stepId: treadmill.id, status: 'completed', actualDurationSeconds: 300, setResults: [] },
      { stepId: strength.id, status: 'completed', setResults: [{ setNumber: 1, weightKg: 8 }] }
    ]
  });

  const projection = new StatisticsService({ now: () => 800 }).rebuild(
    [aborted],
    [plan({ id: 'plan_aborted', trainingDate: '2026-08-03', steps: [treadmill, strength] })],
    RANGE
  );

  assert.equal(projection.summary.completedCount, 0);
  assert.equal(projection.summary.completionRate, 0);
  assert.equal(projection.summary.streakDays, 0);
  assert.equal(projection.summary.totalActiveSeconds, 420);
  assert.equal(projection.summary.treadmillSeconds, 300);
  assert.equal(projection.summary.strengthCount, 1);
});

test('last known strength and body weights survive seven newer records with explicit unknown values', () => {
  const chest = { id: 'step_old_chest', kind: 'strength', name: '综合训练器推胸' };
  const oldKnown = record({
    id: 'record_old_known',
    trainingDate: '2026-07-20',
    endedAt: 100,
    elapsedActiveSeconds: 600,
    steps: [chest],
    results: [{
      stepId: chest.id,
      status: 'completed',
      setResults: [{ setNumber: 1, reps: 10, weightKg: 9 }]
    }],
    feedback: {
      rpe: 5,
      weightBeforeKg: 81,
      pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
      note: ''
    }
  });
  const newerUnknown = Array.from({ length: 7 }, (_, index) => record({
    id: `record_unknown_${index}`,
    trainingDate: `2026-08-0${index + 1}`,
    endedAt: 200 + index,
    elapsedActiveSeconds: 300,
    steps: [],
    results: [],
    feedback: null
  }));

  const projection = new StatisticsService({ now: () => 900 }).rebuild(
    [oldKnown, ...newerUnknown],
    [],
    RANGE
  );

  assert.deepEqual(projection.latestStrength.chest, {
    valueKg: 9,
    trainingDate: '2026-07-20'
  });
  assert.deepEqual(projection.latestBodyWeight, {
    valueKg: 81,
    trainingDate: '2026-07-20'
  });
  assert.equal(projection.recent.duration.length, 7);
  assert.equal(projection.recent.weight.every(({ value }) => value === null), true);
});

test('latest known facts win by normalized date from unordered input and every trend keeps exactly seven nullable points', () => {
  const chest = { id: 'step_latest_chest', kind: 'strength', name: '综合训练器推胸' };
  const back = { id: 'step_latest_back', kind: 'strength', name: '高位下拉' };
  const knownByDate = {
    '2026-08-02': { chest: 8, back: 11, weight: 82, rpe: 5 },
    '2026-08-06': { chest: 12, back: 15, weight: 80.5, rpe: 7 },
    '2026-08-08': { chest: 14, back: 17, weight: 79.8, rpe: 8 }
  };
  const records = Array.from({ length: 9 }, (_, index) => {
    const trainingDate = `2026-08-0${index + 1}`;
    const known = knownByDate[trainingDate] || {};
    return record({
      id: `record_latest_${index}`,
      trainingDate,
      endedAt: 100 + index,
      elapsedActiveSeconds: 300 + index,
      steps: [chest, back],
      results: [
        {
          stepId: chest.id,
          status: 'completed',
          setResults: known.chest === undefined ? [] : [{ setNumber: 1, weightKg: known.chest }]
        },
        {
          stepId: back.id,
          status: 'completed',
          setResults: known.back === undefined ? [] : [{ setNumber: 1, weightKg: known.back }]
        }
      ],
      feedback: known.rpe === undefined && known.weight === undefined
        ? null
        : {
          rpe: known.rpe,
          weightBeforeKg: known.weight,
          pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
          note: ''
        }
    });
  }).reverse();

  const projection = new StatisticsService({ now: () => 1_100 }).rebuild(records, [], RANGE);

  assert.deepEqual(projection.latestStrength, {
    chest: { valueKg: 14, trainingDate: '2026-08-08' },
    back: { valueKg: 17, trainingDate: '2026-08-08' }
  });
  assert.deepEqual(projection.latestBodyWeight, {
    valueKg: 79.8,
    trainingDate: '2026-08-08'
  });
  for (const series of ['duration', 'rpe', 'weight']) {
    assert.equal(projection.recent[series].length, 7);
    assert.deepEqual(
      projection.recent[series].map(({ trainingDate }) => trainingDate),
      ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09']
    );
  }
  assert.deepEqual(
    projection.recent.rpe.map(({ value }) => value),
    [null, null, null, 7, null, 8, null]
  );
  assert.deepEqual(
    projection.recent.weight.map(({ value }) => value),
    [null, null, null, 80.5, null, 79.8, null]
  );
});

test('an unplanned completed workout keeps completion unknown while retaining actual activity', () => {
  const unplanned = record({
    id: 'record_unplanned',
    trainingDate: '2026-08-04',
    endedAt: 1_200,
    elapsedActiveSeconds: 900,
    steps: [],
    results: []
  });

  const projection = new StatisticsService({ now: () => 1_300 }).rebuild([unplanned], [], RANGE);

  assert.equal(projection.summary.plannedCount, 0);
  assert.equal(projection.summary.completedCount, 0);
  assert.equal(projection.summary.completionRate, null);
  assert.equal(projection.summary.totalActiveSeconds, 900);
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
