function createMain(loadRuntime = () => require('./_shared/cloudbase-runtime')) {
  return async (event) => {
    const runtime = loadRuntime();
    if (typeof runtime.invokeCloudFunction === 'function') {
      return runtime.invokeCloudFunction('syncPull', event);
    }
    return runtime.createHandlers().syncPull(event);
  };
}

exports.createMain = createMain;
exports.main = createMain();
