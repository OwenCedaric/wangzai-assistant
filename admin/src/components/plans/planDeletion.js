import { getApiError } from '../../api/response.js'

export const PLAN_DELETE_DEPENDENCY_FALLBACK = '该套餐已有授权、卡密、订单或分佣规则。为保留历史数据，不能永久删除。'

const dependencyLabels = Object.freeze({
  licenses: '授权',
  license_count: '授权',
  card_batches: '卡密批次',
  card_batch_count: '卡密批次',
  activation_codes: '卡密',
  activation_code_count: '卡密',
  orders: '订单',
  order_count: '订单',
  commission_rules: '分佣规则',
  commission_rule_count: '分佣规则',
})

function errorDetail(error) {
  return error?.response?.data?.detail
}

function errorCode(error) {
  const detail = errorDetail(error)
  return String(detail?.code || error?.response?.data?.code || '').trim().toLowerCase()
}

function dependencyCounts(error) {
  const detail = errorDetail(error)
  return detail?.dependencies || detail?.dependency_counts || error?.response?.data?.dependencies || null
}

export function isPlanDependencyConflict(error) {
  const code = errorCode(error)
  if (['plan_has_dependencies', 'plan_in_use', 'plan_delete_conflict'].includes(code)) return true

  const detail = errorDetail(error)
  const message = typeof detail === 'string' ? detail : detail?.message
  if (/plan has licenses|card batches|commission rules/i.test(String(message || ''))) return true

  return Number(error?.response?.status) === 409 && Boolean(dependencyCounts(error))
}

export function formatPlanDependencies(error) {
  const counts = dependencyCounts(error)
  if (!counts || typeof counts !== 'object') return ''

  const totals = new Map()
  for (const [key, value] of Object.entries(counts)) {
    const label = dependencyLabels[key]
    const count = Number(value)
    if (!label || !Number.isFinite(count) || count <= 0) continue
    totals.set(label, (totals.get(label) || 0) + count)
  }
  return [...totals].map(([label, count]) => `${label} ${count} 条`).join('、')
}

export function getPlanDeleteError(error, fallback = '套餐删除失败') {
  if (isPlanDependencyConflict(error)) {
    const summary = formatPlanDependencies(error)
    return summary
      ? `该套餐已有${summary}。为保留历史数据，不能永久删除。`
      : PLAN_DELETE_DEPENDENCY_FALLBACK
  }

  const message = getApiError(error, fallback)
  if (/^plan not found$/i.test(message)) return '套餐不存在或已被删除'
  return message
}
