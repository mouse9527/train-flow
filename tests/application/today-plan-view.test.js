const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTodayPlanView,
  createTodayPlanApplicationService
} = require('../../miniprogram/application/today-plan-view');

function plan({
  id = 'plan_monday',
  trainingDate = '2026-08-03',
  title = '基础训练',
  estimatedDurationSeconds = 2280,
  recommendedEndLocalTime = '09:10',
  safetyNoticeCodes = ['STOP_ON_ALARM_SYMPTOMS'],
  steps = [
    {
      id: 'step_two',
      order: 20,
      kind: 'strength',
      name: '坐姿划船',
      description: '保持动作稳定。',
      durationSeconds: null,
      sets: 2,
      reps: 12,
      restSeconds: 75,
      optional: false
    },
    {
      id: 'step_one',
      order: 10,
      kind: 'timed',
      name: '热身快走',
      description: '',
      durationSeconds: 300,
      sets: null,
      reps: null,
      restSeconds: null,
      optional: false
    }
  ]
} = {}) {
  return {
    id,
    trainingDate,
    timezone: 'Asia/Shanghai',
    title,
    estimatedDurationSeconds,
    recommendedEndLocalTime,
    safetyNoticeCodes,
    status: 'scheduled',
    steps
  };
}

function record({
  id = 'record_monday',
  trainingDate = '2026-08-03',
  status = 'completed',
  elapsedActiveSeconds = 2040,
  startedAt = 1785717300000,
  endedAt = 1785719340000,
  deletedAt = null
} = {}) {
  return {
    id,
    trainingDate,
    status,
    elapsedActiveSeconds,
    startedAt,
    endedAt,
    deletedAt
  };
}

test('scheduled TodayPlanView exposes ordered plan details and only the start action', () => {
  const source = plan();
  const view = buildTodayPlanView({
    selectedDate: '2026-08-03',
    plan: source,
    weekPlans: [source],
    weekRecords: [],
    activeSession: null
  });

  assert.equal(view.state, 'scheduled');
  assert.equal(view.dateLabel, '8月3日');
  assert.equal(view.weekdayLabel, '星期一');
  assert.equal(view.title, '基础训练');
  assert.equal(view.estimatedDurationLabel, '约 38 分钟');
  assert.equal(view.recommendedEndLabel, '建议 09:10 前结束');
  assert.deepEqual(view.primaryAction, {
    id: 'start',
    label: '开始训练',
    navigationMode: 'navigateTo',
    url: '/pages/workout/index?planId=plan_monday'
  });
  assert.deepEqual(view.steps.map(({ id }) => id), ['step_one', 'step_two']);
  assert.equal(view.steps[0].targetLabel, '5 分钟');
  assert.equal(view.steps[1].targetLabel, '2 组 × 12 次 · 休息 75 秒');
  assert.deepEqual(view.safetyNotices, ['如有胸闷、剧烈头晕或关节剧痛，请立即停止训练。']);
  assert.equal(view.weekSummary.completedCount, 0);
  assert.equal(view.weekSummary.plannedCount, 1);
  assert.equal(view.weekSummary.completionRate, 0);
  assert.equal(view.completedSessionSummary, null);
  assert.deepEqual(source.steps.map(({ id }) => id), ['step_two', 'step_one']);
});

test('active session wins over scheduled state and exposes only continue', () => {
  const source = plan();
  const view = buildTodayPlanView({
    selectedDate: source.trainingDate,
    plan: source,
    weekPlans: [source],
    weekRecords: [],
    activeSession: {
      id: 'session_active',
      planId: source.id,
      trainingDate: source.trainingDate,
      status: 'in_progress',
      currentStepIndex: 1
    }
  });

  assert.equal(view.state, 'active');
  assert.equal(view.stateTitle, '训练进行中');
  assert.equal(view.stateDetail, '正在进行第 2 个动作');
  assert.deepEqual(view.primaryAction, {
    id: 'continue',
    label: '继续训练',
    navigationMode: 'navigateTo',
    url: '/pages/workout/index?sessionId=session_active'
  });
});

