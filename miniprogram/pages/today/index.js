const { createTodayPlanRuntime } = require('../../application/today-plan-runtime');

function currentTrainingDate(now = Date.now()) {
  const local = new Date(now + 8 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

Page({
  data: {
    view: null
  },

  onLoad(query = {}) {
    this.runtime = createTodayPlanRuntime({
      selectedDate: query.date || currentTrainingDate(),
      fixture: query.fixture || null
    });
    this.refresh();
  },

  onShow() {
    if (this.runtime) {
      this.refresh();
    }
  },

  refresh() {
    this.setData({ view: this.runtime.getTodayPlan() });
  },

  onPrimaryAction() {
    const action = this.data.view && this.data.view.primaryAction;
    if (!action) {
      return;
    }
    if (action.navigationMode === 'switchTab') {
      wx.switchTab({ url: action.url.split('?')[0] });
      return;
    }
    wx.navigateTo({ url: action.url });
  }
});

module.exports = { currentTrainingDate };
