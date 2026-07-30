App({
  globalData: {
    deviceId: null
  },

  onLaunch() {
    // Local-first shell: no network or storage access at launch time.
    // US-SYNC-001 wires the real LocalDatabase; this cycle only owns the shell + settings contract.
  }
});
