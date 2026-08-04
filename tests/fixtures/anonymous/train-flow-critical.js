const FIXED_CLOCK = Object.freeze({
  startAt: 1785717300000,
  hideAt: 1785717360000,
  restartAt: 1785717660000
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createAnonymousOfflineAdapter(initial = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, clone(value)])
  );
  let attempts = 0;
  return {
    values,
    getStorageSync(key) {
      return clone(values.get(key));
    },
    setStorageSync(key, value) {
      values.set(key, clone(value));
    },
    removeStorageSync(key) {
      values.delete(key);
    },
    cloud: {
      async callFunction() {
        attempts += 1;
        const error = new Error('anonymous fixture network is offline');
        error.code = 'NETWORK_OFFLINE';
        throw error;
      }
    },
    networkAttempts() {
      return attempts;
    },
    storageBytes() {
      return JSON.stringify(
        [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
      );
    }
  };
}

module.exports = {
  FIXED_CLOCK,
  createAnonymousOfflineAdapter
};
