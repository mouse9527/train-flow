const KIND_OPTIONS = Object.freeze([
  { value: null, label: '全部类型' },
  { value: 'manual', label: '次数' },
  { value: 'timed', label: '计时' },
  { value: 'interval', label: '间歇' },
  { value: 'strength', label: '力量' }
]);
const PAIN_FIELDS = Object.freeze([
  'knee',
  'lowerBack',
  'ankleOrToe',
  'dizziness'
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formatDuration(totalSeconds) {
  const seconds = Number.isSafeInteger(totalSeconds) && totalSeconds >= 0
    ? totalSeconds
    : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function statusLabel(status) {
  if (status === 'completed') return '已完成';
  if (status === 'skipped') return '已跳过';
  return '未执行';
}

function recordStatusLabel(status) {
  return status === 'completed' ? '已完成' : '已中止';
}

function kindLabel(kind) {
  const option = KIND_OPTIONS.find(({ value }) => value === kind);
  return option ? option.label : kind;
}

function canonicalPain(pain = {}) {
  return Object.fromEntries(
    PAIN_FIELDS.map((field) => [field, pain[field] === true])
  );
}

function feedbackView(feedback) {
  return feedback
    ? {
      rpe: feedback.rpe,
      weightBeforeKg: feedback.weightBeforeKg,
      weightBeforeLabel: feedback.weightBeforeKg === null
        ? '未填'
        : `${feedback.weightBeforeKg} kg`,
      pain: canonicalPain(feedback.pain),
      note: feedback.note
    }
    : {
      rpe: null,
      weightBeforeKg: null,
      weightBeforeLabel: '未填',
      pain: canonicalPain(),
      note: ''
    };
}

function actualLabel(step, result) {
  if (result.status !== 'completed') {
    return '未记录';
  }
  if (step.kind === 'manual') {
    return result.actualReps === null || result.actualReps === undefined
      ? '未记录'
      : `${result.actualReps} 次`;
  }
  if (step.kind === 'timed' || step.kind === 'interval') {
    return result.actualDurationSeconds === null || result.actualDurationSeconds === undefined
      ? '未记录'
      : `${result.actualDurationSeconds} 秒`;
  }
  if (step.kind === 'strength') {
    return result.setResults.length === 0
      ? '未记录'
      : `${result.setResults.length} 组`;
  }
  return '未记录';
}

function mapStep(step, result) {
  const safeResult = result || {
    stepId: step.id,
    status: 'unknown',
    setResults: []
  };
  return {
    stepId: step.id,
    order: step.order,
    name: step.name,
    kind: step.kind,
    kindLabel: kindLabel(step.kind),
    status: safeResult.status,
    statusLabel: statusLabel(safeResult.status),
    actualLabel: actualLabel(step, safeResult),
    editable: safeResult.status === 'completed',
    actualReps: safeResult.actualReps === undefined ? null : safeResult.actualReps,
    actualDurationSeconds: safeResult.actualDurationSeconds === undefined
      ? null
      : safeResult.actualDurationSeconds,
    sets: clone(safeResult.setResults || []).map((setResult) => ({
      setNumber: setResult.setNumber,
      reps: setResult.reps,
      weightKg: setResult.weightKg
    }))
  };
}

function mapDetail(record) {
  const resultByStepId = new Map(
    record.stepResults.map((result) => [result.stepId, result])
  );
  return {
    id: record.id,
    revision: record.revision,
    trainingDate: record.trainingDate,
    title: record.planSnapshot.title,
    status: record.status,
    statusLabel: recordStatusLabel(record.status),
    durationLabel: formatDuration(record.elapsedActiveSeconds),
    feedbackMissing: record.feedback === null,
    feedback: feedbackView(record.feedback),
    steps: record.planSnapshot.steps
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((step) => mapStep(step, resultByStepId.get(step.id)))
  };
}

function mapListRecord(record, selectedRecordId) {
  const counts = { completed: 0, skipped: 0, unknown: 0 };
  for (const result of record.stepResults) {
    const status = ['completed', 'skipped'].includes(result.status)
      ? result.status
      : 'unknown';
    counts[status] += 1;
  }
  const kinds = [...new Set(record.planSnapshot.steps.map(({ kind }) => kind))];
  const feedback = feedbackView(record.feedback);
  return {
    id: record.id,
    trainingDate: record.trainingDate,
    title: record.planSnapshot.title,
    statusLabel: recordStatusLabel(record.status),
    progressLabel: `${counts.completed} 完成 · ${counts.skipped} 跳过 · ${counts.unknown} 未执行`,
    durationLabel: formatDuration(record.elapsedActiveSeconds),
    kindLabel: kinds.map(kindLabel).join(' / '),
    hasPain: Object.values(feedback.pain).some(Boolean),
    selected: record.id === selectedRecordId
  };
}

function parseNullableNumber(value) {
  if (value === '' || value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

function feedbackDraftIsEmpty(feedback) {
  if (!feedback) {
    return true;
  }
  return (
    parseNullableNumber(feedback.rpe) === null &&
    parseNullableNumber(feedback.weightBeforeKg) === null &&
    Object.values(canonicalPain(feedback.pain)).every((value) => value === false) &&
    feedback.note === ''
  );
}

function correctionForStep(step) {
  if (!step.editable || step.status !== 'completed') {
    return null;
  }
  if (step.kind === 'manual') {
    return { stepId: step.stepId, actualReps: parseNullableNumber(step.actualReps) };
  }
  if (step.kind === 'timed' || step.kind === 'interval') {
    return {
      stepId: step.stepId,
      actualDurationSeconds: parseNullableNumber(step.actualDurationSeconds)
    };
  }
  if (step.kind === 'strength') {
    return {
      stepId: step.stepId,
      setCorrections: step.sets.map((setResult) => ({
        setNumber: setResult.setNumber,
        reps: parseNullableNumber(setResult.reps),
        weightKg: parseNullableNumber(setResult.weightKg)
      }))
    };
  }
  return null;
}

class RecordApplicationService {
  constructor({ repository }) {
    if (
      !repository ||
      typeof repository.list !== 'function' ||
      typeof repository.findById !== 'function' ||
      typeof repository.correct !== 'function' ||
      typeof repository.delete !== 'function'
    ) {
      throw new Error('RecordApplicationService requires a TrainingRecordRepository');
    }
    this.repository = repository;
  }

  getView({ trainingDate = null, kind = null, selectedRecordId = null } = {}) {
    const records = this.repository.list({ trainingDate, kind });
    const selectedId = records.some(({ id }) => id === selectedRecordId)
      ? selectedRecordId
      : records[0] ? records[0].id : null;
    const selectedRecord = selectedId
      ? records.find(({ id }) => id === selectedId) || null
      : null;
    return {
      filters: { trainingDate, kind },
      kindOptions: clone(KIND_OPTIONS),
      records: records.map((record) => mapListRecord(record, selectedId)),
      selectedRecord: selectedRecord ? mapDetail(selectedRecord) : null,
      emptyState: records.length === 0
        ? {
          title: '还没有训练记录',
          guidance: trainingDate || kind
            ? '调整日期或训练类型，查看其他记录'
            : '完成一次训练后，真实结果会显示在这里'
        }
        : null
    };
  }

  createEditDraft(record) {
    const detail = record.steps ? record : mapDetail(record);
    return {
      steps: clone(detail.steps),
      feedback: clone(detail.feedback),
      feedbackMissing: detail.feedbackMissing === true
    };
  }

  correctRecord({ recordId, expectedRevision, commandKey, nowMs, draft }) {
    const actualCorrections = draft.steps
      .map(correctionForStep)
      .filter(Boolean);
    const feedback = draft.feedbackMissing === true && feedbackDraftIsEmpty(draft.feedback)
      ? null
      : {
        rpe: parseNullableNumber(draft.feedback.rpe),
        weightBeforeKg: parseNullableNumber(draft.feedback.weightBeforeKg),
        pain: canonicalPain(draft.feedback.pain),
        note: draft.feedback.note
      };
    const corrected = this.repository.correct({
      recordId,
      expectedRevision,
      commandKey,
      nowMs,
      actualCorrections,
      feedback
    });
    return clone(corrected && corrected.record ? corrected.record : corrected);
  }

  deleteRecord(command) {
    const deleted = this.repository.delete(command);
    return clone(deleted && deleted.record ? deleted.record : deleted);
  }
}

function createRecordApplicationService(options) {
  return new RecordApplicationService(options);
}

function createDeveloperRecordApplicationService() {
  let records = [
    {
      id: 'record_fixture_aborted',
      sourceSessionId: 'session_fixture_aborted',
      revision: 3,
      status: 'aborted',
      trainingDate: '2026-08-03',
      startedAt: 1785717300000,
      endedAt: 1785718225000,
      elapsedActiveSeconds: 925,
      planSnapshot: {
        title: '全身基础训练',
        steps: [
          { id: 'fixture_manual', order: 10, name: '徒手深蹲', kind: 'manual' },
          { id: 'fixture_timed', order: 20, name: '平板支撑', kind: 'timed' },
          { id: 'fixture_strength', order: 30, name: '哑铃划船', kind: 'strength' }
        ]
      },
      stepResults: [
        { stepId: 'fixture_manual', status: 'completed', completedAt: 1785717800000, setResults: [], actualReps: 14 },
        { stepId: 'fixture_timed', status: 'skipped', completedAt: 1785717900000, setResults: [], actualDurationSeconds: null },
        { stepId: 'fixture_strength', status: 'unknown', completedAt: null, setResults: [] }
      ],
      feedback: {
        rpe: 7,
        weightBeforeKg: 80.5,
        pain: { knee: true, lowerBack: false, ankleOrToe: false, dizziness: false },
        note: '匿名演示：膝部有轻微不适'
      }
    },
    {
      id: 'record_fixture_completed',
      sourceSessionId: 'session_fixture_completed',
      revision: 2,
      status: 'completed',
      trainingDate: '2026-08-02',
      startedAt: 1785630900000,
      endedAt: 1785632940000,
      elapsedActiveSeconds: 2040,
      planSnapshot: {
        title: '划船间歇训练',
        steps: [{ id: 'fixture_interval', order: 10, name: '划船机间歇', kind: 'interval' }]
      },
      stepResults: [{
        stepId: 'fixture_interval',
        status: 'completed',
        completedAt: 1785632940000,
        setResults: [],
        actualDurationSeconds: 300
      }],
      feedback: {
        rpe: 6,
        weightBeforeKg: null,
        pain: { knee: false, lowerBack: false, ankleOrToe: false, dizziness: false },
        note: ''
      }
    }
  ];
  const repository = {
    list({ trainingDate, kind }) {
      return clone(records.filter((record) => (
        (trainingDate === null || record.trainingDate === trainingDate) &&
        (kind === null || record.planSnapshot.steps.some((step) => step.kind === kind))
      )));
    },
    findById(recordId) {
      return clone(records.find(({ id }) => id === recordId) || null);
    },
    correct(command) {
      const index = records.findIndex(({ id }) => id === command.recordId);
      const record = records[index];
      const correctionByStepId = new Map(
        command.actualCorrections.map((entry) => [entry.stepId, entry])
      );
      record.stepResults = record.stepResults.map((result) => {
        const correction = correctionByStepId.get(result.stepId);
        return correction ? { ...result, ...clone(correction), stepId: result.stepId } : result;
      });
      record.feedback = clone(command.feedback);
      record.revision += 1;
      return clone(record);
    },
    delete(command) {
      const index = records.findIndex(({ id }) => id === command.recordId);
      const [record] = records.splice(index, 1);
      return { ...clone(record), revision: record.revision + 1, deletedAt: command.nowMs };
    }
  };
  return createRecordApplicationService({ repository });
}

module.exports = {
  KIND_OPTIONS,
  RecordApplicationService,
  createDeveloperRecordApplicationService,
  createRecordApplicationService,
  formatDuration
};
