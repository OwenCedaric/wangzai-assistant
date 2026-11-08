import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock('./http.js', () => ({ http }))

import { plansApi } from './admin.js'

describe('plans API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the dedicated server action when stopping online sales', async () => {
    http.post.mockResolvedValue({ id: 7, online_sale_enabled: false, status: 'active' })

    await expect(plansApi.stopSales(7)).resolves.toMatchObject({
      id: 7, online_sale_enabled: false, status: 'active',
    })
    expect(http.post).toHaveBeenCalledWith('/api/admin/plans/7/stop-sales')
  })
})
