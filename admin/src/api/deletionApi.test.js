import { beforeEach, describe, expect, it, vi } from 'vitest'

const http = vi.hoisted(() => ({ delete: vi.fn() }))

vi.mock('./http.js', () => ({ http }))

import {
  agentsApi,
  cardBatchesApi,
  channelsApi,
  commissionsApi,
  devicesApi,
  licensesApi,
  ordersApi,
  pointLedgerApi,
  pointPackagesApi,
  pointWalletsApi,
  shopsApi,
  usageLogsApi,
  usersApi,
} from './admin.js'

describe('admin permanent deletion API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    http.delete.mockResolvedValue(null)
  })

  it('routes every management list deletion through the centralized endpoint catalog', async () => {
    await usersApi.remove(1)
    await licensesApi.remove(2)
    await cardBatchesApi.remove(3)
    await cardBatchesApi.removeCode(3, 4)
    await devicesApi.remove(5)
    await shopsApi.remove(6)
    await usageLogsApi.remove(7)
    await agentsApi.remove(8)
    await channelsApi.remove(9)
    await ordersApi.remove(10)
    await commissionsApi.remove(11)
    await pointPackagesApi.remove(12)
    await pointWalletsApi.remove(13)
    await pointLedgerApi.remove(14)

    expect(http.delete.mock.calls.map(([path]) => path)).toEqual([
      '/api/admin/users/1',
      '/api/admin/licenses/2',
      '/api/admin/card-batches/3',
      '/api/admin/card-batches/3/codes/4',
      '/api/admin/devices/5',
      '/api/admin/shops/6',
      '/api/admin/usage-logs/7',
      '/api/admin/agents/8',
      '/api/admin/channels/9',
      '/api/admin/orders/10',
      '/api/admin/commissions/11',
      '/api/admin/point-packages/12',
      '/api/admin/point-wallets/13',
      '/api/admin/point-ledger/14',
    ])
  })
})
