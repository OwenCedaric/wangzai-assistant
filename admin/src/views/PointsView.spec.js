import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  packages: { list: vi.fn(), create: vi.fn(), update: vi.fn(), stopSales: vi.fn() },
  wallets: { list: vi.fn(), adjust: vi.fn() },
  ledger: { list: vi.fn() },
  products: { list: vi.fn() },
  projects: { list: vi.fn() },
  rateCards: { list: vi.fn(), create: vi.fn(), disable: vi.fn() },
  reconciliations: { list: vi.fn(), reconcile: vi.fn() },
  apiPool: { providers: vi.fn(), models: vi.fn() },
}))

vi.mock('../api/admin.js', () => ({
  pointPackagesApi: api.packages,
  pointWalletsApi: api.wallets,
  pointLedgerApi: api.ledger,
  productsApi: api.products,
  projectsApi: api.projects,
  paidCapabilityRateCardsApi: api.rateCards,
  paidCapabilityReconciliationsApi: api.reconciliations,
  apiPoolApi: api.apiPool,
}))

import PointsView from './PointsView.vue'
import PaidCapabilityReconciliationDialog from '../components/points/PaidCapabilityReconciliationDialog.vue'

const pointPackage = {
  id: 9,
  project_id: 1,
  project_code: 'wangzai_desktop',
  product_id: 2,
  product_name: '旺崽桌面端',
  name: '专业积分包',
  points_amount: 41895,
  sale_price_cent: 3990,
  currency: 'CNY',
  validity_days: 30,
  customer_description: '适合日常运营',
  featured: true,
  display_order: 4,
  online_sale_enabled: true,
  status: 'active',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
}
const wallet = {
  wallet_id: 5,
  user_id: 12,
  project_id: 1,
  project_code: 'wangzai_desktop',
  username: 'email_demo',
  email: 'demo@example.com',
  phone_masked: null,
  balance_points: 41000,
  lifetime_credited_points: 41895,
  lifetime_spent_points: 895,
  next_expiry: '2026-09-01T00:00:00Z',
  next_expiring_points: 41000,
  updated_at: '2026-08-01T00:00:00Z',
}
const reconciliationJob = {
  id: 'job-unknown-1',
  user_id: 12,
  project_id: 1,
  capability: 'text.product-description',
  version: 1,
  status: 'reconciliation_required',
  error_code: 'PROVIDER_TIMEOUT',
  reserved_points: 42,
  settled_points: 0,
  released_points: 0,
  accepted_at: '2026-08-01T00:00:00Z',
  completed_at: '2026-08-01T00:00:10Z',
}

async function mountView() {
  const wrapper = mount(PointsView, { global: { plugins: [ElementPlus] } })
  await flushPromises()
  return wrapper
}

describe('PointsView', () => {
  beforeEach(() => {
    api.packages.list.mockResolvedValue({ items: [pointPackage], total: 1 })
    api.wallets.list.mockResolvedValue({ items: [wallet], total: 1 })
    api.ledger.list.mockResolvedValue({
      items: [{
        id: 1,
        wallet_id: 5,
        user_id: 12,
        project_id: 1,
        delta_points: 41895,
        balance_after: 41895,
        event_type: 'purchase_credit',
        reference_type: 'order',
        reference_id: 'LC001',
        reason: '购买积分套餐',
        details: {},
        created_at: '2026-08-01T00:00:00Z',
      }],
      total: 1,
    })
    api.products.list.mockResolvedValue({ items: [{ id: 2, name: '旺崽桌面端', version: '1.0' }], total: 1 })
    api.projects.list.mockResolvedValue({ items: [{ id: 1, name: '旺崽桌面端' }], total: 1 })
    api.rateCards.list.mockResolvedValue({ items: [], total: 0 })
    api.reconciliations.list.mockResolvedValue({ items: [], total: 0 })
    api.apiPool.providers.mockResolvedValue([])
    api.apiPool.models.mockResolvedValue([])
    api.packages.stopSales.mockResolvedValue({ ...pointPackage, online_sale_enabled: false })
    vi.spyOn(ElMessage, 'success').mockImplementation(() => undefined)
    vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('loads packages and stops sales without deleting history', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm')
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('专业积分包')
    expect(wrapper.text()).toContain('41,895 积分')
    const stopButton = wrapper.findAll('button').find((button) => button.text().trim() === '停售')
    await stopButton.trigger('click')
    await flushPromises()

    expect(api.packages.stopSales).toHaveBeenCalledWith(9)
    expect(api.packages.list).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows isolated wallets and loads their ledger', async () => {
    const wrapper = await mountView()
    const walletTab = wrapper.findAll('.el-tabs__item').find((item) => item.text().includes('用户钱包'))
    await walletTab.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('demo@example.com')
    expect(wrapper.text()).toContain('41,000')
    const ledgerButton = wrapper.findAll('button').find((button) => button.text().trim() === '流水')
    await ledgerButton.trigger('click')
    await flushPromises()

    expect(api.ledger.list).toHaveBeenCalledWith(expect.objectContaining({ wallet_id: 5 }))
    expect(wrapper.text()).toContain('购买积分套餐')
    wrapper.unmount()
  })

  it('routes unknown provider outcomes through the admin reconciliation action', async () => {
    api.reconciliations.list.mockResolvedValue({ items: [reconciliationJob], total: 1 })
    api.reconciliations.reconcile.mockResolvedValue({
      ...reconciliationJob,
      status: 'failed_unbilled',
      released_points: 42,
    })
    const wrapper = await mountView()
    const tab = wrapper.findAll('.el-tabs__item').find((item) => item.text().includes('待人工对账'))
    await tab.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('PROVIDER_TIMEOUT')
    const action = wrapper.findAll('button').find((button) => button.text().trim() === '核对并处理')
    await action.trigger('click')
    await flushPromises()
    wrapper.findComponent(PaidCapabilityReconciliationDialog).vm.$emit('submit', {
      decision: 'release_unbilled',
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      units: 0,
      provider_request_id: null,
      note: 'provider confirms no charge',
    })
    await flushPromises()

    expect(api.reconciliations.reconcile).toHaveBeenCalledWith(
      'job-unknown-1',
      expect.objectContaining({ decision: 'release_unbilled' }),
    )
    expect(api.wallets.list).toHaveBeenCalled()
    expect(api.ledger.list).toHaveBeenCalled()
    wrapper.unmount()
  })
})
