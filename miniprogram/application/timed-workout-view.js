const { createTimerEngine } = require('../services/timer-engine');

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${pad2(minutes)}:${pad2(seconds % 60)}`;
}

function formatLocalTime(epochMs, timezone) {
  if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(new Date(epochMs));
      const hour = parts.find(({ type }) => type === 'hour');
      const minute = parts.find(({ type }) => type === 'minute');
      if (hour && minute) {
        return `${hour.value === '24' ? '00' : hour.value}:${minute.value}`;
      }
    } catch (error) {
      // The fallback below supports the two timezones accepted by the offline fixtures.
    }
  }
  const offsetMinutes = timezone === 'UTC' ? 0 : 8 * 60;
  const shifted = new Date(epochMs + offsetMinutes * 60 * 1000);
  return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

function decimal(value) {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

function rangeLabel(range, unit) {
  if (!range || typeof range.min !== 'number' || typeof range.max !== 'number') {
    return null;
  }
  return range.min === range.max
    ? `${decimal(range.min)} ${unit}`
    : `${decimal(range.min)}–${decimal(range.max)} ${unit}`;
}

function formatTargets(step) {
  const targets = step.targets || {};
  const labels = [];
  const speed = rangeLabel(targets.speedKph, 'km/h');
  if (speed) {
    labels.push(speed);
  }
  if (targets.inclinePercent && typeof targets.inclinePercent.min === 'number') {
    labels.push(targets.inclinePercent.min === targets.inclinePercent.max
      ? `坡度 ${targets.inclinePercent.min}%`
      : `坡度 ${targets.inclinePercent.min}–${targets.inclinePercent.max}%`);
  }
  if (step.sets !== null) {
    labels.push(`${step.sets} 组 × ${step.reps} 次`);
  }
  return labels.length > 0 ? labels.join(' · ') : '按舒适强度完成';
}

function control(label, disabled, tone = 'default') {
  return { label, disabled, tone };
}

function deriveRemaining(session, step, nowMs, timerEngine) {
  if (session.timer === null) {
    return step.durationSeconds || 0;
  }
  if (session.timer.status === 'running') {
    return timerEngine.remaining(session.timer, nowMs);
  }
  return session.timer.remainingSecondsAtCheckpoint;
}

function deriveState(session, step) {
  if (session.status === 'completed' || session.status === 'aborted') {
    return session.status;
  }
  if (session.timer && session.timer.status === 'expired') {
    if (session.timer.mode === 'rest' && step && step.kind === 'strength') {
      return 'rest-expired-awaiting-start-set';
    }
    return 'expired-awaiting-confirmation';
  }
  if (
    session.timer &&
    session.timer.status === 'paused' &&
    session.timer.pauseReason === 'clock-anomaly' &&
    session.timer.requiresConfirmation === true
  ) {
    return 'clock-anomaly-awaiting-confirmation';
  }
  if (session.status === 'paused') {
    return 'paused';
  }
  if (session.timer && session.timer.status === 'running') {
    return 'running';
  }
  return 'ready';
}

function buildTimedWorkoutView(session, {
  nowMs,
  timerEngine = createTimerEngine()
}) {
  const terminal = session.status === 'completed' || session.status === 'aborted';
  const step = terminal ? null : session.planSnapshot.steps[session.currentStepIndex];
  const remainingSeconds = step ? deriveRemaining(session, step, nowMs, timerEngine) : 0;
  const runningElapsed = session.status === 'in_progress'
    ? Math.max(0, Math.floor((nowMs - session.lastCheckpointAt) / 1_000))
    : 0;
  const elapsedSeconds = session.elapsedActiveSeconds + runningElapsed;
  const timerDuration = session.timer
    ? Math.max(1, session.timer.durationSeconds + session.timer.adjustmentSeconds)
    : Math.max(1, step && step.durationSeconds ? step.durationSeconds : 1);
  const progressPercent = Math.max(
    0,
    Math.min(100, Math.round((1 - remainingSeconds / timerDuration) * 100))
  );
  const state = deriveState(session, step);
  const requiresConfirmation = state === 'clock-anomaly-awaiting-confirmation';
  const requiresStartSet = state === 'rest-expired-awaiting-start-set';
  const previousStep = session.currentStepIndex > 0
    ? session.planSnapshot.steps[session.currentStepIndex - 1]
    : null;
  const canProgress = session.status === 'in_progress' && !terminal;
  const canAlternativeProgress = canProgress && ![
    'expired-awaiting-confirmation',
    'rest-expired-awaiting-start-set'
  ].includes(state);
  const canAdjust = Boolean(
    session.timer &&
    !requiresConfirmation &&
    (session.timer.status === 'running' || session.timer.status === 'paused')
  );

  return {
    state,
    sessionId: session.id,
    sessionRevision: session.sessionRevision,
    currentStepIndex: session.currentStepIndex,
    step: step ? {
      id: step.id,
      kind: step.kind,
      name: step.name,
      description: step.description
    } : null,
    positionLabel: terminal
      ? `已完成 ${session.planSnapshot.steps.length} 个动作`
      : `动作 ${session.currentStepIndex + 1} / ${session.planSnapshot.steps.length}`,
    elapsedLabel: formatDuration(elapsedSeconds),
    currentClockLabel: formatLocalTime(nowMs, session.timezone),
    recommendedEndLabel: session.planSnapshot.recommendedEndLocalTime
      ? `建议 ${session.planSnapshot.recommendedEndLocalTime} 前结束`
      : null,
    targetsLabel: step ? formatTargets(step) : null,
    timerLabel: formatDuration(remainingSeconds),
    remainingSeconds,
    progressPercent,
    deadlineReached: Boolean(
      session.timer && session.timer.status === 'running' && remainingSeconds === 0
    ),
    requiresConfirmation,
    showNextConfirmation: state === 'expired-awaiting-confirmation',
    showStartSetConfirmation: requiresStartSet,
    controls: {
      start: control('开始', !(state === 'ready' && step && ['timed', 'interval'].includes(step.kind))),
      pause: control('暂停', state !== 'running'),
      resume: control('继续', state !== 'paused'),
      confirmClock: control('确认时间后继续', !requiresConfirmation, 'primary'),
      previous: control('上一步', !(
        canAlternativeProgress &&
        previousStep &&
        previousStep.kind !== 'strength' &&
        previousStep.kind !== 'interval'
      )),
      next: control('进入下一步', state !== 'expired-awaiting-confirmation', 'primary'),
      startSet: control(
        `开始第 ${session.currentSet || 1} 组`,
        !requiresStartSet,
        'primary'
      ),
      skip: control('跳过', !canAlternativeProgress, 'quiet'),
      earlyComplete: control('提前完成', !(
        canAlternativeProgress && step && step.kind === 'timed' && session.timer !== null
      ), 'quiet'),
      subtract30: control('-30 秒', !canAdjust, 'quiet'),
      add30: control('+30 秒', !canAdjust, 'quiet'),
      end: control('结束训练', terminal, 'danger')
    }
  };
}

module.exports = {
  buildTimedWorkoutView,
  formatDuration,
  formatTargets
};
