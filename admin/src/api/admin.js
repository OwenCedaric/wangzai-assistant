import {
  agentUsers, cardBatchCode, cardBatchCodes, cardBatchExport, cardBatchRevealedCodes,
  cardBatchRevealedCodesSearch, channelRotateToken, endpoints, orderQuery, orderRefund,
  planStopSales, resourceById,
  pointPackageStopSales, pointWalletAdjustment,
    paidCapabilityRateCardDisable, paidCapabilityRateCardImagePrice, paidCapabilityRateCardMultipliers,
  paidCapabilityReconciliation,
  apiPoolKeyRotate, apiPoolProviderEndpoint, apiPoolProviderKeys, apiPoolProviderModels,
} from './endpoints.js'
import { http } from './http.js'
import { normalizeItem, normalizeList } from './response.js'

export function buildListQuery(params = {}) {
  const query = Object.fromEntries(
    Object.entries(params).filter(([, value]) => {
      if (value === null || value === undefined) return false
      if (typeof value === 'string') return value.trim() !== ''
      if (Array.isArray(value)) return value.length > 0
      return !(typeof value === 'number' && Number.isNaN(value))
    }).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]),
  )
  if (query.keyword) query.q = query.keyword
  delete query.keyword
  return query
}

async function list(resource, params = {}) {
  const query = buildListQuery(params)
  const payload = await http.get(resource, { params: query })
  return normalizeList(payload, params.page, params.page_size)
}

async function create(resource, data) {
  return normalizeItem(await http.post(resource, data))
}

async function update(resource, id, data) {
  return normalizeItem(await http.put(resourceById(resource, id), data))
}

async function remove(resource, id) {
  return normalizeItem(await http.delete(resourceById(resource, id)))
}

function without(data, keys) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key)))
}

export const dashboardApi = {
  get: async () => normalizeItem(await http.get(endpoints.dashboard)),
}

export const projectsApi = {
  list: (params) => list(endpoints.projects, params),
  create: (data) => create(endpoints.projects, data),
  update: (id, data) => update(endpoints.projects, id, without(data, ['code'])),
  remove: (id) => remove(endpoints.projects, id),
  importManifest: (manifest) => create(endpoints.projectImport, manifest),
}

export const productsApi = {
  list: (params) => list(endpoints.products, params),
  create: (data) => create(endpoints.products, data),
  update: (id, data) => update(endpoints.products, id, without(data, ['project_id'])),
  remove: (id) => remove(endpoints.products, id),
}

export const permissionsApi = {
  list: (params) => list(endpoints.permissions, params),
  create: (data) => create(endpoints.permissions, data),
  update: (id, data) => update(endpoints.permissions, id, without(data, ['project_id', 'code'])),
  remove: (id) => remove(endpoints.permissions, id),
}

export const plansApi = {
  list: (params) => list(endpoints.plans, params),
  create: (data) => create(endpoints.plans, data),
  update: (id, data) => update(endpoints.plans, id, without(data, ['product_id'])),
  stopSales: async (id) => normalizeItem(await http.post(planStopSales(id))),
  remove: (id) => remove(endpoints.plans, id),
}

export const usersApi = {
  list: (params) => list(endpoints.users, params),
  create: (data) => create(endpoints.users, data),
  update: (id, data) => update(endpoints.users, id, without(data, ['username'])),
  remove: (id) => remove(endpoints.users, id),
}

export const licensesApi = {
  list: (params) => list(endpoints.licenses, params),
  create: (data) => create(endpoints.licenses, data),
  update: (id, data) => update(endpoints.licenses, id, data),
  revoke: (id) => update(endpoints.licenses, id, { status: 'revoked' }),
  remove: (id) => remove(endpoints.licenses, id),
}

export const cardBatchesApi = {
  list: (params) => list(endpoints.cardBatches, params),
  create: (data) => create(endpoints.cardBatches, data),
  updateStatus: (id, status) => update(endpoints.cardBatches, id, { status }),
  codes: (id, params) => list(cardBatchCodes(id), params),
  revealedCodes: (id, params) => list(
    cardBatchRevealedCodes(id),
    without(params || {}, ['q', 'keyword']),
  ),
  searchRevealedCodes: async (id, data) => normalizeList(
    await http.post(cardBatchRevealedCodesSearch(id), data),
    data.page,
    data.page_size,
  ),
  updateCodeStatus: async (batchId, codeId, status) => normalizeItem(
    await http.put(cardBatchCode(batchId, codeId), { status }),
  ),
  removeCode: (batchId, codeId) => remove(cardBatchCodes(batchId), codeId),
  remove: (id) => remove(endpoints.cardBatches, id),
  export: (id, format) => http.get(cardBatchExport(id, format), { responseType: 'blob' }),
}

export const devicesApi = {
  list: (params) => list(endpoints.devices, params),
  update: (id, data) => update(endpoints.devices, id, data),
  remove: (id) => remove(endpoints.devices, id),
}

export const shopsApi = {
  list: (params) => list(endpoints.shops, params),
  update: (id, data) => update(endpoints.shops, id, data),
  remove: (id) => remove(endpoints.shops, id),
}

export const usageLogsApi = {
  list: (params) => list(endpoints.usageLogs, params),
  remove: (id) => remove(endpoints.usageLogs, id),
}

export const agentsApi = {
  list: (params) => list(endpoints.agents, params),
  get: async (id) => normalizeItem(await http.get(resourceById(endpoints.agents, id))),
  create: (data) => create(endpoints.agents, data),
  update: (id, data) => update(endpoints.agents, id, without(data, ['code'])),
  updateStatus: (id, status) => update(endpoints.agents, id, { status }),
  dashboard: async () => normalizeItem(await http.get(endpoints.agentDashboard)),
  users: (id, params) => list(agentUsers(id), params),
  remove: (id) => remove(endpoints.agents, id),
}

