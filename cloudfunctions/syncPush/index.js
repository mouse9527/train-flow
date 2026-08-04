function createMain(loadRuntime = () => require('./_shared/cloudbase-runtime')) {
  return async (event) => {
    const runtime = loadRuntime();
    if (typeof runtime.invokeCloudFunction === 'function') {
      return runtime.invokeCloudFunction('syncPush', event);
    }
    return runtime.createHandlers().syncPush(event);
  };
}

exports.createMain = createMain;
exports.main = createMain();
