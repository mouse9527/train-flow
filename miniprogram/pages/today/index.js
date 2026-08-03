const { createTodayPlanRuntime } = require('../../application/today-plan-runtime');
const {
  setPendingRecordSelection
} = require('../../application/record-navigation-handoff');

function currentTrainingDate(now = Date.now()) {
  const local = new Date(now + 8 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function developerFixturesEnabled() {
  if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') {
    return false;
  }
  try {
    const accountInfo = wx.getAccountInfoSync();
    return Boolean(
      accountInfo &&
      accountInfo.miniProgram &&
      accountInfo.miniProgram.envVersion === 'develop'
    );
  } catch (error) {
    return false;
  }
}

function recordIdFromActionUrl(url) {
  if (typeof url !== 'string') {
    return null;
  }
  const query = url.split('?')[1];
  if (!query) {
    return null;
  }
  for (const pair of query.split('&')) {
    const [rawKey, rawValue = ''] = pair.split('=');
    try {
      if (decodeURIComponent(rawKey) === 'recordId') {
        return decodeURIComponent(rawValue);
      }
    } catch (_error) {
      return null;
    }
  }
  return null;
}

Page({
  data: {
    view: null
  },

  onLoad(query = {}) {
    const allowDeveloperFixtures = developerFixturesEnabled();
    this.runtime = createTodayPlanRuntime({
      selectedDate: allowDeveloperFixtures && query.date ? query.date : currentTrainingDate(),
      fixture: allowDeveloperFixtures ? query.fixture || null : null,
      allowDeveloperFixtures
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
      const recordId = recordIdFromActionUrl(action.url);
      if (recordId) {
        setPendingRecordSelection(recordId);
      }
      wx.switchTab({ url: action.url.split('?')[0] });
      return;
    }
    wx.navigateTo({ url: action.url });
  }
});

module.exports = { currentTrainingDate, developerFixturesEnabled, recordIdFromActionUrl };
