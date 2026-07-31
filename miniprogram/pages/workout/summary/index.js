const {
  createDeveloperWorkoutSummaryRuntime,
  createWorkoutSummaryRuntime
} = require('../../../application/workout-summary-runtime');
const {
  SAFETY_ADVICE,
  createWorkoutFeedbackDraft,
  normalizeWorkoutFeedback
} = require('../../../application/workout-application-service');

function developerFixturesEnabled(wxApi) {
  if (!wxApi || typeof wxApi.getAccountInfoSync !== 'function') {
    return false;
  }
  try {
    const info = wxApi.getAccountInfoSync();
    return Boolean(info && info.miniProgram && info.miniProgram.envVersion === 'develop');
  } catch (error) {
    return false;
  }
}

function createWorkoutSummaryPageDefinition({
  runtimeFactory = createWorkoutSummaryRuntime,
  fixtureRuntimeFactory = createDeveloperWorkoutSummaryRuntime,
  getWx = () => wx
} = {}) {
  return {
    data: {
      summary: null,
      rpe: '',
      weightBeforeKg: '',
      pain: {
        knee: false,
        lowerBack: false,
        ankleOrToe: false,
        dizziness: false
      },
      note: '',
      safetyAdvice: null,
      safetyNotices: [],
      validationError: null,
      saved: false
    },

    onLoad(query = {}) {
      const wxApi = getWx();
      const useFixture = developerFixturesEnabled(wxApi) && query.fixture === 'worked-sample';
      this.runtime = useFixture
        ? fixtureRuntimeFactory({ status: query.status })
        : runtimeFactory();
      try {
        const state = this.runtime.load();
        const feedback = state.feedback || createWorkoutFeedbackDraft();
        this.setData({
          summary: state.summary,
          rpe: feedback.rpe === null ? '' : String(feedback.rpe),
          weightBeforeKg: feedback.weightBeforeKg === null
            ? ''
            : String(feedback.weightBeforeKg),
          pain: { ...feedback.pain },
          note: feedback.note,
          safetyAdvice: feedback.safetyAdvice,
          safetyNotices: feedback.safetyAdvice
            ? [feedback.safetyAdvice, '此提示不会用于诊断；症状严重或持续时，请及时寻求合适帮助。']
            : [],
          saved: state.saved,
          validationError: null
        });
      } catch (error) {
        this.setData({ validationError: error.message || '训练总结加载失败' });
      }
    },

    feedbackInput() {
      return {
        rpe: this.data.rpe === '' ? null : Number(this.data.rpe),
        weightBeforeKg: this.data.weightBeforeKg === ''
          ? null
          : Number(this.data.weightBeforeKg),
        pain: { ...this.data.pain },
        note: this.data.note
      };
    },

    refreshSafetyAdvice() {
      const hasSafetyAlarm = Object.values(this.data.pain).some((value) => value === true);
      const safetyAdvice = hasSafetyAlarm ? SAFETY_ADVICE : null;
      const safetyNotices = safetyAdvice
        ? [safetyAdvice, '此提示不会用于诊断；症状严重或持续时，请及时寻求合适帮助。']
        : [];
      try {
        normalizeWorkoutFeedback(this.feedbackInput());
        this.setData({
          safetyAdvice,
          safetyNotices,
          validationError: null
        });
      } catch (error) {
        this.setData({ safetyAdvice, safetyNotices, validationError: error.message });
      }
    },

    onRpeChange({ detail }) {
      this.setData({ rpe: detail.value });
      this.refreshSafetyAdvice();
    },

    onWeightInput({ detail }) {
      this.setData({ weightBeforeKg: detail.value });
      this.refreshSafetyAdvice();
    },

    onPainChange({ currentTarget, detail }) {
      const field = currentTarget && currentTarget.dataset
        ? currentTarget.dataset.field
        : null;
      if (!Object.prototype.hasOwnProperty.call(this.data.pain, field)) {
        return;
      }
      this.setData({ pain: { ...this.data.pain, [field]: detail.value === true } });
      this.refreshSafetyAdvice();
    },

    onNoteInput({ detail }) {
      this.setData({ note: detail.value });
      this.refreshSafetyAdvice();
    },

    onSubmit() {
      try {
        this.runtime.saveFeedback(this.feedbackInput());
        this.setData({ saved: true, validationError: null });
        const wxApi = getWx();
        if (typeof wxApi.showToast === 'function') {
          wxApi.showToast({ title: '反馈已保存在本机', icon: 'none' });
        }
      } catch (error) {
        this.setData({ validationError: error.message || '反馈保存失败' });
      }
    }
  };
}

const definition = createWorkoutSummaryPageDefinition();
if (typeof Page === 'function') {
  Page(definition);
}

module.exports = { createWorkoutSummaryPageDefinition, developerFixturesEnabled };
