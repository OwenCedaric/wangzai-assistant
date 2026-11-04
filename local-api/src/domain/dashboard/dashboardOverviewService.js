import { createDashboardOverviewReadModel } from './dashboardOverviewReadModel.js';

export function createDashboardOverviewService({ db } = {}) {
  const readModel = createDashboardOverviewReadModel({ db });
  return {
    domain: 'dashboard-overview',
    readCache(query = {}) {
      return readModel.read(query);
    },
  };
}

