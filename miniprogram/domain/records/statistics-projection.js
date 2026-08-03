const PROJECTION_SCHEMA_VERSION = 1;
const MAX_TREND_POINTS = 7;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertTrainingDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date`);
  }
  return date;
}

function addDays(trainingDate, days) {
  const date = assertTrainingDate(trainingDate, 'trainingDate');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeRange(range) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new Error('statistics range must be an object');
  }
  assertTrainingDate(range.startDate, 'range.startDate');
  assertTrainingDate(range.endDate, 'range.endDate');
  if (range.startDate > range.endDate) {
    throw new Error('range.startDate must not be after range.endDate');
  }
  return { startDate: range.startDate, endDate: range.endDate };
}

function isDeletedRecord(record) {
  return Boolean(
    record && (
      record.deleted === true ||
      record.status === 'deleted' ||
      record.deletedAt !== null && record.deletedAt !== undefined ||
      record.tombstone === true ||
      record.tombstone && typeof record.tombstone === 'object'
    )
  );
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function nullableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function completedDuration(step, result) {
  if (!result || result.status !== 'completed') {
    return { seconds: 0, estimated: false };
  }
  if (Number.isSafeInteger(result.actualDurationSeconds) && result.actualDurationSeconds >= 0) {
    return { seconds: result.actualDurationSeconds, estimated: false };
  }
  if (step.kind === 'timed') {
    return { seconds: nonNegativeInteger(step.durationSeconds), estimated: true };
  }
  if (step.kind === 'interval') {
    const completedSets = Array.isArray(result.setResults) ? result.setResults.length : 0;
    return {
      seconds: nonNegativeInteger(step.durationSeconds) * completedSets,
      estimated: completedSets > 0
    };
  }
  return { seconds: 0, estimated: false };
}

function machineKind(step) {
  if (!step || !['timed', 'interval'].includes(step.kind)) {
    return null;
  }
  const targets = step.targets && typeof step.targets === 'object' ? step.targets : {};
  if (
    Object.prototype.hasOwnProperty.call(targets, 'speedKph') ||
    Object.prototype.hasOwnProperty.call(targets, 'inclinePercent')
  ) {
    return 'treadmill';
  }
  if (
    Object.prototype.hasOwnProperty.call(targets, 'cadenceSpm')
  ) {
    return 'rowing';
  }
  const name = typeof step.name === 'string' ? step.name.toLowerCase() : '';
  if (/跑步机|treadmill/.test(name)) {
    return 'treadmill';
  }
  if (/划船机|划船|rowing|rower/.test(name)) {
    return 'rowing';
  }
  return null;
}

function strengthArea(step) {
  if (!step || step.kind !== 'strength') {
    return null;
  }
  const name = typeof step.name === 'string' ? step.name.toLowerCase() : '';
  if (/推胸|胸推|卧推|chest\s*press|bench\s*press/.test(name)) {
    return 'chest';
  }
  if (/高位下拉|坐姿拉背|拉背|背部|背肌|lat\s*pull|back\s*extension|strength\s*row/.test(name)) {
    return 'back';
  }
  return null;
}

function latestSetWeight(result) {
  if (!result || result.status !== 'completed' || !Array.isArray(result.setResults)) {
    return null;
  }
  const known = result.setResults
    .filter(({ weightKg }) => nullableNumber(weightKg) !== null)
    .sort((left, right) => nonNegativeInteger(left.setNumber) - nonNegativeInteger(right.setNumber));
  return known.length === 0 ? null : known.at(-1).weightKg;
}

function recordContribution(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || isDeletedRecord(record)) {
    return null;
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error('statistics record requires a non-empty id');
  }
  assertTrainingDate(record.trainingDate, `record ${record.id} trainingDate`);
  const steps = record.planSnapshot && Array.isArray(record.planSnapshot.steps)
    ? record.planSnapshot.steps
    : [];
  const results = Array.isArray(record.stepResults) ? record.stepResults : [];
  const resultByStepId = new Map(results.map((result) => [result.stepId, result]));
  let treadmillSeconds = 0;
  let treadmillEstimated = false;
  let rowingSeconds = 0;
  let rowingEstimated = false;
  let strengthCount = 0;
  let chestWeightKg = null;
  let backWeightKg = null;

  for (const step of steps) {
    const result = resultByStepId.get(step.id) || null;
    const machine = machineKind(step);
    const duration = completedDuration(step, result);
    if (machine === 'treadmill') {
      treadmillSeconds += duration.seconds;
      treadmillEstimated = treadmillEstimated || duration.estimated;
    }
    if (machine === 'rowing') {
      rowingSeconds += duration.seconds;
      rowingEstimated = rowingEstimated || duration.estimated;
    }
    if (step.kind === 'strength' && result && result.status === 'completed') {
      strengthCount += 1;
      const area = strengthArea(step);
      const weight = latestSetWeight(result);
      if (area === 'chest' && weight !== null) chestWeightKg = weight;
      if (area === 'back' && weight !== null) backWeightKg = weight;
    }
  }

  return {
    recordId: record.id,
    recordRevision: nonNegativeInteger(record.revision),
    status: record.status,
    trainingDate: record.trainingDate,
    endedAt: nonNegativeInteger(record.endedAt),
    activeSeconds: nonNegativeInteger(record.elapsedActiveSeconds),
    treadmillSeconds,
    treadmillEstimated,
    rowingSeconds,
    rowingEstimated,
    strengthCount,
    chestWeightKg,
    backWeightKg,
    rpe: record.feedback && Number.isSafeInteger(record.feedback.rpe)
      ? record.feedback.rpe
      : null,
    weightKg: record.feedback ? nullableNumber(record.feedback.weightBeforeKg) : null
  };
}

function plannedDates(plans, range) {
  if (!Array.isArray(plans)) {
    throw new Error('statistics plans must be an array');
  }
  const dates = new Set();
  for (const plan of plans) {
    if (!plan || plan.status !== 'scheduled' || !Array.isArray(plan.steps)) {
      continue;
    }
    assertTrainingDate(plan.trainingDate, `plan ${plan.id || 'unknown'} trainingDate`);
    const isRestDay = plan.steps.length > 0 && plan.steps.every(({ kind }) => kind === 'rest_day');
    if (
      !isRestDay &&
      plan.trainingDate >= range.startDate &&
      plan.trainingDate <= range.endDate
    ) {
      dates.add(plan.trainingDate);
    }
  }
  return [...dates].sort();
}

function compareContribution(left, right) {
  const dateOrder = left.trainingDate.localeCompare(right.trainingDate);
  if (dateOrder !== 0) return dateOrder;
  const endedOrder = left.endedAt - right.endedAt;
  if (endedOrder !== 0) return endedOrder;
  return left.recordId.localeCompare(right.recordId);
}

function calculateStreak(contributions, endDate) {
  const dates = [...new Set(
    contributions
      .filter(({ status, trainingDate }) => status === 'completed' && trainingDate <= endDate)
      .map(({ trainingDate }) => trainingDate)
  )].sort().reverse();
  if (dates.length === 0) return 0;
  let streak = 1;
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] !== addDays(dates[index - 1], -1)) break;
    streak += 1;
  }
  return streak;
}

function latestKnown(contributions, field) {
  for (const contribution of [...contributions].sort(compareContribution).reverse()) {
    if (contribution[field] !== null) {
      return { valueKg: contribution[field], trainingDate: contribution.trainingDate };
    }
  }
  return null;
}

function aggregate({ range, dates, contributions, builtAt }) {
  const weekly = contributions.filter(({ trainingDate }) => (
    trainingDate >= range.startDate && trainingDate <= range.endDate
  ));
  const plannedDateSet = new Set(dates);
  const completedCount = new Set(
    weekly
      .filter(({ status, trainingDate }) => (
        status === 'completed' && plannedDateSet.has(trainingDate)
      ))
      .map(({ trainingDate }) => trainingDate)
  ).size;
  const plannedCount = dates.length;
  const eligible = contributions
    .filter(({ trainingDate }) => trainingDate <= range.endDate)
    .sort(compareContribution);
  const recent = eligible.slice(-MAX_TREND_POINTS);
  const sum = (field) => weekly.reduce((total, item) => total + item[field], 0);

  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    range: clone(range),
    builtAt,
    summary: {
      completedCount,
      plannedCount,
      completionRate: plannedCount === 0 ? null : completedCount / plannedCount,
      totalActiveSeconds: sum('activeSeconds'),
      treadmillSeconds: sum('treadmillSeconds'),
      treadmillEstimated: weekly.some(({ treadmillEstimated }) => treadmillEstimated),
      rowingSeconds: sum('rowingSeconds'),
      rowingEstimated: weekly.some(({ rowingEstimated }) => rowingEstimated),
      strengthCount: sum('strengthCount'),
      streakDays: calculateStreak(contributions, range.endDate)
    },
    latestStrength: {
      chest: latestKnown(eligible, 'chestWeightKg'),
      back: latestKnown(eligible, 'backWeightKg')
    },
    latestBodyWeight: latestKnown(eligible, 'weightKg'),
    recent: {
      duration: recent.map(({ recordId, trainingDate, activeSeconds }) => ({
        recordId,
        trainingDate,
        value: activeSeconds
      })),
      rpe: recent.map(({ recordId, trainingDate, rpe }) => ({ recordId, trainingDate, value: rpe })),
      weight: recent.map(({ recordId, trainingDate, weightKg }) => ({
        recordId,
        trainingDate,
        value: weightKg
      }))
    },
    _plannedDates: clone(dates),
    _recordContributions: clone(contributions).sort(compareContribution)
  };
}

function rebuildStatisticsProjection(records, plans, range, builtAt) {
  if (!Array.isArray(records)) {
    throw new Error('statistics records must be an array');
  }
  const normalizedRange = normalizeRange(range);
  if (!Number.isSafeInteger(builtAt) || builtAt < 0) {
    throw new Error('statistics builtAt must be a non-negative epoch millisecond integer');
  }
  const contributions = records.map(recordContribution).filter(Boolean);
  const ids = contributions.map(({ recordId }) => recordId);
  if (new Set(ids).size !== ids.length) {
    throw new Error('statistics records must use unique ids');
  }
  return aggregate({
    range: normalizedRange,
    dates: plannedDates(plans, normalizedRange),
    contributions,
    builtAt
  });
}

function applyStatisticsRecordChanged(projection, beforeRecord, afterRecord, builtAt) {
  if (
    !projection ||
    projection.schemaVersion !== PROJECTION_SCHEMA_VERSION ||
    !Array.isArray(projection._plannedDates) ||
    !Array.isArray(projection._recordContributions)
  ) {
    throw new Error('statistics projection cannot be incrementally updated; rebuild is required');
  }
  const beforeId = beforeRecord && beforeRecord.id;
  const afterId = afterRecord && afterRecord.id;
  if (!beforeId && !afterId) {
    throw new Error('statistics record change requires a before or after record');
  }
  if (beforeId && afterId && beforeId !== afterId) {
    throw new Error('statistics record change cannot replace a different record identity');
  }
  const recordId = beforeId || afterId;
  const current = projection._recordContributions.filter((item) => item.recordId !== recordId);
  const next = recordContribution(afterRecord);
  if (next) current.push(next);
  return aggregate({
    range: normalizeRange(projection.range),
    dates: clone(projection._plannedDates),
    contributions: current,
    builtAt
  });
}

function publicStatisticsProjection(projection) {
  const copy = clone(projection);
  delete copy._plannedDates;
  delete copy._recordContributions;
  delete copy.databaseRevision;
  delete copy.projectionFingerprint;
  delete copy.sourceFingerprint;
  return copy;
}

module.exports = {
  PROJECTION_SCHEMA_VERSION,
  applyStatisticsRecordChanged,
  publicStatisticsProjection,
  rebuildStatisticsProjection
};
