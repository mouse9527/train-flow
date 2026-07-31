const {
  createPlanApplicationService
} = require('../../application/plan-application-service');
const {
  createPlanRepository
} = require('../../domain/planning/plan-repository');
const {
  createLocalDatabase
} = require('../../services/local-database');
const {
  createLocalRecordSummaryProvider
} = require('../../services/local-record-summary-provider');

const database = createLocalDatabase();
const application = createPlanApplicationService({
  repository: createPlanRepository({ database }),
  recordSummaryProvider: createLocalRecordSummaryProvider({ database })
});

Page({
  data: {
    week: null
  },

  onLoad(query = {}) {
    application.initializeDefaultPlans();
    this.loadWeek(query.weekStart, query.selectedDate || null);
  },

  onShow() {
    const week = this.data.week;
    if (!week) {
      return;
    }
    this.loadWeek(
      week.weekStart,
      week.selectedDay ? week.selectedDay.trainingDate : null
    );
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
  },

  onEditPlan() {
    const selectedDay = this.data.week && this.data.week.selectedDay;
    if (!selectedDay) {
      return;
    }
    wx.navigateTo({
      url: `/pages/plan/edit/index?planId=${encodeURIComponent(selectedDay.id)}`
    });
  },

  onCreatePlan(event) {
    const trainingDate = event.currentTarget.dataset.date;
    if (!trainingDate) {
      return;
    }
    wx.navigateTo({
      url: `/pages/plan/edit/index?trainingDate=${encodeURIComponent(trainingDate)}`
    });
  }
});
