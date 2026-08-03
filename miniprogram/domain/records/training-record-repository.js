const { computeChecksum } = require('../../utils/checksum');
const {
  createBaselineTrainingRecord,
  recordMatchesTerminalSource,
  terminalFactFingerprint,
  terminalSourceFromRecord
} = require('../execution/training-record');
const {
  applyTrainingRecordCorrection,
  buildEffectiveTrainingRecord,
  isDeletedTrainingRecord
} = require('./training-record');

const CORRECTION_COMMAND_FIELDS = Object.freeze([
  'recordId',
  'expectedRevision',
  'commandKey',
  'nowMs',
  'actualCorrections',
  'feedback'
]);
const DELETE_COMMAND_FIELDS = Object.freeze([
  'recordId',
  'expectedRevision',
  'commandKey',
  'nowMs'
]);
const TOMBSTONE_FIELDS = Object.freeze([
  'id',
  'sourceSessionId',
  'sourceSessionFingerprint',
  'status',
  'trainingDate',
  'createdAt',
  'updatedAt',
  'revision',
  'deletedAt',
  'processedDeletionCommands'
]);
const RECEIPT_FIELDS = Object.freeze(['key', 'fingerprint', 'resultRevision']);
const QUERY_FIELDS = Object.freeze(['trainingDate', 'kind']);
const QUERY_KINDS = Object.freeze(['manual', 'timed', 'interval', 'strength']);

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function assertInertJson(value, path = 'value', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${path} must contain canonical finite JSON numbers`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} contains a non-JSON ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} cannot contain symbol fields`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${path} must be a plain JSON array`);
    }
    const extraField = Object.getOwnPropertyNames(value).find(
      (field) => field !== 'length' && !/^(0|[1-9]\d*)$/.test(field)
    );
    if (extraField) {
      throw new TypeError(`${path} contains unknown array field ${extraField}`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, index)) {
        throw new TypeError(`${path}[${index}] is a sparse JSON array entry`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor.enumerable || !hasOwn(descriptor, 'value') || descriptor.value === undefined) {
        throw new TypeError(`${path}[${index}] must be an enumerable JSON data field`);
      }
      assertInertJson(descriptor.value, `${path}[${index}]`, ancestors);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${path} must be a plain JSON object without a custom prototype`);
    }
    for (const field of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor.enumerable || !hasOwn(descriptor, 'value') || descriptor.value === undefined) {
        throw new TypeError(`${path}.${field} must be an enumerable JSON data field`);
      }
      assertInertJson(descriptor.value, `${path}.${field}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function cloneJson(value) {
  assertInertJson(value);
  return JSON.parse(JSON.stringify(value));
}

function assertDatabase(database) {
  if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
    throw new Error('TrainingRecordRepository requires a LocalDatabase');
  }
}

function canonicalSourceSessionId(recordId) {
  if (
    typeof recordId !== 'string' ||
    !recordId.startsWith('record_') ||
    recordId.length === 'record_'.length
  ) {
    throw new TypeError('TrainingRecord correction requires a canonical recordId');
  }
  return recordId.slice('record_'.length);
}

function assertClosedCommand(command, fields) {
  assertInertJson(command, 'command');
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('command must be an object');
  }
  const allowed = new Set(fields);
  for (const field of Object.getOwnPropertyNames(command)) {
    if (!allowed.has(field)) {
      throw new TypeError(`command contains unknown field ${field}`);
    }
  }
  for (const field of fields) {
    if (!hasOwn(command, field)) {
      throw new TypeError(`command requires own field ${field}`);
    }
  }
  canonicalSourceSessionId(command.recordId);
  return cloneJson(command);
}

function assertCorrectionCommand(command) {
  return assertClosedCommand(command, CORRECTION_COMMAND_FIELDS);
}

function assertDeleteCommand(command) {
  const normalized = assertClosedCommand(command, DELETE_COMMAND_FIELDS);
  if (
    !Number.isSafeInteger(normalized.expectedRevision) ||
    normalized.expectedRevision < 1 ||
    !Number.isSafeInteger(normalized.nowMs) ||
    normalized.nowMs < 0 ||
    typeof normalized.commandKey !== 'string' ||
    normalized.commandKey.trim().length === 0
  ) {
    throw new TypeError('TrainingRecord delete command fields are invalid');
  }
  return normalized;
}

function aggregateCommand(command) {
  return {
    expectedRevision: command.expectedRevision,
    commandKey: command.commandKey,
    nowMs: command.nowMs,
    actualCorrections: command.actualCorrections,
    feedback: command.feedback
  };
}

function findCanonicalRecord(records, recordId) {
  if (!Array.isArray(records)) {
    throw new Error('AppDatabase records must be an array');
  }
  const sourceSessionId = canonicalSourceSessionId(recordId);
  const candidates = records.filter((record) => record && (
    record.id === recordId || record.sourceSessionId === sourceSessionId
  ));
  if (candidates.length === 0) {
    throw new Error(`TrainingRecord ${recordId} was not found`);
  }
  if (candidates.length !== 1) {
    throw new Error(`TrainingRecord ${recordId} has conflicting identity candidates`);
  }
  const record = candidates[0];
  if (record.id !== recordId || record.sourceSessionId !== sourceSessionId) {
    throw new Error(`TrainingRecord ${recordId} canonical identity is invalid`);
  }
  return record;
}

function outboxDescriptor(command, record, kind = 'training-record.corrected') {
  return {
    opId: `op_${computeChecksum({
      kind,
      entityId: record.id,
      entityRevision: record.revision,
      commandKey: command.commandKey
    })}`,
    kind,
    entityType: 'training-record',
    entityId: record.id,
    entityRevision: record.revision,
    occurredAt: command.nowMs
  };
}

function deleteFingerprint(command) {
  return computeChecksum({
    recordId: command.recordId,
    expectedRevision: command.expectedRevision,
    commandKey: command.commandKey,
    nowMs: command.nowMs
  });
}

function hasExactFields(value, fields) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => hasOwn(value, field))
  );
}

function assertTombstone(record) {
  assertInertJson(record, 'TrainingRecord tombstone');
  if (
    !hasExactFields(record, TOMBSTONE_FIELDS) ||
    record.id !== `record_${record.sourceSessionId}` ||
    typeof record.sourceSessionFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.sourceSessionFingerprint) ||
    !['completed', 'aborted'].includes(record.status) ||
    !isRealDate(record.trainingDate) ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < record.createdAt ||
    !Number.isSafeInteger(record.deletedAt) ||
    record.deletedAt !== record.updatedAt ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 2 ||
    !Array.isArray(record.processedDeletionCommands) ||
    record.processedDeletionCommands.length !== 1
  ) {
    throw new Error('TrainingRecord tombstone is invalid');
  }
  const receipt = record.processedDeletionCommands[0];
  if (
    !hasExactFields(receipt, RECEIPT_FIELDS) ||
    typeof receipt.key !== 'string' ||
    receipt.key.length === 0 ||
    !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
    receipt.resultRevision !== record.revision
  ) {
    throw new Error('TrainingRecord deletion receipt is invalid');
  }
  return record;
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeQuery(query) {
  assertInertJson(query, 'TrainingRecord query');
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError('TrainingRecord query must be a plain object');
  }
  for (const field of Object.getOwnPropertyNames(query)) {
    if (!QUERY_FIELDS.includes(field)) {
      throw new TypeError(`TrainingRecord query contains unknown field ${field}`);
    }
  }
  const trainingDate = hasOwn(query, 'trainingDate') ? query.trainingDate : null;
  const kind = hasOwn(query, 'kind') ? query.kind : null;
  if (trainingDate !== null && !isRealDate(trainingDate)) {
    throw new TypeError('TrainingRecord query trainingDate must be a real YYYY-MM-DD date');
  }
  if (kind !== null && !QUERY_KINDS.includes(kind)) {
    throw new TypeError('TrainingRecord query kind is unsupported');
  }
  return { trainingDate, kind };
}

function validateAllRecords(records) {
  assertInertJson(records, 'AppDatabase records');
  if (!Array.isArray(records)) {
    throw new Error('AppDatabase records must be an array');
  }
  const ids = new Set();
  const sourceSessionIds = new Set();
  return records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('AppDatabase contains an invalid TrainingRecord entry');
    }
    if (
      typeof record.id !== 'string' ||
      typeof record.sourceSessionId !== 'string' ||
      record.id !== `record_${record.sourceSessionId}` ||
      ids.has(record.id) ||
      sourceSessionIds.has(record.sourceSessionId)
    ) {
      throw new Error('AppDatabase contains conflicting TrainingRecord identity');
    }
    ids.add(record.id);
    sourceSessionIds.add(record.sourceSessionId);

    if (isDeletedTrainingRecord(record)) {
      assertTombstone(record);
      return { record, effective: null, deleted: true };
    }

    let source;
    try {
      source = terminalSourceFromRecord(record);
    } catch (_error) {
      throw new Error(`TrainingRecord ${record.id} source facts are invalid`);
    }
    if (!recordMatchesTerminalSource(record, source)) {
      throw new Error(`TrainingRecord ${record.id} failed terminal source validation`);
    }
    if (!isRealDate(record.trainingDate)) {
      throw new Error(`TrainingRecord ${record.id} has an invalid trainingDate`);
    }
    return {
      record,
      effective: buildEffectiveTrainingRecord(record),
      deleted: false
    };
  });
}

function compareEffectiveRecords(left, right) {
  const dateOrder = right.trainingDate.localeCompare(left.trainingDate);
  if (dateOrder !== 0) {
    return dateOrder;
  }
  const endedAtOrder = right.endedAt - left.endedAt;
  if (endedAtOrder !== 0) {
    return endedAtOrder;
  }
  return left.id.localeCompare(right.id);
}

function buildTombstone(record, command) {
  buildEffectiveTrainingRecord(record);
  if (command.expectedRevision !== record.revision) {
    throw new Error('TrainingRecord delete revision is stale');
  }
  if (command.nowMs < record.updatedAt) {
    throw new Error('TrainingRecord delete time is before its current revision');
  }
  const nextRevision = record.revision + 1;
  const sourceSessionFingerprint = hasOwn(record, 'sourceSessionFingerprint')
    ? record.sourceSessionFingerprint
    : terminalFactFingerprint(record);
  return {
    id: record.id,
    sourceSessionId: record.sourceSessionId,
    sourceSessionFingerprint,
    status: record.status,
    trainingDate: record.trainingDate,
    createdAt: record.createdAt,
    updatedAt: command.nowMs,
    revision: nextRevision,
    deletedAt: command.nowMs,
    processedDeletionCommands: [{
      key: command.commandKey,
      fingerprint: deleteFingerprint(command),
      resultRevision: nextRevision
    }]
  };
}

function replayDeletedRecord(record, command) {
  assertTombstone(record);
  const receipt = record.processedDeletionCommands.find(
    ({ key }) => key === command.commandKey
  );
  if (!receipt) {
    throw new Error('TrainingRecord is already deleted');
  }
  if (receipt.fingerprint !== deleteFingerprint(command)) {
    throw new Error('TrainingRecord deletion command key conflicts with prior intent');
  }
  return cloneJson(record);
}

function prepareCurrentRecord(current, source) {
  if (!source || hasOwn(current, 'sourceSessionFingerprint')) {
    return current;
  }
  if (!recordMatchesTerminalSource(current, source)) {
    throw new Error('TrainingRecord source does not match the requested correction');
  }
  return {
    ...cloneJson(current),
    sourceSessionFingerprint: terminalFactFingerprint(source)
  };
}

function materializationCorrection(command, source) {
  const baseline = createBaselineTrainingRecord(source);
  if (baseline.id !== command.recordId || command.expectedRevision !== 0) {
    throw new Error('TrainingRecord materialization identity or revision is stale');
  }
  if (command.actualCorrections.length !== 0) {
    throw new Error('TrainingRecord materialization cannot invent actual corrections');
  }
  const validated = applyTrainingRecordCorrection(baseline, {
    ...aggregateCommand(command),
    expectedRevision: baseline.revision
  });
  const fingerprint = computeChecksum({
    expectedRevision: command.expectedRevision,
    commandKey: command.commandKey,
    nowMs: command.nowMs,
    actualCorrections: validated.actualCorrections,
    feedback: validated.feedback
  });
  return {
    fingerprint,
    record: {
      ...cloneJson(baseline),
      actualCorrections: cloneJson(validated.actualCorrections),
      feedback: cloneJson(validated.feedback),
      processedCorrectionCommands: [{
        key: command.commandKey,
        fingerprint,
        resultRevision: baseline.revision
      }],
      updatedAt: command.nowMs
    }
  };
}

function materializeCorrection(command, source) {
  return materializationCorrection(command, source).record;
}

function replayMaterializationCorrection(record, command, source) {
  buildEffectiveTrainingRecord(record);
  const terminalSource = terminalSourceFromRecord(record);
  if (source && !recordMatchesTerminalSource(record, source)) {
    throw new Error('TrainingRecord source does not match the replayed materialization');
  }
  const { fingerprint } = materializationCorrection(command, terminalSource);
  const receipts = hasOwn(record, 'processedCorrectionCommands')
    ? record.processedCorrectionCommands
    : [];
  const receipt = receipts.find(({ key }) => key === command.commandKey);
  if (!receipt) {
    throw new Error('TrainingRecord materialization correction revision is stale');
  }
  if (receipt.fingerprint !== fingerprint) {
    throw new Error('TrainingRecord correction command key conflicts with prior intent');
  }
  return cloneJson(record);
}

function statisticsInvalidation(command, record) {
  return {
    dirty: true,
    reason: 'training-record-changed',
    recordId: record.id,
    recordRevision: record.revision,
    invalidatedAt: command.nowMs
  };
}

class TrainingRecordRepository {
  constructor({ database }) {
    assertDatabase(database);
    this.database = database;
  }

  correct(sourceCommand, { source = null } = {}) {
    const command = assertCorrectionCommand(sourceCommand);
    const snapshot = this.database.load();
    let current = null;
    try {
      current = findCanonicalRecord(snapshot.records, command.recordId);
    } catch (error) {
      if (!source || !/was not found/.test(error.message)) {
        throw error;
      }
    }
    if (current && isDeletedTrainingRecord(current)) {
      throw new Error('TrainingRecord is deleted and cannot be corrected');
    }
    if (current && command.expectedRevision === 0) {
      return replayMaterializationCorrection(current, command, source);
    }
    const preview = current
      ? applyTrainingRecordCorrection(
        prepareCurrentRecord(current, source),
        aggregateCommand(command)
      )
      : materializeCorrection(command, source);
    if (current && preview.revision === current.revision) {
      return cloneJson(preview);
    }

    this.database.commit((draft) => {
      let corrected;
      if (current === null) {
        const conflicting = draft.records.filter((record) => record && (
          record.id === command.recordId ||
          record.sourceSessionId === canonicalSourceSessionId(command.recordId)
        ));
        if (conflicting.length !== 0) {
          throw new Error('TrainingRecord materialization identity changed concurrently');
        }
        corrected = materializeCorrection(command, source);
        draft.records.push(cloneJson(corrected));
      } else {
        const persisted = findCanonicalRecord(draft.records, command.recordId);
        if (isDeletedTrainingRecord(persisted)) {
          throw new Error('TrainingRecord is deleted and cannot be corrected');
        }
        corrected = applyTrainingRecordCorrection(
          prepareCurrentRecord(persisted, source),
          aggregateCommand(command)
        );
        if (corrected.revision === persisted.revision) {
          throw new Error('TrainingRecord correction command was concurrently consumed');
        }
        const recordIndex = draft.records.indexOf(persisted);
        draft.records[recordIndex] = cloneJson(corrected);
      }
      draft.sync.outbox.push(outboxDescriptor(command, corrected));
      draft.statisticsProjection = statisticsInvalidation(command, corrected);
    }, snapshot.localRevision);

    return cloneJson(preview);
  }

  delete(sourceCommand) {
    const command = assertDeleteCommand(sourceCommand);
    const snapshot = this.database.load();
    const current = findCanonicalRecord(snapshot.records, command.recordId);
    if (isDeletedTrainingRecord(current)) {
      return replayDeletedRecord(current, command);
    }
    const preview = buildTombstone(current, command);

    this.database.commit((draft) => {
      const persisted = findCanonicalRecord(draft.records, command.recordId);
      if (isDeletedTrainingRecord(persisted)) {
        throw new Error('TrainingRecord deletion command was concurrently consumed');
      }
      const tombstone = buildTombstone(persisted, command);
      const recordIndex = draft.records.indexOf(persisted);
      draft.records[recordIndex] = cloneJson(tombstone);
      draft.sync.outbox.push(
        outboxDescriptor(command, tombstone, 'training-record.deleted')
      );
      draft.statisticsProjection = statisticsInvalidation(command, tombstone);
    }, snapshot.localRevision);

    return cloneJson(preview);
  }

  list(query = {}) {
    const normalized = normalizeQuery(query);
    const validated = validateAllRecords(this.database.load().records);
    return validated
      .filter(({ deleted, effective }) => !deleted && (
        normalized.trainingDate === null ||
        effective.trainingDate === normalized.trainingDate
      ) && (
        normalized.kind === null ||
        effective.planSnapshot.steps.some(({ kind }) => kind === normalized.kind)
      ))
      .map(({ effective }) => cloneJson(effective))
      .sort(compareEffectiveRecords);
  }

  findById(recordId) {
    canonicalSourceSessionId(recordId);
    const validated = validateAllRecords(this.database.load().records);
    const match = validated.find(({ record }) => record.id === recordId);
    if (!match || match.deleted) {
      return null;
    }
    return cloneJson(match.effective);
  }
}

function createTrainingRecordRepository(options) {
  return new TrainingRecordRepository(options);
}

module.exports = {
  TrainingRecordRepository,
  createTrainingRecordRepository
};
