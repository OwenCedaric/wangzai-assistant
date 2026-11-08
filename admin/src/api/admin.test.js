import { describe, expect, it } from 'vitest'
import { buildListQuery } from './admin.js'

describe('admin list query', () => {
  it('removes empty optional filters before sending integer query parameters', () => {
    expect(buildListQuery({ project_id: '', plan_id: null, user_id: undefined, page: 1 })).toEqual({
      page: 1,
    })
  })

  it('maps a populated keyword to the backend q parameter', () => {
    expect(buildListQuery({ keyword: '专业版', status: 'active', page_size: 20 })).toEqual({
      q: '专业版',
      status: 'active',
      page_size: 20,
    })
  })

  it('removes whitespace, empty arrays and NaN without dropping valid false or zero values', () => {
    expect(buildListQuery({ keyword: '  ', ids: [], offset: Number.NaN, enabled: false, amount: 0 })).toEqual({
      enabled: false,
      amount: 0,
    })
  })

  it('trims string filters before sending them', () => {
    expect(buildListQuery({ keyword: ' 订单  ', status: ' paid ' })).toEqual({ q: '订单', status: 'paid' })
  })
})
