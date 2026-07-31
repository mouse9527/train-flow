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

function assertUniquePlanIds(records) {
  const ownerCounts = new Map();
  for (const record of records) {
    ownerCounts.set(record.id, (ownerCounts.get(record.id) || 0) + 1);
  }
  for (const [planId, ownerCount] of ownerCounts) {
    if (ownerCount > 1) {
      const error = createRepositoryError(
        `Persisted plan ID ${planId} has ${ownerCount} owners`,
        'PLAN_ID_INTEGRITY_ERROR'
      );
      error.planId = planId;
      error.ownerCount = ownerCount;
      throw error;
    }
  }
}

function assertPersistedTemplateIntegrity(records, candidates, templateVersion) {
  const candidateIds = new Set(candidates.map(({ id }) => id));
  const candidateOwners = new Map(candidates.map(({ id }) => [id, []]));
  const activeDateOwners = new Map();
  const templateRecords = [];

  for (const record of records) {
    if (record.templateSource === templateVersion) {
      templateRecords.push(record);
    }
    if (candidateOwners.has(record.id)) {
      candidateOwners.get(record.id).push(record);
    }
    if (activePlan(record)) {
      const owners = activeDateOwners.get(record.trainingDate) || [];
      owners.push(record);
      activeDateOwners.set(record.trainingDate, owners);
    }
  }

  const seenIds = new Set();
  for (const record of templateRecords) {
    if (!candidateIds.has(record.id) || seenIds.has(record.id)) {
      throw createRepositoryError(
        `Persisted template ${templateVersion} has unexpected or duplicate plan ID ${record.id}`,
        'PLAN_TEMPLATE_INTEGRITY_ERROR'
      );
    }
    seenIds.add(record.id);
    try {
      assertWorkoutPlan(record);
    } catch (error) {
      throw createRepositoryError(
        `Persisted template ${templateVersion} contains invalid plan ${record.id}: ${error.message}`,
        'PLAN_TEMPLATE_INTEGRITY_ERROR'
      );
    }
  }

  for (const candidate of candidates) {
    const owners = candidateOwners.get(candidate.id);
    if (owners.length > 1) {
      throw createRepositoryError(
        `Persisted template ${templateVersion} has duplicate plan ID ${candidate.id}`,
        'PLAN_TEMPLATE_INTEGRITY_ERROR'
      );
    }
    if (owners.length === 0) {
      continue;
    }
    const owner = owners[0];
    if (owner.templateSource !== templateVersion) {
      throw createRepositoryError(
        `Plan ID ${candidate.id} is owned by a different template source`,
        'PLAN_TEMPLATE_INTEGRITY_ERROR'
      );
    }
    if (activePlan(owner) && activeDateOwners.get(owner.trainingDate).length > 1) {
      throw createRepositoryError(
        `Persisted template ${templateVersion} has multiple active plans for trainingDate ${owner.trainingDate}`,
        'PLAN_TEMPLATE_INTEGRITY_ERROR'
      );
    }
  }

  return { persistedTemplateIds: seenIds, templateRecords };
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
    const candidateIds = new Set(candidates.map(({ id }) => id));
    const {
      persistedTemplateIds,
      templateRecords: existingFromTemplate
    } = assertPersistedTemplateIntegrity(
      snapshot.plans,
      candidates,
      templateVersion
    );
    if (
      existingFromTemplate.length === candidates.length &&
      persistedTemplateIds.size === candidateIds.size
    ) {
      return {
        created: 0,
        templateVersion,
        plans: clone(existingFromTemplate).filter(activePlan).sort((left, right) => (
          left.trainingDate.localeCompare(right.trainingDate)
        ))
      };
    }

    const existingIds = new Set(snapshot.plans.map(({ id }) => id));
    const existingDates = new Set(snapshot.plans.filter(activePlan).map(({ trainingDate }) => trainingDate));
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
      const activeDates = new Set(draft.plans.filter(activePlan).map(({ trainingDate }) => trainingDate));
      for (const plan of missing) {
        if (activeDates.has(plan.trainingDate)) {
          throw createRepositoryError(
            `Plan already exists for trainingDate ${plan.trainingDate}`,
            'PLAN_DATE_CONFLICT'
          );
        }
      }
      draft.plans.push(...clone(missing));
    }, snapshot.localRevision);
    const persisted = committed.plans.filter((plan) => candidateIds.has(plan.id) && activePlan(plan));
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
    assertUniquePlanIds(snapshot.plans);
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
      ({ id, trainingDate, status }) => (
        id !== plan.id && status !== 'deleted' && trainingDate === plan.trainingDate
      )
    );
    if (dateOwner) {
      throw createRepositoryError(
        `Plan already exists for trainingDate ${plan.trainingDate}`,
        'PLAN_DATE_CONFLICT'
      );
    }

    const untrustedCandidate = {
      ...plan,
      status: 'scheduled',
      createdAt: existing ? existing.createdAt : timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      revision: actualRevision + 1
    };
    assertWorkoutPlan(untrustedCandidate);
    const candidate = clone(untrustedCandidate);
    assertWorkoutPlan(candidate);

    const committed = this.database.commit((draft) => {
      assertUniquePlanIds(draft.plans);
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
        ({ id, trainingDate, status }) => (
          id !== candidate.id && status !== 'deleted' && trainingDate === candidate.trainingDate
        )
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

  replaceForDate(plan, expectedTargetRevision) {
    assertExpectedRevision(expectedTargetRevision);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      throw new Error('replacement plan must be an object');
    }
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) {
      throw new Error('PlanRepository now must return a finite epoch timestamp');
    }
    const snapshot = this.database.load();
    assertUniquePlanIds(snapshot.plans);
    const target = snapshot.plans.find(
      ({ trainingDate, status }) => status !== 'deleted' && trainingDate === plan.trainingDate
    ) || null;
    const actualRevision = target ? target.revision : 0;
    if (!target || actualRevision !== expectedTargetRevision) {
      throw createRepositoryError(
        `Plan revision conflict: expected ${expectedTargetRevision}, actual ${actualRevision}`,
        'PLAN_REVISION_CONFLICT'
      );
    }
    if (snapshot.plans.some(({ id }) => id === plan.id)) {
      throw createRepositoryError(`Persisted plan ID ${plan.id} already exists`, 'PLAN_ID_INTEGRITY_ERROR');
    }

    const candidate = {
      ...plan,
      status: 'scheduled',
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
      revision: 1
    };
    const tombstone = {
      ...clone(target),
      status: 'deleted',
      updatedAt: timestamp,
      deletedAt: timestamp,
      revision: target.revision + 1
    };
    assertWorkoutPlan(candidate);
    assertWorkoutPlan(tombstone);
    const detachedCandidate = clone(candidate);
    const detachedTombstone = clone(tombstone);

    const committed = this.database.commit((draft) => {
      assertUniquePlanIds(draft.plans);
      const currentIndex = draft.plans.findIndex(
        ({ trainingDate, status }) => status !== 'deleted' && trainingDate === detachedCandidate.trainingDate
      );
      const current = currentIndex === -1 ? null : draft.plans[currentIndex];
      const currentRevision = current ? current.revision : 0;
      if (!current || currentRevision !== expectedTargetRevision) {
        throw createRepositoryError(
          `Plan revision conflict: expected ${expectedTargetRevision}, actual ${currentRevision}`,
          'PLAN_REVISION_CONFLICT'
        );
      }
      if (draft.plans.some(({ id }) => id === detachedCandidate.id)) {
        throw createRepositoryError(
          `Persisted plan ID ${detachedCandidate.id} already exists`,
          'PLAN_ID_INTEGRITY_ERROR'
        );
      }
      draft.plans[currentIndex] = clone(detachedTombstone);
      draft.plans.push(clone(detachedCandidate));
    }, snapshot.localRevision);
    return clone(committed.plans.find(({ id }) => id === detachedCandidate.id));
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
    assertUniquePlanIds(snapshot.plans);
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
      assertUniquePlanIds(draft.plans);
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
