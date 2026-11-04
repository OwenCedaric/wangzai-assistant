import { createDashboardBusinessShareReadModel } from './dashboardBusinessShareReadModel.js';

/** Exposes the Dashboard donut's single canonical SQLite read model. */
export function createDashboardBusinessShareService({ db } = {}) {
  const readModel = createDashboardBusinessShareReadModel({ db });
  return {
    domain: 'dashboard-business-share',
    readCache(query = {}) {
      return readModel.read(query);
    },
  };
}
