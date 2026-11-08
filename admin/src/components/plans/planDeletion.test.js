import { describe, expect, it } from 'vitest'
import {
  PLAN_DELETE_DEPENDENCY_FALLBACK,
  formatPlanDependencies,
  getPlanDeleteError,
  isPlanDependencyConflict,
} from './planDeletion.js'

describe('plan deletion errors', () => {
  it('localizes the legacy English dependency error', () => {
    const error = {
      response: {
        status: 409,
        data: { detail: 'Plan has licenses, card batches, orders, or commission rules' },
      },
    }

    expect(isPlanDependencyConflict(error)).toBe(true)
    expect(getPlanDeleteError(error)).toBe(PLAN_DELETE_DEPENDENCY_FALLBACK)
    expect(getPlanDeleteError(error)).not.toContain('Plan has')
  })

  it('shows dependency counts returned by the structured API error', () => {
    const error = {
      response: {
        status: 409,
        data: {
          detail: {
            code: 'plan_has_dependencies',
            dependencies: { licenses: 2, card_batches: 1, orders: 3, commission_rules: 0 },
          },
        },
      },
    }

    expect(formatPlanDependencies(error)).toBe('授权 2 条、卡密批次 1 条、订单 3 条')
    expect(getPlanDeleteError(error)).toBe('该套餐已有授权 2 条、卡密批次 1 条、订单 3 条。为保留历史数据，不能永久删除。')
  })

  it('localizes a missing plan without hiding unrelated server errors', () => {
    expect(getPlanDeleteError({ response: { data: { detail: 'Plan not found' } } })).toBe('套餐不存在或已被删除')
    expect(getPlanDeleteError({ response: { data: { detail: '数据库暂时不可用' } } })).toBe('数据库暂时不可用')
  })
})
