// 管理端 API 路径只在此处维护，页面和组件不得自行拼接接口地址。
export const endpoints = Object.freeze({
  auth: {
    login: '/api/auth/login',
  },
  dashboard: '/api/admin/dashboard',
  users: '/api/admin/users',
  projects: '/api/admin/projects',
  projectImport: '/api/admin/projects/import',
  products: '/api/admin/products',
  permissions: '/api/admin/permissions',
  plans: '/api/admin/plans',
  licenses: '/api/admin/licenses',
  cardBatches: '/api/admin/card-batches',
  devices: '/api/admin/devices',
  shops: '/api/admin/shops',
  usageLogs: '/api/admin/usage-logs',
  agents: '/api/admin/agents',
  agentDashboard: '/api/admin/agents/dashboard',
  channels: '/api/admin/channels',
  orders: '/api/admin/orders',
  commissions: '/api/admin/commissions',
  commissionDashboard: '/api/admin/commissions/dashboard',
  commissionRules: '/api/admin/commission-rules',
  paymentConfigStatus: '/api/admin/payment-config/status',
  pointPackages: '/api/admin/point-packages',
  pointWallets: '/api/admin/point-wallets',
  pointLedger: '/api/admin/point-ledger',
  paidCapabilityRateCards: '/api/admin/paid-capabilities/rate-cards',
  paidCapabilityReconciliations: '/api/admin/paid-capabilities/reconciliations',
  apiPoolSummary: '/api/admin/api-pool/summary',
  apiPoolAutoConnect: '/api/admin/api-pool/auto-connect',
  apiPoolProviders: '/api/admin/api-pool/providers',
  apiPoolKeys: '/api/admin/api-pool/keys',
  apiPoolModels: '/api/admin/api-pool/models',
  crossBorderProvider: '/api/admin/cross-border-provider',
  ossManagement: '/api/admin/oss',
})

export function resourceById(resource, id) {
  return `${resource}/${encodeURIComponent(String(id))}`
}

export function cardBatchCodes(id) {
  return `${resourceById(endpoints.cardBatches, id)}/codes`
}

export function cardBatchRevealedCodes(id) {
  return `${cardBatchCodes(id)}/revealed`
}

export function cardBatchRevealedCodesSearch(id) {
  return `${cardBatchRevealedCodes(id)}/search`
}

export function cardBatchCode(batchId, codeId) {
  return resourceById(cardBatchCodes(batchId), codeId)
}

export function cardBatchExport(id, format = 'csv') {
  const safeFormat = format === 'xlsx' ? 'xlsx' : 'csv'
  return `${resourceById(endpoints.cardBatches, id)}/export?format=${safeFormat}`
}

export function channelRotateToken(id) {
  return `${resourceById(endpoints.channels, id)}/rotate-token`
}

export function agentUsers(id) {
  return `${resourceById(endpoints.agents, id)}/users`
}

export function orderQuery(id) {
  return `${resourceById(endpoints.orders, id)}/query`
}

export function orderRefund(id) {
  return `${resourceById(endpoints.orders, id)}/refund`
}

export function planStopSales(id) {
  return `${resourceById(endpoints.plans, id)}/stop-sales`
}

export function pointPackageStopSales(id) {
  return `${resourceById(endpoints.pointPackages, id)}/stop-sales`
}

export function pointWalletAdjustment(id) {
  return `${resourceById(endpoints.pointWallets, id)}/adjust`
}

export function paidCapabilityRateCardDisable(id) {
  return `${resourceById(endpoints.paidCapabilityRateCards, id)}/disable`
}

export function paidCapabilityRateCardImagePrice(id) {
  return `${resourceById(endpoints.paidCapabilityRateCards, id)}/image-price`
}

export function paidCapabilityRateCardMultipliers(id) {
  return `${resourceById(endpoints.paidCapabilityRateCards, id)}/multipliers`
}

export function paidCapabilityReconciliation(id) {
  return resourceById(endpoints.paidCapabilityReconciliations, id)
}

export function apiPoolProviderKeys(id) {
  return `${resourceById(endpoints.apiPoolProviders, id)}/keys`
}

export function apiPoolProviderModels(id) {
  return `${resourceById(endpoints.apiPoolProviders, id)}/models`
}

export function apiPoolProviderEndpoint(id) {
  return `${resourceById(endpoints.apiPoolProviders, id)}/endpoint`
}

export function apiPoolKeyRotate(id) {
  return `${resourceById(endpoints.apiPoolKeys, id)}/rotate`
}
