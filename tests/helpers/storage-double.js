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
    const faultIndex = this.writeFaults.findIndex((fault) => fault.key === key);
    if (faultIndex !== -1) {
      const [fault] = this.writeFaults.splice(faultIndex, 1);
      throw fault.error;
    }
    this.values.set(key, clone(value));
  }

  removeStorageSync(key) {
    this.operations.push({ type: 'remove', key });
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

  failNextWrite(key, error = new Error(`write failed for ${key}`)) {
    this.writeFaults.push({ key, error });
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
