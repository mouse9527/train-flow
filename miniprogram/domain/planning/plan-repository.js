const { assertWorkoutPlan } = require('./plan-validation');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRepositoryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertExpectedRevision(expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer');
  }
}

function assertDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date`);
  }
}

function activePlan(plan) {
  return plan && plan.status !== 'deleted';
}

function validateDefaultSet(plans, templateVersion) {
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error('Default plans must be a non-empty array');
  }
  if (typeof templateVersion !== 'string' || templateVersion.length === 0) {
    throw new Error('templateVersion must be a non-empty string');
  }
  plans.forEach((plan) => {
    assertWorkoutPlan(plan);
    if (plan.templateSource !== templateVersion) {
      throw new Error(`Default plan ${plan.id} must use templateSource ${templateVersion}`);
    }
  });
  const ids = plans.map(({ id }) => id);
  const dates = plans.map(({ trainingDate }) => trainingDate);
  if (new Set(ids).size !== ids.length || new Set(dates).size !== dates.length) {
    throw new Error('Default plans must use unique IDs and training dates');
  }
}

class PlanRepository {
  constructor({ database, now = Date.now }) {
    if (!database || typeof database.load !== 'function' || typeof database.commit !== 'function') {
      throw new Error('PlanRepository requires a LocalDatabase');
    }
    if (typeof now !== 'function') {
      throw new Error('PlanRepository now must be a function');
    }
    this.database = database;
    this.now = now;
  }

  initializeDefaults(plans, templateVersion) {
    validateDefaultSet(plans, templateVersion);
    const candidates = clone(plans);
    const snapshot = this.database.load();
    const existingFromTemplate = snapshot.plans.filter(
      ({ templateSource }) => templateSource === templateVersion
    );
    const candidateIds = new Set(candidates.map(({ id }) => id));
    if (
      existingFromTemplate.length === candidates.length &&
      existingFromTemplate.every(({ id }) => candidateIds.has(id))
    ) {
      return {
        created: 0,
        templateVersion,
        plans: clone(existingFromTemplate).sort((left, right) => (
          left.trainingDate.localeCompare(right.trainingDate)
        ))
      };
    }

    const existingIds = new Set(snapshot.plans.map(({ id }) => id));
    const existingDates = new Set(snapshot.plans.map(({ trainingDate }) => trainingDate));
    const missing = candidates.filter(({ id }) => !existingIds.has(id));
    for (const plan of missing) {
      if (existingDates.has(plan.trainingDate)) {
        throw new Error(`Plan already exists for trainingDate ${plan.trainingDate}`);
      }
    }
    if (missing.length === 0) {
      throw new Error(`Default template ${templateVersion} conflicts with existing plan IDs`);
    }

    const committed = this.database.commit((draft) => {
      draft.plans.push(...clone(missing));
    }, snapshot.localRevision);
    const persisted = committed.plans.filter(({ id }) => candidateIds.has(id));
    return {
      created: missing.length,
      templateVersion,
      plans: clone(persisted).sort((left, right) => left.trainingDate.localeCompare(right.trainingDate))
    };
  }

  findRange(startDate, endDate) {
    assertDate(startDate, 'startDate');
    assertDate(endDate, 'endDate');
    if (startDate > endDate) {
      throw new Error('startDate must not be after endDate');
    }
    return this.database.load().plans
      .filter(({ status, trainingDate }) => (
        status !== 'deleted' && trainingDate >= startDate && trainingDate <= endDate
      ))
      .sort((left, right) => left.trainingDate.localeCompare(right.trainingDate))
      .map(clone);
  }

  findById(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('plan id must be a non-empty string');
    }
    const plan = this.database.load().plans.find((candidate) => candidate.id === id);
    return activePlan(plan) ? clone(plan) : null;
  }

  findByDate(trainingDate) {
    assertDate(trainingDate, 'trainingDate');
    const plan = this.database.load().plans.find(
      (candidate) => candidate.trainingDate === trainingDate && activePlan(candidate)
    );
    return plan ? clone(plan) : null;
  }

  save(plan, expectedRevision) {
    assertExpectedRevision(expectedRevision);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      throw new Error('plan must be an object');
    }
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) {
      throw new Error('PlanRepository now must return a finite epoch timestamp');
    }
    const snapshot = this.database.load();
    const existing = snapshot.plans.find(({ id }) => id === plan.id) || null;
    const actualRevision = existing ? existing.revision : 0;
    if (actualRevision !== expectedRevision) {
      throw createRepositoryError(
        `Plan revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
        'PLAN_REVISION_CONFLICT'
      );
    }
    if (existing && existing.status === 'deleted') {
      throw createRepositoryError(`Plan ${plan.id} is deleted`, 'PLAN_DELETED');
    }
    const dateOwner = snapshot.plans.find(
      ({ id, trainingDate }) => id !== plan.id && trainingDate === plan.trainingDate
    );
    if (dateOwner) {
      throw createRepositoryError(
        `Plan already exists for trainingDate ${plan.trainingDate}`,
        'PLAN_DATE_CONFLICT'
      );
    }

    const candidate = {
      ...clone(plan),
      status: 'scheduled',
      createdAt: existing ? existing.createdAt : timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      revision: actualRevision + 1
    };
    assertWorkoutPlan(candidate);

    const committed = this.database.commit((draft) => {
      const index = draft.plans.findIndex(({ id }) => id === candidate.id);
      const current = index === -1 ? null : draft.plans[index];
      const currentRevision = current ? current.revision : 0;
      if (currentRevision !== expectedRevision) {
        throw createRepositoryError(
          `Plan revision conflict: expected ${expectedRevision}, actual ${currentRevision}`,
          'PLAN_REVISION_CONFLICT'
        );
      }
      if (draft.plans.some(
        ({ id, trainingDate }) => id !== candidate.id && trainingDate === candidate.trainingDate
      )) {
        throw createRepositoryError(
          `Plan already exists for trainingDate ${candidate.trainingDate}`,
          'PLAN_DATE_CONFLICT'
        );
      }
      if (index === -1) {
        draft.plans.push(clone(candidate));
      } else {
        draft.plans[index] = clone(candidate);
      }
    }, snapshot.localRevision);
    return clone(committed.plans.find(({ id }) => id === candidate.id));
  }

  delete(id, expectedRevision) {
    assertExpectedRevision(expectedRevision);
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('plan id must be a non-empty string');
    }
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) {
      throw new Error('PlanRepository now must return a finite epoch timestamp');
    }
    const snapshot = this.database.load();
    const existing = snapshot.plans.find((plan) => plan.id === id) || null;
    const actualRevision = existing ? existing.revision : 0;
    if (!existing || actualRevision !== expectedRevision || existing.status === 'deleted') {
      throw createRepositoryError(
        `Plan revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
        'PLAN_REVISION_CONFLICT'
      );
    }
    const tombstone = {
      ...clone(existing),
      status: 'deleted',
      updatedAt: timestamp,
      deletedAt: timestamp,
      revision: actualRevision + 1
    };
    assertWorkoutPlan(tombstone);

    const committed = this.database.commit((draft) => {
      const index = draft.plans.findIndex((plan) => plan.id === id);
      const current = index === -1 ? null : draft.plans[index];
      const currentRevision = current ? current.revision : 0;
      if (!current || currentRevision !== expectedRevision || current.status === 'deleted') {
        throw createRepositoryError(
          `Plan revision conflict: expected ${expectedRevision}, actual ${currentRevision}`,
          'PLAN_REVISION_CONFLICT'
        );
      }
      draft.plans[index] = clone(tombstone);
    }, snapshot.localRevision);
    return clone(committed.plans.find((plan) => plan.id === id));
  }
}

function createPlanRepository(options) {
  return new PlanRepository(options);
}

module.exports = { PlanRepository, createPlanRepository };
