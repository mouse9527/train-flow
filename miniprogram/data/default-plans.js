const DEFAULT_PLAN_TEMPLATE_VERSION = 'builtin_v1';

function step({
  id,
  order,
  kind,
  name,
  description = '',
  durationSeconds = null,
  sets = null,
  reps = null,
  restSeconds = null,
  targets = {},
  optional = false,
  alternatives = [],
  safetyNoticeCodes = []
}) {
  return {
    id,
    order,
    kind,
    name,
    description,
    durationSeconds,
    sets,
    reps,
    restSeconds,
    targets,
    optional,
    alternatives,
    safetyNoticeCodes
  };
}

function plan({
  id,
  trainingDate,
  title,
  summary,
  estimatedDurationSeconds,
  recommendedEndLocalTime = '09:10',
  safetyNoticeCodes,
  steps
}) {
  return {
    schemaVersion: 1,
    id,
    trainingDate,
    timezone: 'Asia/Shanghai',
    title,
    summary,
    estimatedDurationSeconds,
    recommendedEndLocalTime,
    safetyNoticeCodes,
    status: 'scheduled',
    steps
  };
}

const DEFAULT_PLAN_TEMPLATE = [
  plan({
    id: 'plan_20260803_builtin',
    trainingDate: '2026-08-03',
    title: '熟悉器械与基础力量',
    summary: '熟悉动作与轻重量，保留余力。',
    estimatedDurationSeconds: 2280,
    safetyNoticeCodes: ['NO_RUNNING_OR_SPRINTING', 'LEAVE_REPS_IN_RESERVE'],
    steps: [
      step({ id: 'step_20260803_treadmill_warmup', order: 10, kind: 'timed', name: '跑步机热身', description: '逐渐进入状态。', durationSeconds: 300, targets: { speedKph: { min: 4, max: 4.5 }, inclinePercent: { min: 0, max: 0 } } }),
      step({ id: 'step_20260803_treadmill_brisk', order: 20, kind: 'timed', name: '跑步机快走', description: '保持能够说完整句子的强度。', durationSeconds: 720, targets: { speedKph: { min: 4.8, max: 5.5 }, inclinePercent: { min: 1, max: 1 } } }),
      step({ id: 'step_20260803_treadmill_slow', order: 30, kind: 'timed', name: '跑步机放缓', durationSeconds: 180, targets: { speedKph: { min: 4, max: 4 }, inclinePercent: { min: 0, max: 0 } } }),
      step({ id: 'step_20260803_chest_press', order: 40, kind: 'strength', name: '综合训练器推胸', description: '使用轻重量并保留三到四次余力。', sets: 2, reps: 12, restSeconds: 75 }),
      step({ id: 'step_20260803_lat_pull', order: 50, kind: 'strength', name: '高位下拉或坐姿拉背', description: '胸口微抬，肩膀保持放松。', sets: 2, reps: 12, restSeconds: 75 }),
      step({ id: 'step_20260803_sit_to_stand', order: 60, kind: 'strength', name: '坐凳起立', description: '轻触凳面后站起，膝盖与脚尖方向一致。', sets: 2, reps: 10, restSeconds: 60 }),
      step({ id: 'step_20260803_cooldown', order: 70, kind: 'timed', name: '慢走与整理', description: '恢复呼吸。', durationSeconds: 300 })
    ]
  }),
  plan({
    id: 'plan_20260804_builtin',
    trainingDate: '2026-08-04',
    title: '跑步机持续快走',
    summary: '保持稳定、可对话的快走强度。',
    estimatedDurationSeconds: 2100,
    safetyNoticeCodes: ['LOWER_INCLINE_ON_DISCOMFORT', 'NO_RUNNING_OR_SPRINTING'],
    steps: [
      step({ id: 'step_20260804_warmup', order: 10, kind: 'timed', name: '热身慢走', durationSeconds: 300, targets: { speedKph: { min: 4, max: 4.5 }, inclinePercent: { min: 0, max: 0 } } }),
      step({ id: 'step_20260804_brisk', order: 20, kind: 'timed', name: '持续快走', durationSeconds: 1200, targets: { speedKph: { min: 4.8, max: 5.8 }, inclinePercent: { min: 1, max: 2 } } }),
      step({ id: 'step_20260804_faster', order: 30, kind: 'timed', name: '稍快阶段', description: '保持原速度或小幅提高坡度，体感不超过六成。', durationSeconds: 300, targets: { inclinePercent: { min: 2, max: 3 } } }),
      step({ id: 'step_20260804_cooldown', order: 40, kind: 'timed', name: '冷身慢走', durationSeconds: 300 })
    ]
  }),
  plan({
    id: 'plan_20260805_builtin',
    trainingDate: '2026-08-05',
    title: '恢复与活动',
    summary: '以轻松活动和舒展为主。',
    estimatedDurationSeconds: 1680,
    safetyNoticeCodes: ['RECOVERY_DAY', 'STOP_ON_ALARM_SYMPTOMS'],
    steps: [
      step({ id: 'step_20260805_walk', order: 10, kind: 'timed', name: '轻松步行', durationSeconds: 1200, targets: { speedKph: { min: 4, max: 4.8 }, inclinePercent: { min: 0, max: 0 } } }),
      step({ id: 'step_20260805_calf_left', order: 20, kind: 'timed', name: '左侧小腿拉伸', durationSeconds: 30 }),
      step({ id: 'step_20260805_calf_right', order: 30, kind: 'timed', name: '右侧小腿拉伸', durationSeconds: 30 }),
      step({ id: 'step_20260805_hamstring_left', order: 40, kind: 'timed', name: '左侧大腿后侧拉伸', durationSeconds: 30 }),
      step({ id: 'step_20260805_hamstring_right', order: 50, kind: 'timed', name: '右侧大腿后侧拉伸', durationSeconds: 30 }),
      step({ id: 'step_20260805_shoulder_circle', order: 60, kind: 'manual', name: '肩部向后绕环', sets: 1, reps: 10 }),
      step({ id: 'step_20260805_hip_mobility', order: 70, kind: 'manual', name: '髋关节活动', description: '左右各完成十次。', sets: 2, reps: 10 })
    ]
  }),
  plan({
    id: 'plan_20260806_builtin',
    trainingDate: '2026-08-06',
    title: '划船入门与基础力量',
    summary: '低阻力练习划船顺序，并完成基础力量动作。',
    estimatedDurationSeconds: 2280,
    safetyNoticeCodes: ['ROW_LOW_RESISTANCE', 'STOP_ON_ALARM_SYMPTOMS'],
    steps: [
      step({ id: 'step_20260806_warmup', order: 10, kind: 'timed', name: '跑步机热身', durationSeconds: 300, targets: { speedKph: { min: 4, max: 4.5 } } }),
      step({ id: 'step_20260806_row_interval', order: 20, kind: 'interval', name: '划船练习', description: '腿部发力、身体轻微后仰，再将手柄拉向下胸。', durationSeconds: 60, sets: 5, restSeconds: 30, targets: { resistance: null, cadenceSpm: { min: 18, max: 22 } } }),
      step({ id: 'step_20260806_chest_press', order: 30, kind: 'strength', name: '综合训练器推胸', sets: 2, reps: 12, restSeconds: 75 }),
      step({ id: 'step_20260806_lat_pull', order: 40, kind: 'strength', name: '高位下拉或坐姿拉背', sets: 2, reps: 12, restSeconds: 75 }),
      step({ id: 'step_20260806_sit_to_stand', order: 50, kind: 'strength', name: '坐凳起立', sets: 2, reps: 10, restSeconds: 60 }),
      step({ id: 'step_20260806_back_extension', order: 60, kind: 'strength', name: '罗马椅挺身', description: '抬到身体成直线，不反弓腰；不适时跳过。', sets: 2, reps: 8, restSeconds: 60, optional: true }),
      step({ id: 'step_20260806_cooldown', order: 70, kind: 'timed', name: '慢走恢复', durationSeconds: 300 })
    ]
  }),
  plan({
    id: 'plan_20260807_builtin',
    trainingDate: '2026-08-07',
    title: '混合有氧',
    summary: '结合快走与短时划船，保持中等强度。',
    estimatedDurationSeconds: 2160,
    safetyNoticeCodes: ['SKIP_ROWING_ON_SORE_BACK', 'STAY_HYDRATED'],
    steps: [
      step({ id: 'step_20260807_warmup', order: 10, kind: 'timed', name: '跑步机热身', durationSeconds: 300 }),
      step({ id: 'step_20260807_incline_walk', order: 20, kind: 'timed', name: '坡度快走', durationSeconds: 900, targets: { speedKph: { min: 4.8, max: 5.6 }, inclinePercent: { min: 1, max: 3 } } }),
      step({ id: 'step_20260807_row', order: 30, kind: 'timed', name: '划船机', description: '保持低到中等强度。', durationSeconds: 480 }),
      step({ id: 'step_20260807_easy_walk', order: 40, kind: 'timed', name: '跑步机轻松走', durationSeconds: 300 }),
      step({ id: 'step_20260807_stretch', order: 50, kind: 'timed', name: '整理拉伸', durationSeconds: 180 })
    ]
  }),
  plan({
    id: 'plan_20260808_builtin',
    trainingDate: '2026-08-08',
    title: '户外步行',
    summary: '轻松步行并根据状态适度延长。',
    estimatedDurationSeconds: 2700,
    recommendedEndLocalTime: null,
    safetyNoticeCodes: ['EASY_OUTDOOR_WALK', 'STAY_HYDRATED'],
    steps: [
      step({ id: 'step_20260808_outdoor_walk', order: 10, kind: 'timed', name: '户外步行', description: '不追求配速，主要目标是增加活动量和放松。', durationSeconds: 2700, targets: { durationSeconds: { min: 2700, max: 3600 } } })
    ]
  }),
  plan({
    id: 'plan_20260809_builtin',
    trainingDate: '2026-08-09',
    title: '完全休息',
    summary: '不补练，保证睡眠并注意补水。',
    estimatedDurationSeconds: 0,
    recommendedEndLocalTime: null,
    safetyNoticeCodes: ['REST_NO_CATCH_UP', 'STAY_HYDRATED'],
    steps: [
      step({ id: 'step_20260809_rest', order: 10, kind: 'rest_day', name: '休息与日常活动', description: '保持正常生活活动，不安排正式训练。' })
    ]
  })
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

module.exports = {
  DEFAULT_PLAN_TEMPLATE: deepFreeze(DEFAULT_PLAN_TEMPLATE),
  DEFAULT_PLAN_TEMPLATE_VERSION
};
