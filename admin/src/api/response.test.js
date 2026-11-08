import { describe, expect, it } from 'vitest'
import { getApiError, normalizeList } from './response.js'

describe('API response helpers', () => {
  it('normalizes the backend pagination contract', () => {
    expect(normalizeList({ items: [{ id: 1 }], total: 8, page: 2, page_size: 10 })).toEqual({
      items: [{ id: 1 }], total: 8, page: 2, pageSize: 10,
    })
  })

  it('accepts nested data and plain arrays for gateway compatibility', () => {
    expect(normalizeList({ data: { items: [1, 2], total: 2 } }).items).toEqual([1, 2])
    expect(normalizeList(['a']).total).toBe(1)
  })

  it('strips markup from API errors before displaying them', () => {
    const error = { response: { data: { detail: '<b>账号无效</b><script>bad()</script>' } } }
    expect(getApiError(error)).toBe('账号无效bad()')
  })
})
