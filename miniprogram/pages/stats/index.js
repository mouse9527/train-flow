const {
  createDeveloperStatisticsApplicationService,
  createStatisticsApplicationService
} = require('../../application/statistics-application-service');
const { createPlanRepository } = require('../../domain/planning/plan-repository');
const {
  createTrainingRecordRepository
} = require('../../domain/records/training-record-repository');
const { createLocalDatabase } = require('../../services/local-database');
const { createLocalStatisticsService } = require('../../services/statistics-service');

function currentTrainingDate(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function developerFixturesEnabled(wxApi) {
  if (!wxApi || typeof wxApi.getAccountInfoSync !== 'function') return false;
  try {
    const info = wxApi.getAccountInfoSync();
    return Boolean(info && info.miniProgram && info.miniProgram.envVersion === 'develop');
  } catch (_error) {
    return false;
  }
}

function createProductionApplication() {
  const database = createLocalDatabase();
  return createStatisticsApplicationService({
    service: createLocalStatisticsService({
      database,
      recordRepository: createTrainingRecordRepository({ database }),
      planRepository: createPlanRepository({ database })
    })
  });
}

function createStatsPageDefinition({
  applicationFactory = createProductionApplication,
  fixtureApplicationFactory = createDeveloperStatisticsApplicationService,
  getWx = () => wx,
  currentDate = currentTrainingDate
} = {}) {
  return {
    data: {
      view: null,
      validationError: null
    },

    onLoad(query = {}) {
      const useFixture = developerFixturesEnabled(getWx()) && query.fixture === 'worked-sample';
      const fixtureState = query.state === 'empty' ? 'empty' : 'populated';
      this.selectedDate = useFixture && /^\d{4}-\d{2}-\d{2}$/.test(query.date || '')
        ? query.date
        : currentDate();
      this.application = useFixture
        ? fixtureApplicationFactory(fixtureState)
        : applicationFactory();
      this.refresh();
      this.skipNextShowRefresh = true;
    },

    onShow() {
      if (this.skipNextShowRefresh) {
        this.skipNextShowRefresh = false;
        return;
      }
      if (this.application) this.refresh();
    },

    refresh() {
      try {
        this.setData({
          view: this.application.getView(this.selectedDate),
          validationError: null
        });
      } catch (error) {
        this.setData({ validationError: error.message || '统计暂时无法加载' });
      }
    }
  };
}

const definition = createStatsPageDefinition();
if (typeof Page === 'function') Page(definition);

module.exports = {
  createStatsPageDefinition,
  currentTrainingDate,
  developerFixturesEnabled
};
