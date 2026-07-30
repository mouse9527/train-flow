const { createPlanApplicationService } = require('./plan-application-service');
const { createTodayPlanApplicationService } = require('./today-plan-view');
const { createPlanRepository } = require('../domain/planning/plan-repository');
const { createLocalDatabase } = require('../services/local-database');

const COMPLETED_FIXTURE = Object.freeze({
  id: 'record_today_fixture',
  sourceSessionId: 'session_today_fixture',
  trainingDate: '2026-08-03',
  status: 'completed',
  elapsedActiveSeconds: 2040,
  startedAt: 1785717300000,
  endedAt: 1785719340000,
  deletedAt: null
});

const ACTIVE_FIXTURE = Object.freeze({
  id: 'session_today_fixture',
  planId: 'plan_20260803_builtin',
  trainingDate: '2026-08-03',
  status: 'in_progress',
  currentStepIndex: 1
});

function clone(value) {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function fixtureRecords(fixture, selectedDate) {
  if (fixture === 'completed' && selectedDate === COMPLETED_FIXTURE.trainingDate) {
    return [clone(COMPLETED_FIXTURE)];
  }
  return [];
}

function fixtureActiveSession(fixture, selectedDate) {
  if (fixture === 'active' && selectedDate === ACTIVE_FIXTURE.trainingDate) {
    return clone(ACTIVE_FIXTURE);
  }
  return null;
}

function createSnapshotReadRepositories({ database, fixture, selectedDate }) {
  return {
    recordRepository: {
      findByDateRange(startDate, endDate) {
        const records = database.load().records.filter(({ trainingDate }) => (
          trainingDate >= startDate && trainingDate <= endDate
        ));
        return [...records, ...fixtureRecords(fixture, selectedDate)];
      }
    },
    activeSessionRepository: {
      findActive() {
        return fixtureActiveSession(fixture, selectedDate) || database.load().activeSession;
      }
    }
  };
}

function createTodayPlanRuntime({
  selectedDate,
  fixture = null,
  database = createLocalDatabase()
}) {
  const planRepository = createPlanRepository({ database });
  createPlanApplicationService({ repository: planRepository }).initializeDefaultPlans();
  const repositories = createSnapshotReadRepositories({ database, fixture, selectedDate });
  const service = createTodayPlanApplicationService({
    planRepository,
    ...repositories
  });
  return {
    getTodayPlan() {
      return service.getTodayPlan(selectedDate);
    }
  };
}

module.exports = {
  createSnapshotReadRepositories,
  createTodayPlanRuntime
};
