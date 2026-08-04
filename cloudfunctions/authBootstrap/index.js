function createMain(loadRuntime = () => require('./_shared/cloudbase-runtime')) {
  return async (event) => {
    const runtime = loadRuntime();
    if (typeof runtime.invokeCloudFunction === 'function') {
      return runtime.invokeCloudFunction('authBootstrap', event);
    }
    return runtime.createHandlers().authBootstrap(event);
  };
}

exports.createMain = createMain;
exports.main = createMain();
