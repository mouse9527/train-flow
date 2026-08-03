let pendingRecordId = null;

function assertRecordId(recordId) {
  if (
    typeof recordId !== 'string' ||
    !recordId.startsWith('record_') ||
    recordId.length === 'record_'.length
  ) {
    throw new TypeError('Record navigation handoff requires a canonical recordId');
  }
}

function setPendingRecordSelection(recordId) {
  assertRecordId(recordId);
  pendingRecordId = recordId;
}

function consumePendingRecordSelection() {
  const recordId = pendingRecordId;
  pendingRecordId = null;
  return recordId;
}

module.exports = {
  consumePendingRecordSelection,
  setPendingRecordSelection
};
