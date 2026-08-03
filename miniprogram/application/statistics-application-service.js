const { getWeekRange } = require('./today-plan-view');
const { createStatisticsService } = require('../services/statistics-service');

function formatDate(trainingDate) {
  return `${trainingDate.slice(5, 7)}月${trainingDate.slice(8, 10)}日`;
}

function formatShortDate(trainingDate) {
  return trainingDate.slice(5).replace('-', '/');
}

function metric(valueLabel, unit, note = '') {
  return { valueLabel, unit, note };
}

function weightView(value) {
  return value
    ? { valueLabel: `${value.valueKg} kg`, dateLabel: formatDate(value.trainingDate) }
    : { valueLabel: '未记录', dateLabel: '' };
}

function trendPoints(points, formatter) {
  const knownValues = points
    .filter(({ value }) => value !== null)
    .map(({ value }) => value);
  const max = knownValues.length === 0 ? 0 : Math.max(...knownValues);
  return points.map(({ recordId, trainingDate, value }) => ({
    key: recordId,
    trainingDate,
    dateLabel: formatShortDate(trainingDate),
    valueLabel: value === null ? '未记录' : formatter(value),
    known: value !== null,
    barPercent: value === null || max === 0
      ? 0
      : Math.max(12, Math.round(value / max * 100))
  }));
}

function createStatisticsView(projection) {
  const { summary } = projection;
  const completionRateLabel = summary.completionRate === null
    ? '—'
    : `${Math.round(summary.completionRate * 100)}%`;
  return {
    week: {
      rangeLabel: `${formatDate(projection.range.startDate)} - ${formatDate(projection.range.endDate)}`,
      completionRateLabel,
      completionCountLabel: `${summary.completedCount} / ${summary.plannedCount} 次`,
      noPlannedWorkouts: summary.plannedCount === 0
    },
    metrics: {
      activeMinutes: metric(String(Math.round(summary.totalActiveSeconds / 60)), '分钟'),
      treadmillMinutes: metric(
        `${summary.treadmillEstimated ? '约 ' : ''}${Math.round(summary.treadmillSeconds / 60)}`,
        '分钟',
        summary.treadmillEstimated ? '按已完成动作目标估算' : ''
      ),
      rowingMinutes: metric(
        `${summary.rowingEstimated ? '约 ' : ''}${Math.round(summary.rowingSeconds / 60)}`,
        '分钟',
        summary.rowingEstimated ? '按已完成组数估算' : ''
      ),
      strengthCount: metric(String(summary.strengthCount), '个动作'),
      streak: metric(String(summary.streakDays), '天', '截至最近一次完成训练')
    },
    latestStrength: {
      chest: weightView(projection.latestStrength.chest),
      back: weightView(projection.latestStrength.back)
    },
    latestBodyWeight: weightView(projection.latestBodyWeight),
    trends: [
      {
        key: 'duration',
        title: '训练时长',
        unit: '分钟',
        points: trendPoints(projection.recent.duration, (seconds) => String(Math.round(seconds / 60)))
      },
      {
        key: 'rpe',
        title: '主观强度',
        unit: 'RPE',
        points: trendPoints(projection.recent.rpe, (value) => String(value))
      },
      {
        key: 'weight',
        title: '训练前体重',
        unit: 'kg',
        points: trendPoints(projection.recent.weight, (value) => String(value))
      }
    ],
    emptyState: summary.plannedCount === 0
      ? {
        title: '本周还没有训练安排',
        guidance: '完成率保持未知；添加计划或完成训练后，这里会显示真实趋势。'
      }
      : null,
    privacyNotice: '统计只读取本机计划与训练记录，仅用于回顾训练记录，不用于诊断。'
  };
}

class StatisticsApplicationService {
  constructor({ service }) {
    if (!service || typeof service.getProjection !== 'function') {
      throw new Error('StatisticsApplicationService requires a statistics service');
    }
    this.service = service;
  }

  getView(selectedDate) {
    const range = getWeekRange(selectedDate);
    return createStatisticsView(this.service.getProjection(range));
  }
}

function createStatisticsApplicationService(options) {
  return new StatisticsApplicationService(options);
}

function developerFacts(state) {
  if (state === 'empty') {
    return { records: [], plans: [] };
  }
  const treadmill = {
    id: 'fixture_treadmill',
    kind: 'timed',
    name: '匿名跑步机快走',
    durationSeconds: 600,
    targets: { speedKph: { min: 4.8, max: 5.5 } }
  };
  const rowing = {
    id: 'fixture_rowing',
    kind: 'interval',
    name: '匿名划船练习',
    durationSeconds: 60,
    sets: 7,
    targets: { cadenceSpm: { min: 18, max: 22 } }
  };
  const chest = { id: 'fixture_chest', kind: 'strength', name: '综合训练器推胸' };
  const back = { id: 'fixture_back', kind: 'strength', name: '高位下拉或坐姿拉背' };
  const plans = [
    { id: 'fixture_plan_mon', trainingDate: '2026-08-03', status: 'scheduled', steps: [treadmill, chest] },
    { id: 'fixture_plan_tue', trainingDate: '2026-08-04', status: 'scheduled', steps: [rowing, back] },
    { id: 'fixture_plan_wed', trainingDate: '2026-08-05', status: 'scheduled', steps: [{ id: 'fixture_manual', kind: 'manual', name: '匿名活动' }] }
  ];
  const feedback = (rpe, weightBeforeKg) => ({
    rpe,
    weightBeforeKg,
    pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
    note: ''
  });
  const records = [
    {
      id: 'fixture_record_mon',
      revision: 1,
      status: 'completed',
      trainingDate: '2026-08-03',
      endedAt: 1785719400000,
      elapsedActiveSeconds: 1800,
      planSnapshot: { steps: [treadmill, chest] },
      stepResults: [
        { stepId: treadmill.id, status: 'completed', actualDurationSeconds: 600, setResults: [] },
        { stepId: chest.id, status: 'completed', setResults: [{ setNumber: 1 }] }
      ],
      feedback: feedback(7, 80.5)
    },
    {
      id: 'fixture_record_tue',
      revision: 1,
      status: 'completed',
      trainingDate: '2026-08-04',
      endedAt: 1785805800000,
      elapsedActiveSeconds: 1200,
      planSnapshot: { steps: [rowing, back] },
      stepResults: [
        { stepId: rowing.id, status: 'completed', actualDurationSeconds: 420, setResults: [] },
        { stepId: back.id, status: 'completed', setResults: [{ setNumber: 1 }] }
      ],
      feedback: feedback(6, null)
    }
  ];
  return { records, plans };
}

function createDeveloperStatisticsApplicationService(state = 'populated') {
  const allowedState = state === 'empty' ? 'empty' : 'populated';
  const facts = developerFacts(allowedState);
  const statistics = createStatisticsService({ now: () => 1786032000000 });
  return createStatisticsApplicationService({
    service: {
      getProjection(range) {
        return statistics.rebuild(facts.records, facts.plans, range);
      }
    }
  });
}

module.exports = {
  StatisticsApplicationService,
  createDeveloperStatisticsApplicationService,
  createStatisticsApplicationService,
  createStatisticsView
};
