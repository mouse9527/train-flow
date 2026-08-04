Component({
  properties: {
    state: {
      type: Object,
      value: null
    }
  },

  methods: {
    onRetry() {
      this.triggerEvent('retry');
    },

    onResolve(event) {
      this.triggerEvent('resolve', {
        conflictId: event.currentTarget.dataset.conflictId,
        action: event.currentTarget.dataset.action
      });
    }
  }
});