export const channelsApi = {
  list: (params) => list(endpoints.channels, params),
  create: (data) => create(endpoints.channels, data),
  update: (id, data) => update(endpoints.channels, id, without(data, ['agent_id', 'project_id', 'code'])),
  updateStatus: (id, status) => update(endpoints.channels, id, { status }),
  rotateToken: async (id) => normalizeItem(await http.post(channelRotateToken(id))),
  remove: (id) => remove(endpoints.channels, id),
}

export const ordersApi = {
  list: (params) => list(endpoints.orders, params),
  get: async (id) => normalizeItem(await http.get(resourceById(endpoints.orders, id))),
  queryPayment: async (id) => normalizeItem(await http.post(orderQuery(id))),
  refund: async (id, data) => normalizeItem(await http.post(orderRefund(id), data)),
  remove: (id) => remove(endpoints.orders, id),
}

export const commissionsApi = {
  list: (params) => list(endpoints.commissions, params),
  dashboard: async () => normalizeItem(await http.get(endpoints.commissionDashboard)),
  remove: (id) => remove(endpoints.commissions, id),
}

export const commissionRulesApi = {
  list: (params) => list(endpoints.commissionRules, params),
  create: (data) => create(endpoints.commissionRules, data),
  update: (id, data) => update(endpoints.commissionRules, id, without(data, ['agent_id', 'project_id', 'plan_id'])),
  remove: (id) => remove(endpoints.commissionRules, id),
}

export const paymentConfigApi = {
  status: async () => normalizeItem(await http.get(endpoints.paymentConfigStatus)),
}

export const pointPackagesApi = {
  list: (params) => list(endpoints.pointPackages, params),
  create: (data) => create(endpoints.pointPackages, data),
  update: (id, data) => update(endpoints.pointPackages, id, without(data, ['product_id'])),
  stopSales: async (id) => normalizeItem(await http.post(pointPackageStopSales(id))),
  remove: (id) => remove(endpoints.pointPackages, id),
}

export const pointWalletsApi = {
  list: (params) => list(endpoints.pointWallets, params),
  adjust: async (id, data) => normalizeItem(await http.post(pointWalletAdjustment(id), data)),
  remove: (id) => remove(endpoints.pointWallets, id),
}

export const pointLedgerApi = {
  list: (params) => list(endpoints.pointLedger, params),
  remove: (id) => remove(endpoints.pointLedger, id),
}

export const paidCapabilityRateCardsApi = {
  list: (params) => list(endpoints.paidCapabilityRateCards, params),
  create: (data) => create(endpoints.paidCapabilityRateCards, data),
  disable: async (id) => normalizeItem(await http.post(paidCapabilityRateCardDisable(id))),
  updateImagePrice: async (id, data) => normalizeItem(
    await http.post(paidCapabilityRateCardImagePrice(id), data),
  ),
  updateMultipliers: async (id, data) => normalizeItem(
    await http.post(paidCapabilityRateCardMultipliers(id), data),
  ),
}

export const paidCapabilityReconciliationsApi = {
  list: (params) => list(endpoints.paidCapabilityReconciliations, params),
  reconcile: async (id, data) => normalizeItem(
    await http.post(paidCapabilityReconciliation(id), data),
  ),
}

export const apiPoolApi = {
  summary: async () => normalizeItem(await http.get(endpoints.apiPoolSummary)),
  autoConnect: async (data) => normalizeItem(await http.post(endpoints.apiPoolAutoConnect, data)),
  providers: async () => normalizeItem(await http.get(endpoints.apiPoolProviders)),
  createProvider: (data) => create(endpoints.apiPoolProviders, data),
  updateProvider: (id, data) => update(endpoints.apiPoolProviders, id, data),
  replaceProviderEndpoint: async (id, data) => normalizeItem(
    await http.put(apiPoolProviderEndpoint(id), data),
  ),
  removeProvider: (id) => remove(endpoints.apiPoolProviders, id),
  keys: async (providerId) => normalizeItem(await http.get(apiPoolProviderKeys(providerId))),
  createKey: async (providerId, data) => normalizeItem(
    await http.post(apiPoolProviderKeys(providerId), data),
  ),
  updateKey: (id, data) => update(endpoints.apiPoolKeys, id, data),
  rotateKey: async (id, data) => normalizeItem(await http.post(apiPoolKeyRotate(id), data)),
  removeKey: (id) => remove(endpoints.apiPoolKeys, id),
  models: async (providerId) => normalizeItem(
    await http.get(apiPoolProviderModels(providerId)),
  ),
  createModel: async (providerId, data) => normalizeItem(
    await http.post(apiPoolProviderModels(providerId), data),
  ),
  updateModel: (id, data) => update(endpoints.apiPoolModels, id, data),
  removeModel: (id) => remove(endpoints.apiPoolModels, id),
}

export const crossBorderProviderApi = {
  status: async () => normalizeItem(
    await http.get(`${endpoints.crossBorderProvider}/status`),
  ),
  saveSecret: async (companySecret) => normalizeItem(
    await http.put(`${endpoints.crossBorderProvider}/secret`, {
      company_secret: companySecret,
    }),
  ),
}

export const ossManagementApi = {
  configuration: async () => normalizeItem(
    await http.get(`${endpoints.ossManagement}/configuration`),
  ),
  saveConfiguration: async (data) => normalizeItem(
    await http.put(`${endpoints.ossManagement}/configuration`, data),
  ),
  test: async () => normalizeItem(await http.post(`${endpoints.ossManagement}/test`)),
  usage: async (hours = 168) => normalizeItem(
    await http.get(`${endpoints.ossManagement}/usage`, { params: { hours } }),
  ),
}
