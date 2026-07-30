const {
  createPlanApplicationService
} = require('../../application/plan-application-service');
const {
  createPlanRepository
} = require('../../domain/planning/plan-repository');
const {
  createLocalDatabase
} = require('../../services/local-database');

const application = createPlanApplicationService({
  repository: createPlanRepository({ database: createLocalDatabase() })
});

Page({
  data: {
    week: null
  },

  onLoad(query = {}) {
    application.initializeDefaultPlans();
    this.loadWeek(query.weekStart, query.selectedDate || null);
  },

  loadWeek(weekStart, selectedDate = null) {
    this.setData({
      week: application.getWeekPlan({ weekStart, selectedDate })
    });
  },

  onPreviousWeek() {
    this.loadWeek(this.data.week.previousWeekStart);
  },

  onNextWeek() {
    this.loadWeek(this.data.week.nextWeekStart);
  },

  onSelectDay(event) {
    this.loadWeek(this.data.week.weekStart, event.currentTarget.dataset.date);
  },

  onStartWorkout() {
    const selectedDay = this.data.week && this.data.week.selectedDay;
    if (!selectedDay || !selectedDay.canStartWorkout) {
      return;
    }
    wx.navigateTo({
      url: `/pages/workout/index?planId=${encodeURIComponent(selectedDay.id)}`
    });
  }
});
