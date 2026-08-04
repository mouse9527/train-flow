function createMain(loadRuntime = () => require('./_shared/cloudbase-runtime')) {
  return async (event) => {
    const runtime = loadRuntime();
    if (typeof runtime.invokeCloudFunction === 'function') {
      return runtime.invokeCloudFunction('accountPurge', event);
    }
    return runtime.createHandlers().accountPurge(event);
  };
}

exports.createMain = createMain;
exports.main = createMain();
