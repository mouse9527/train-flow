const assert = require('node:assert/strict');

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

class StorageDouble {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
    this.operations = [];
    this.readFaults = [];
    this.writeFaults = [];
    this.removeFaults = [];
  }

  getStorageSync(key) {
    this.operations.push({ type: 'read', key });
    const writesSoFar = this.operations.filter(
      (operation) => operation.type === 'write' && operation.key === key
    ).length;
    const faultIndex = this.readFaults.findIndex(
      (fault) => fault.key === key && writesSoFar >= fault.afterWrites
    );
    if (faultIndex !== -1) {
      const [fault] = this.readFaults.splice(faultIndex, 1);
      if (fault.error) {
        throw fault.error;
      }
      if (fault.mutateStored) {
        const damaged = fault.transform(clone(this.values.get(key)));
        this.values.set(key, clone(damaged));
        return clone(damaged);
      }
      return clone(fault.transform(clone(this.values.get(key))));
    }
    return clone(this.values.get(key));
  }

  setStorageSync(key, value) {
    this.operations.push({ type: 'write', key, value: clone(value) });
    const priorWrites = this.operations.slice(0, -1).filter(
      (operation) => operation.type === 'write' && operation.key === key
    ).length;
    const faultIndex = this.writeFaults.findIndex(
      (fault) => fault.key === key && priorWrites >= fault.afterWrites
    );
    if (faultIndex !== -1) {
      const [fault] = this.writeFaults.splice(faultIndex, 1);
      if (fault.persistBeforeThrow) {
        this.values.set(key, clone(value));
      }
      throw fault.error;
    }
    this.values.set(key, clone(value));
  }

  removeStorageSync(key) {
    this.operations.push({ type: 'remove', key });
    const priorRemoves = this.operations.slice(0, -1).filter(
      (operation) => operation.type === 'remove' && operation.key === key
    ).length;
    const faultIndex = this.removeFaults.findIndex(
      (fault) => fault.key === key && priorRemoves >= fault.afterRemoves
    );
    if (faultIndex !== -1) {
      const [fault] = this.removeFaults.splice(faultIndex, 1);
      if (fault.removeBeforeThrow) {
        this.values.delete(key);
      }
      throw fault.error;
    }
    this.values.delete(key);
  }

  seed(key, value) {
    this.values.set(key, clone(value));
  }

  peek(key) {
    return clone(this.values.get(key));
  }

  clearOperations() {
    this.operations.length = 0;
  }

  failNextRead(key, error = new Error(`read failed for ${key}`), { afterWrites = 0 } = {}) {
    this.readFaults.push({ key, error, afterWrites });
  }

  transformNextRead(key, transform, { mutateStored = false, afterWrites = 0 } = {}) {
    this.readFaults.push({ key, transform, mutateStored, afterWrites });
  }

  failNextWrite(
    key,
    error = new Error(`write failed for ${key}`),
    { afterWrites = 0, persistBeforeThrow = false } = {}
  ) {
    this.writeFaults.push({ key, error, afterWrites, persistBeforeThrow });
  }

  failNextRemove(
    key,
    error = new Error(`remove failed for ${key}`),
    { afterRemoves = 0, removeBeforeThrow = false } = {}
  ) {
    this.removeFaults.push({ key, error, afterRemoves, removeBeforeThrow });
  }

  writesFor(key) {
    return this.operations.filter((operation) => operation.type === 'write' && operation.key === key);
  }

  assertOnlyKeysWritten(expectedKeys) {
    assert.deepEqual(
      this.operations.filter((operation) => operation.type === 'write').map(({ key }) => key),
      expectedKeys
    );
  }
}

module.exports = { StorageDouble, clone };
