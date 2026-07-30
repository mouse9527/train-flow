const SAFETY_NOTICE_COPY = Object.freeze({
  NO_RUNNING_OR_SPRINTING: '以快走为主，不进行跑步或冲刺。',
  LEAVE_REPS_IN_RESERVE: '力量动作保留余力，不做到力竭。',
  LOWER_INCLINE_ON_DISCOMFORT: '如有不适，请降低坡度或停止训练。',
  RECOVERY_DAY: '恢复日保持轻松强度，以身体感受为准。',
  STOP_ON_ALARM_SYMPTOMS: '如有胸闷、剧烈头晕或关节剧痛，请立即停止训练。',
  ROW_LOW_RESISTANCE: '划船练习使用低阻力，优先保持动作稳定。',
  SKIP_ROWING_ON_SORE_BACK: '腰背不适时跳过划船动作。',
  STAY_HYDRATED: '训练前后注意补水。',
  EASY_OUTDOOR_WALK: '户外步行保持轻松，不追求配速。',
  REST_NO_CATCH_UP: '休息日不补练，让身体充分恢复。'
});

const WEEKDAY_LABELS = Object.freeze([
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六'
]);

function clone(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function parseTrainingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('selectedDate must be YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('selectedDate must be a real calendar date');
  }
  return parsed;
}

