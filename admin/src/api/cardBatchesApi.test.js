import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))

vi.mock('./http.js', () => ({ http }))

import { cardBatchesApi } from './admin.js'

describe('card batch revealed code API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('never puts a complete card key into GET query parameters', async () => {
    const cardKey = '7EPH-6JLQ-ABCD-EFGH'
    http.get.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 })

    await cardBatchesApi.revealedCodes(3, {
      page: 1,
      page_size: 20,
      q: cardKey,
    })

    expect(http.get).toHaveBeenCalledWith('/api/admin/card-batches/3/codes/revealed', {
      params: { page: 1, page_size: 20 },
    })
    expect(JSON.stringify(http.get.mock.calls)).not.toContain(cardKey)
  })

  it('sends sensitive searches in a POST body', async () => {
    const body = { q: '7EPH-6JLQ-ABCD-EFGH', page: 1, page_size: 20 }
    http.post.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 })

    await cardBatchesApi.searchRevealedCodes(3, body)

    expect(http.post).toHaveBeenCalledWith(
      '/api/admin/card-batches/3/codes/revealed/search',
      body,
    )
  })
})
