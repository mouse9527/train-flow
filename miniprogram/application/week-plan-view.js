const DEFAULT_WEEK_START = '2026-08-03';
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const { TIMEZONE_PATTERN } = require('../utils/constants');

const RECORD_SUMMARY_FIELDS = Object.freeze([
  'trainingDate',
  'timezone',
  'completed',
  'skipped',
  'discomfort'
]);
const WEIGHT_TARGET_KEY = 'weightKg';

const TARGET_DISPLAY = Object.freeze({
  speedKph: { label: '速度', suffix: ' km/h' },
  inclinePercent: { label: '坡度', suffix: '%' },
  resistance: { label: '阻力', suffix: '' },
  cadenceSpm: { label: '桨频', suffix: ' 次/分' },
  durationSeconds: { label: '时长', suffix: '', duration: true },
  [WEIGHT_TARGET_KEY]: { label: '重量', suffix: ' kg' },
  effortRpe: { label: '主观强度', prefix: 'RPE ', suffix: '' }
});

const SAFETY_NOTICE_COPY = Object.freeze({
  NO_RUNNING_OR_SPRINTING: '不跑步、不冲刺，保持可对话强度。',
  LEAVE_REPS_IN_RESERVE: '力量动作保留余力，不做到力竭。',
  LOWER_INCLINE_ON_DISCOMFORT: '出现不适时降低坡度或停止。',
  RECOVERY_DAY: '恢复日保持轻松，不额外增加强度。',
  STOP_ON_ALARM_SYMPTOMS: '如有胸闷、剧烈头晕或关节剧痛，请立即停止。',
  ROW_LOW_RESISTANCE: '划船使用低阻力，先保证动作顺序。',
  SKIP_ROWING_ON_SORE_BACK: '腰背酸痛时跳过划船动作。',
  STAY_HYDRATED: '训练前后注意补水。',
  EASY_OUTDOOR_WALK: '户外步行以轻松和放松为主。',
  REST_NO_CATCH_UP: '休息日不补练，保证睡眠与恢复。'
});

function assertDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date`);
  }
  return parsed;
}

function addDays(trainingDate, days) {
  const parsed = assertDate(trainingDate, 'trainingDate');
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function formatDate(trainingDate) {
  return `${trainingDate.slice(5, 7)}月${trainingDate.slice(8, 10)}日`;
}

function formatSeconds(seconds) {
  if (seconds % 60 === 0) {
    return `${seconds / 60} 分钟`;
  }
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatTargetNumber(value, display) {
  if (display.duration) {
    return formatSeconds(value);
  }
  return `${display.prefix || ''}${value}${display.suffix}`;
}

function mapTarget(key, range) {
  const display = TARGET_DISPLAY[key] || { label: key, suffix: '' };
  if (range === null) {
    return { label: display.label, value: '按舒适度调整' };
  }
  const min = Object.prototype.hasOwnProperty.call(range, 'min') ? range.min : null;
  const max = Object.prototype.hasOwnProperty.call(range, 'max') ? range.max : null;
  if (min === null && max === null) {
    return { label: display.label, value: '按舒适度调整' };
  }
  if (min === max || max === null) {
    return { label: display.label, value: formatTargetNumber(min, display) };
  }
  if (min === null) {
    return { label: display.label, value: `不高于 ${formatTargetNumber(max, display)}` };
  }
  if (display.duration) {
    return {
      label: display.label,
      value: `${formatTargetNumber(min, display)}–${formatTargetNumber(max, display)}`
    };
  }
  return {
    label: display.label,
    value: `${display.prefix || ''}${min}–${max}${display.suffix}`
  };
}

function mapStepMetrics(step) {
  if (step.kind === 'timed') {
    return [{ label: '时长', value: formatSeconds(step.durationSeconds) }];
  }
  if (step.kind === 'strength') {
    return [
      { label: '训练', value: `${step.sets} 组 × ${step.reps} 次` },
      { label: '组间休息', value: `${step.restSeconds} 秒` }
    ];
  }
  if (step.kind === 'interval') {
    return [
      { label: '训练', value: `${step.sets} 组 × ${step.durationSeconds} 秒` },
      { label: '组间休息', value: `${step.restSeconds} 秒` }
    ];
  }
  if (step.kind === 'manual') {
    if (step.sets !== null && step.reps !== null) {
      return [{ label: '训练', value: `${step.sets} 组 × ${step.reps} 次（手动确认）` }];
    }
    if (step.sets !== null) {
      return [{ label: '训练', value: `${step.sets} 组（手动确认）` }];
    }
    if (step.reps !== null) {
      return [{ label: '训练', value: `${step.reps} 次（手动确认）` }];
    }
    return [{ label: '训练', value: '手动确认' }];
  }
  return [{ label: '安排', value: '无需计时，保持日常活动' }];
}

function mapStep(step) {
  return {
    id: step.id,
    order: step.order,
    kind: step.kind,
    name: step.name,
    description: step.description,
    optional: step.optional,
    metrics: mapStepMetrics(step),
    targets: Object.entries(step.targets).map(([key, range]) => mapTarget(key, range)),
    alternatives: [...step.alternatives],
    safetyNotices: step.safetyNoticeCodes.map(mapSafetyNotice)
  };
}

function mapSafetyNotice(code) {
  return SAFETY_NOTICE_COPY[code] || `请注意：${code}`;
}

function createRecordSummaryIndex(recordSummaries) {
  const index = new Map();
  for (const summary of recordSummaries) {
    if (
      !summary ||
      typeof summary !== 'object' ||
      Array.isArray(summary) ||
      Object.getPrototypeOf(summary) !== Object.prototype
    ) {
      throw new Error('record summary must be a plain object');
    }
    const fields = Object.getOwnPropertyNames(summary);
    if (
      Object.getOwnPropertySymbols(summary).length > 0 ||
      fields.length !== RECORD_SUMMARY_FIELDS.length ||
      fields.some((field) => !RECORD_SUMMARY_FIELDS.includes(field)) ||
      RECORD_SUMMARY_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(summary, field))
    ) {
      throw new Error('record summary must use the closed summary schema');
    }
    assertDate(summary.trainingDate, 'record summary trainingDate');
    if (typeof summary.timezone !== 'string' || !TIMEZONE_PATTERN.test(summary.timezone)) {
      throw new Error('record summary timezone must be UTC or an IANA timezone');
    }
    for (const field of ['completed', 'skipped', 'discomfort']) {
      if (typeof summary[field] !== 'boolean') {
        throw new Error(`record summary ${field} must be a boolean`);
      }
    }
    const key = `${summary.trainingDate}\u0000${summary.timezone}`;
    if (index.has(key)) {
      throw new Error('record summary trainingDate and timezone must be unique');
    }
    index.set(key, summary);
  }
  return index;
}

function mapDay(plan, summary, selectedDate) {
  const steps = [...plan.steps].sort((left, right) => left.order - right.order).map(mapStep);
  const isRestDay = steps.length > 0 && steps.every(({ kind }) => kind === 'rest_day');
  const completed = summary ? summary.completed : false;
  const skipped = summary ? summary.skipped : false;
  const discomfort = summary ? summary.discomfort : false;
  const safetyNotices = plan.safetyNoticeCodes.map(mapSafetyNotice);
  const restGuidance = isRestDay
    ? [plan.summary, ...steps.map(({ description }) => description)].filter(Boolean).join(' ')
    : null;

  return {
    id: plan.id,
    trainingDate: plan.trainingDate,
    dateLabel: formatDate(plan.trainingDate),
    weekday: WEEKDAY_LABELS[assertDate(plan.trainingDate, 'plan trainingDate').getUTCDay()],
    title: plan.title,
    summary: plan.summary,
    selected: plan.trainingDate === selectedDate,
    estimatedDurationSeconds: plan.estimatedDurationSeconds,
    durationLabel: isRestDay ? '休息日' : `${Math.round(plan.estimatedDurationSeconds / 60)} 分钟`,
    totalDurationLabel: isRestDay ? null : `预计 ${Math.round(plan.estimatedDurationSeconds / 60)} 分钟`,
    completionLabel: isRestDay ? '休息日' : completed ? '已完成' : '未完成',
    skippedLabel: skipped ? '有跳过' : '无跳过',
    discomfortLabel: discomfort ? '有不适' : '无不适',
    isRestDay,
    canStartWorkout: !isRestDay,
    restGuidance,
    safetyNotices,
    steps
  };
}

function createWeekPlanView({
  weekStart = DEFAULT_WEEK_START,
  selectedDate = null,
  plans = [],
  recordSummaries = []
} = {}) {
  const parsedWeekStart = assertDate(weekStart, 'weekStart');
  if (parsedWeekStart.getUTCDay() !== 1) {
    throw new Error('weekStart must be a Monday');
  }
  if (!Array.isArray(plans)) {
    throw new Error('plans must be an array');
  }
  if (!Array.isArray(recordSummaries)) {
    throw new Error('recordSummaries must be an array');
  }
  if (selectedDate !== null) {
    assertDate(selectedDate, 'selectedDate');
  }

  const weekEnd = addDays(weekStart, 6);
  const summariesByDate = createRecordSummaryIndex(recordSummaries);
  const plansInWeek = plans
    .filter(({ trainingDate }) => trainingDate >= weekStart && trainingDate <= weekEnd)
    .sort((left, right) => left.trainingDate.localeCompare(right.trainingDate));
  const effectiveSelectedDate = plansInWeek.some(({ trainingDate }) => trainingDate === selectedDate)
    ? selectedDate
    : plansInWeek[0] ? plansInWeek[0].trainingDate : null;
  const days = plansInWeek.map((plan) => mapDay(
    plan,
    summariesByDate.get(`${plan.trainingDate}\u0000${plan.timezone}`) || null,
    effectiveSelectedDate
  ));
  const plannedDates = new Set(plansInWeek.map(({ trainingDate }) => trainingDate));
  const emptyDates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
    .filter((trainingDate) => !plannedDates.has(trainingDate))
    .map((trainingDate) => ({
      trainingDate,
      dateLabel: formatDate(trainingDate),
      weekday: WEEKDAY_LABELS[assertDate(trainingDate, 'empty trainingDate').getUTCDay()]
    }));

  return {
    weekStart,
    weekEnd,
    weekRangeLabel: `${formatDate(weekStart)} - ${formatDate(weekEnd)}`,
    previousWeekStart: addDays(weekStart, -7),
    nextWeekStart: addDays(weekStart, 7),
    isEmpty: days.length === 0,
    emptyMessage: days.length === 0 ? '这一周还没有训练计划' : null,
    emptyGuidance: days.length === 0 ? '可在下方选择日期并新增训练日' : null,
    emptyDates,
    days,
    selectedDay: days.find(({ trainingDate }) => trainingDate === effectiveSelectedDate) || null
  };
}

module.exports = {
  DEFAULT_WEEK_START,
  createWeekPlanView
};