test('completed and skipped records produce honest terminal states without a start action', () => {
  const source = plan();
  const completed = buildTodayPlanView({
    selectedDate: source.trainingDate,
    plan: source,
    weekPlans: [source],
    weekRecords: [record()],
    activeSession: null
  });

  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.primaryAction, {
    id: 'view_record',
    label: '查看训练记录',
    navigationMode: 'switchTab',
    url: '/pages/record/index?recordId=record_monday'
  });
  assert.deepEqual(completed.completedSessionSummary, {
    recordId: 'record_monday',
    durationLabel: '34 分钟',
    endedAtLabel: '09:09 完成'
  });
  assert.deepEqual(completed.weekSummary, {
    completedCount: 1,
    plannedCount: 1,
    completionRate: 100,
    label: '本周完成 1 / 1 · 100%'
  });

  const skipped = buildTodayPlanView({
    selectedDate: source.trainingDate,
    plan: source,
    weekPlans: [source],
    weekRecords: [record({ id: 'record_skipped', status: 'skipped', elapsedActiveSeconds: 0 })],
    activeSession: null
  });
  assert.equal(skipped.state, 'skipped');
  assert.equal(skipped.primaryAction, null);
  assert.equal(skipped.completedSessionSummary, null);
});

test('rest day never exposes a timer action and zero planned days use a null completion rate', () => {
  const restPlan = plan({
    id: 'plan_sunday',
    trainingDate: '2026-08-09',
    title: '完全休息',
    estimatedDurationSeconds: 0,
    recommendedEndLocalTime: null,
    safetyNoticeCodes: ['REST_NO_CATCH_UP'],
    steps: [{
      id: 'step_rest',
      order: 10,
      kind: 'rest_day',
      name: '休息与日常活动',
      description: '保持正常生活活动，不安排正式训练。',
      durationSeconds: null,
      sets: null,
      reps: null,
      restSeconds: null,
      optional: false
    }]
  });
  const view = buildTodayPlanView({
    selectedDate: restPlan.trainingDate,
    plan: restPlan,
    weekPlans: [restPlan],
    weekRecords: [],
    activeSession: null
  });

  assert.equal(view.state, 'rest');
  assert.equal(view.primaryAction, null);
  assert.equal(view.recommendedEndLabel, null);
  assert.equal(view.steps[0].targetLabel, '休息日');
  assert.deepEqual(view.weekSummary, {
    completedCount: 0,
    plannedCount: 0,
    completionRate: null,
    label: '本周暂无安排的训练'
  });
});

test('no-plan state is explicit and does not invent plan or record data', () => {
  const view = buildTodayPlanView({
    selectedDate: '2026-08-10',
    plan: null,
    weekPlans: [],
    weekRecords: [],
    activeSession: null
  });

  assert.equal(view.state, 'empty');
  assert.equal(view.title, '今天还没有训练安排');
  assert.equal(view.primaryAction, null);
  assert.deepEqual(view.steps, []);
  assert.deepEqual(view.safetyNotices, []);
  assert.equal(view.weekSummary.completionRate, null);
});

test('application service joins repositories for the selected week without date hard-coding', () => {
  const monday = plan();
  const tuesday = plan({ id: 'plan_tuesday', trainingDate: '2026-08-04' });
  const calls = [];
  const service = createTodayPlanApplicationService({
    planRepository: {
      findByDate(date) {
        calls.push(['plan-date', date]);
        return date === monday.trainingDate ? monday : null;
      },
      findRange(startDate, endDate) {
        calls.push(['plan-range', startDate, endDate]);
        return [monday, tuesday];
      }
    },
    recordRepository: {
      findByDateRange(startDate, endDate) {
        calls.push(['record-range', startDate, endDate]);
        return [record()];
      }
    },
    activeSessionRepository: {
      findActive() {
        calls.push(['active']);
        return null;
      }
    }
  });

  const view = service.getTodayPlan('2026-08-03');

  assert.equal(view.state, 'completed');
  assert.deepEqual(calls, [
    ['plan-date', '2026-08-03'],
    ['plan-range', '2026-08-03', '2026-08-09'],
    ['record-range', '2026-08-03', '2026-08-09'],
    ['active']
  ]);
});

test('TodayPlanView rejects invalid dates and ignores deleted or out-of-range records', () => {
  assert.throws(() => buildTodayPlanView({
    selectedDate: '2026-02-30',
    plan: null,
    weekPlans: [],
    weekRecords: [],
    activeSession: null
  }), /real calendar date/);

  const monday = plan();
  const view = buildTodayPlanView({
    selectedDate: monday.trainingDate,
    plan: monday,
    weekPlans: [monday],
    weekRecords: [
      record({ deletedAt: 1785720000000 }),
      record({ id: 'outside', trainingDate: '2026-08-10' })
    ],
    activeSession: null
  });
  assert.equal(view.state, 'scheduled');
  assert.equal(view.weekSummary.completedCount, 0);
});
