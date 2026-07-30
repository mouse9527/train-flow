const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createDefaultPlans
} = require('../../miniprogram/domain/planning/default-plan-factory');
const {
  createWeekPlanView
} = require('../../miniprogram/application/week-plan-view');

const FIXED_NOW = 1785717300000;

function defaultPlans() {
  return createDefaultPlans({ now: () => FIXED_NOW });
}

test('WeekPlanView maps the confirmed seven-day week and joins completion, skip and discomfort summaries by trainingDate', () => {
  const view = createWeekPlanView({
    weekStart: '2026-08-03',
    plans: defaultPlans(),
    recordSummaries: [
      {
        trainingDate: '2026-08-03',
        completed: true,
        skipped: true,
        discomfort: true
      }
    ]
  });

  assert.equal(view.weekStart, '2026-08-03');
  assert.equal(view.weekEnd, '2026-08-09');
  assert.equal(view.previousWeekStart, '2026-07-27');
  assert.equal(view.nextWeekStart, '2026-08-10');
  assert.equal(view.isEmpty, false);
  assert.deepEqual(
    view.days.map(({ trainingDate, weekday }) => ({ trainingDate, weekday })),
    [
      { trainingDate: '2026-08-03', weekday: '周一' },
      { trainingDate: '2026-08-04', weekday: '周二' },
      { trainingDate: '2026-08-05', weekday: '周三' },
      { trainingDate: '2026-08-06', weekday: '周四' },
      { trainingDate: '2026-08-07', weekday: '周五' },
      { trainingDate: '2026-08-08', weekday: '周六' },
      { trainingDate: '2026-08-09', weekday: '周日' }
    ]
  );
  assert.deepEqual(
    {
      title: view.days[0].title,
      durationLabel: view.days[0].durationLabel,
      completionLabel: view.days[0].completionLabel,
      skippedLabel: view.days[0].skippedLabel,
      discomfortLabel: view.days[0].discomfortLabel
    },
    {
      title: '熟悉器械与基础力量',
      durationLabel: '38 分钟',
      completionLabel: '已完成',
      skippedLabel: '有跳过',
      discomfortLabel: '有不适'
    }
  );
  assert.equal(view.days[1].completionLabel, '未完成');
  assert.equal(view.days[1].skippedLabel, '无跳过');
  assert.equal(view.days[1].discomfortLabel, '无不适');
});

test('WeekPlanView preserves previous/next week boundaries and returns a useful empty week without cloning plans', () => {
  const empty = createWeekPlanView({
    weekStart: '2026-08-10',
    plans: [],
    recordSummaries: []
  });

  assert.equal(empty.weekStart, '2026-08-10');
  assert.equal(empty.weekEnd, '2026-08-16');
  assert.equal(empty.previousWeekStart, '2026-08-03');
  assert.equal(empty.nextWeekStart, '2026-08-17');
  assert.equal(empty.isEmpty, true);
  assert.equal(empty.emptyMessage, '这一周还没有训练计划');
  assert.deepEqual(empty.days, []);
  assert.equal(empty.selectedDay, null);
});

test('WeekPlanView selects any day and exposes ordered kind-specific step duration, set, target and rest details', () => {
  const view = createWeekPlanView({
    weekStart: '2026-08-03',
    selectedDate: '2026-08-06',
    plans: defaultPlans(),
    recordSummaries: []
  });

  assert.equal(view.selectedDay.trainingDate, '2026-08-06');
  assert.deepEqual(view.selectedDay.steps.map(({ order }) => order), [10, 20, 30, 40, 50, 60, 70]);

  const interval = view.selectedDay.steps[1];
  assert.equal(interval.kind, 'interval');
  assert.deepEqual(interval.metrics, [
    { label: '训练', value: '5 组 × 60 秒' },
    { label: '组间休息', value: '30 秒' }
  ]);
  assert.deepEqual(interval.targets, [
    { label: '阻力', value: '按舒适度调整' },
    { label: '桨频', value: '18–22 次/分' }
  ]);

  const strength = view.selectedDay.steps[2];
  assert.deepEqual(strength.metrics, [
    { label: '训练', value: '2 组 × 12 次' },
    { label: '组间休息', value: '75 秒' }
  ]);

  const timed = view.selectedDay.steps[0];
  assert.deepEqual(timed.metrics, [{ label: '时长', value: '5 分钟' }]);
  assert.deepEqual(timed.targets, [{ label: '速度', value: '4–4.5 km/h' }]);

  const recovery = createWeekPlanView({
    weekStart: '2026-08-03',
    selectedDate: '2026-08-05',
    plans: defaultPlans(),
    recordSummaries: []
  });
  const manual = recovery.selectedDay.steps.find(({ kind }) => kind === 'manual');
  assert.deepEqual(manual.metrics, [
    { label: '训练', value: '1 组 × 10 次（手动确认）' }
  ]);
});

test('WeekPlanView maps Sunday as rest guidance without total timer or start-workout action', () => {
  const view = createWeekPlanView({
    weekStart: '2026-08-03',
    selectedDate: '2026-08-09',
    plans: defaultPlans(),
    recordSummaries: []
  });

  assert.equal(view.selectedDay.title, '完全休息');
  assert.equal(view.selectedDay.isRestDay, true);
  assert.equal(view.selectedDay.durationLabel, '休息日');
  assert.equal(view.selectedDay.totalDurationLabel, null);
  assert.equal(view.selectedDay.canStartWorkout, false);
  assert.equal(view.selectedDay.steps[0].kind, 'rest_day');
  assert.deepEqual(view.selectedDay.steps[0].metrics, [
    { label: '安排', value: '无需计时，保持日常活动' }
  ]);
  assert.match(view.selectedDay.restGuidance, /不补练/);
  assert.ok(view.selectedDay.safetyNotices.includes('休息日不补练，保证睡眠与恢复。'));
  assert.ok(view.selectedDay.safetyNotices.includes('训练前后注意补水。'));
});