function formatTrainingDate(date) {
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

function addDays(date, dayCount) {
  return new Date(date.getTime() + dayCount * 24 * 60 * 60 * 1000);
}

function toTrainingDate(date) {
  return date.toISOString().slice(0, 10);
}

function getWeekRange(selectedDate) {
  const date = parseTrainingDate(selectedDate);
  const day = date.getUTCDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  const start = addDays(date, -daysFromMonday);
  return {
    startDate: toTrainingDate(start),
    endDate: toTrainingDate(addDays(start, 6))
  };
}

function minutesLabel(seconds, { approximate = false } = {}) {
  const minutes = Math.round(seconds / 60);
  return `${approximate ? '约 ' : ''}${minutes} 分钟`;
}

function formatLocalTime(epochMs, timezone) {
  if (!Number.isFinite(epochMs)) {
    return null;
  }
  const offsetMinutes = timezone === 'UTC' ? 0 : 8 * 60;
  const shifted = new Date(epochMs + offsetMinutes * 60 * 1000);
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

function isRestPlan(plan) {
  return Boolean(plan && plan.steps && plan.steps.some(({ kind }) => kind === 'rest_day'));
}

function stepTargetLabel(step) {
  if (step.kind === 'rest_day') {
    return '休息日';
  }
  if (step.kind === 'timed') {
    return minutesLabel(step.durationSeconds);
  }
  if (step.kind === 'interval') {
    const parts = [`${step.sets} 轮 × ${step.durationSeconds} 秒`];
    if (step.restSeconds) {
      parts.push(`休息 ${step.restSeconds} 秒`);
    }
    return parts.join(' · ');
  }
  if (step.kind === 'strength' || step.kind === 'manual') {
    const parts = [`${step.sets} 组 × ${step.reps} 次`];
    if (step.restSeconds) {
      parts.push(`休息 ${step.restSeconds} 秒`);
    }
    return parts.join(' · ');
  }
  return '';
}

function projectSteps(steps) {
  return [...steps]
    .sort((left, right) => left.order - right.order)
    .map((step, index) => ({
      id: step.id,
      order: step.order,
      sequence: index + 1,
      kind: step.kind,
      name: step.name,
      description: step.description || '',
      targetLabel: stepTargetLabel(step),
      optional: Boolean(step.optional)
    }));
}

function projectSafetyNotices(codes) {
  return codes.map((code) => (
    SAFETY_NOTICE_COPY[code] || '训练时请以安全和身体感受为先。'
  ));
}

function validRecord(record, startDate, endDate) {
  return Boolean(
    record &&
    !record.deletedAt &&
    typeof record.trainingDate === 'string' &&
    record.trainingDate >= startDate &&
    record.trainingDate <= endDate
  );
}

function buildWeekSummary(weekPlans, weekRecords, startDate, endDate) {
  const plannedDates = new Set(
    weekPlans
      .filter((candidate) => (
        candidate &&
        candidate.status !== 'deleted' &&
        candidate.trainingDate >= startDate &&
        candidate.trainingDate <= endDate &&
        !isRestPlan(candidate)
      ))
      .map(({ trainingDate }) => trainingDate)
  );
  const completedDates = new Set(
    weekRecords
      .filter((candidate) => (
        validRecord(candidate, startDate, endDate) &&
        candidate.status === 'completed' &&
        plannedDates.has(candidate.trainingDate)
      ))
      .map(({ trainingDate }) => trainingDate)
  );
  const plannedCount = plannedDates.size;
  const completedCount = completedDates.size;
  if (plannedCount === 0) {
    return {
      completedCount,
      plannedCount,
      completionRate: null,
      label: '本周暂无安排的训练'
    };
  }
  const completionRate = Math.round((completedCount / plannedCount) * 100);
  return {
    completedCount,
    plannedCount,
    completionRate,
    label: `本周完成 ${completedCount} / ${plannedCount} · ${completionRate}%`
  };
}

function findTodayRecord(weekRecords, selectedDate) {
  return weekRecords
    .filter((candidate) => validRecord(candidate, selectedDate, selectedDate))
    .sort((left, right) => (right.endedAt || 0) - (left.endedAt || 0))[0] || null;
}

function matchesActiveSession(activeSession, plan, selectedDate) {
  return Boolean(
    activeSession &&
    ['in_progress', 'paused'].includes(activeSession.status) &&
    activeSession.trainingDate === selectedDate &&
    (!plan || activeSession.planId === plan.id)
  );
}

function resolveState({ activeSession, plan, todayRecord, selectedDate }) {
  if (matchesActiveSession(activeSession, plan, selectedDate)) {
    return 'active';
  }
  if (todayRecord && todayRecord.status === 'completed') {
    return 'completed';
  }
  if (todayRecord && ['skipped', 'aborted'].includes(todayRecord.status)) {
    return 'skipped';
  }
  if (!plan) {
    return 'empty';
  }
  if (isRestPlan(plan)) {
    return 'rest';
  }
  return 'scheduled';
}

function statePresentation(state, { activeSession, plan, todayRecord }) {
  if (state === 'active') {
    return {
      stateTitle: '训练进行中',
      stateDetail: `正在进行第 ${(activeSession.currentStepIndex || 0) + 1} 个动作`,
      primaryAction: {
        id: 'continue',
        label: '继续训练',
        navigationMode: 'navigateTo',
        url: `/pages/workout/index?sessionId=${encodeURIComponent(activeSession.id)}`
      }
    };
  }
  if (state === 'completed') {
    return {
      stateTitle: '今日训练已完成',
      stateDetail: '辛苦了，今天的训练记录已保存。',
      primaryAction: {
        id: 'view_record',
        label: '查看训练记录',
        navigationMode: 'switchTab',
        url: `/pages/record/index?recordId=${encodeURIComponent(todayRecord.id)}`
      }
    };
  }
  if (state === 'skipped') {
    return {
      stateTitle: '今日训练已跳过',
      stateDetail: '按身体状态调整计划也是训练的一部分。',
      primaryAction: null
    };
  }
  if (state === 'rest') {
    return {
      stateTitle: '今天是休息日',
      stateDetail: '不补练，给身体完整的恢复时间。',
      primaryAction: null
    };
  }
  if (state === 'empty') {
    return {
      stateTitle: '暂无计划',
      stateDetail: '可以前往一周计划查看或安排训练。',
      primaryAction: null
    };
  }
  return {
    stateTitle: '准备好就开始',
    stateDetail: '按照动作顺序完成，过程中随时以身体感受为准。',
    primaryAction: {
      id: 'start',
      label: '开始训练',
      navigationMode: 'navigateTo',
      url: `/pages/workout/index?planId=${encodeURIComponent(plan.id)}`
    }
  };
}

function buildTodayPlanView({
  selectedDate,
  plan,
  weekPlans = [],
  weekRecords = [],
  activeSession = null
}) {
  const date = parseTrainingDate(selectedDate);
  if (!Array.isArray(weekPlans) || !Array.isArray(weekRecords)) {
    throw new Error('weekPlans and weekRecords must be arrays');
  }
  const { startDate, endDate } = getWeekRange(selectedDate);
  const safePlan = clone(plan);
  const safeRecords = clone(weekRecords);
  const safeSession = clone(activeSession);
  const todayRecord = findTodayRecord(safeRecords, selectedDate);
  const state = resolveState({
    activeSession: safeSession,
    plan: safePlan,
    todayRecord,
    selectedDate
  });
  const presentation = statePresentation(state, {
    activeSession: safeSession,
    plan: safePlan,
    todayRecord
  });
  const timezone = safePlan ? safePlan.timezone : 'Asia/Shanghai';

  return {
    selectedDate,
    dateLabel: formatTrainingDate(date),
    weekdayLabel: WEEKDAY_LABELS[date.getUTCDay()],
    state,
    ...presentation,
    planId: safePlan ? safePlan.id : null,
    title: safePlan ? safePlan.title : '今天还没有训练安排',
    estimatedDurationLabel: safePlan && !isRestPlan(safePlan)
      ? minutesLabel(safePlan.estimatedDurationSeconds, { approximate: true })
      : null,
    recommendedEndLabel: safePlan && safePlan.recommendedEndLocalTime
      ? `建议 ${safePlan.recommendedEndLocalTime} 前结束`
      : null,
    safetyNotices: safePlan ? projectSafetyNotices(safePlan.safetyNoticeCodes || []) : [],
    steps: safePlan ? projectSteps(safePlan.steps || []) : [],
    weekSummary: buildWeekSummary(clone(weekPlans), safeRecords, startDate, endDate),
    completedSessionSummary: state === 'completed'
      ? {
        recordId: todayRecord.id,
        durationLabel: minutesLabel(todayRecord.elapsedActiveSeconds),
        endedAtLabel: `${formatLocalTime(todayRecord.endedAt, timezone)} 完成`
      }
      : null
  };
}

class TodayPlanApplicationService {
  constructor({ planRepository, recordRepository, activeSessionRepository }) {
    if (
      !planRepository ||
      typeof planRepository.findByDate !== 'function' ||
      typeof planRepository.findRange !== 'function'
    ) {
      throw new Error('TodayPlanApplicationService requires a PlanRepository');
    }
    if (!recordRepository || typeof recordRepository.findByDateRange !== 'function') {
      throw new Error('TodayPlanApplicationService requires a TrainingRecordRepository');
    }
    if (!activeSessionRepository || typeof activeSessionRepository.findActive !== 'function') {
      throw new Error('TodayPlanApplicationService requires an ActiveSessionRepository');
    }
    this.planRepository = planRepository;
    this.recordRepository = recordRepository;
    this.activeSessionRepository = activeSessionRepository;
  }

  getTodayPlan(selectedDate) {
    const { startDate, endDate } = getWeekRange(selectedDate);
    return buildTodayPlanView({
      selectedDate,
      plan: this.planRepository.findByDate(selectedDate),
      weekPlans: this.planRepository.findRange(startDate, endDate),
      weekRecords: this.recordRepository.findByDateRange(startDate, endDate),
      activeSession: this.activeSessionRepository.findActive()
    });
  }
}

function createTodayPlanApplicationService(options) {
  return new TodayPlanApplicationService(options);
}

module.exports = {
  SAFETY_NOTICE_COPY,
  TodayPlanApplicationService,
  buildTodayPlanView,
  createTodayPlanApplicationService,
  getWeekRange
};
