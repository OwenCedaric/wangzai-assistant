import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  plans: {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), stopSales: vi.fn(), remove: vi.fn(),
  },
  products: { list: vi.fn() },
  projects: { list: vi.fn() },
  permissions: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))

vi.mock('../api/admin.js', () => ({
  plansApi: api.plans,
  productsApi: api.products,
  projectsApi: api.projects,
  permissionsApi: api.permissions,
}))

import PlansView from './PlansView.vue'

const onlinePlan = {
  id: 7,
  product_id: 2,
  name: '专业版年卡',
  price: 299,
  sale_price_cent: 29900,
  online_sale_enabled: true,
  duration_days: 365,
  max_devices: 2,
  max_shops: 5,
  status: 'active',
  permissions: [],
}

function buttonByText(wrapper, text) {
  return wrapper.findAll('button').find((button) => button.text().trim() === text)
}

async function mountView() {
  const wrapper = mount(PlansView, { global: { plugins: [ElementPlus] } })
  await flushPromises()
  return wrapper
}

describe('PlansView lifecycle actions', () => {
  beforeEach(() => {
    api.plans.list.mockResolvedValue({ items: [onlinePlan], total: 1 })
    api.plans.stopSales.mockResolvedValue({ ...onlinePlan, online_sale_enabled: false })
    api.plans.remove.mockResolvedValue(undefined)
    api.products.list.mockResolvedValue({ items: [{ id: 2, name: '桌面端', version: '1.0' }], total: 1 })
    api.projects.list.mockResolvedValue({ items: [], total: 0 })
    api.permissions.list.mockResolvedValue({ items: [], total: 0 })
    vi.spyOn(ElMessage, 'success').mockImplementation(() => undefined)
    vi.spyOn(ElMessage, 'warning').mockImplementation(() => undefined)
    vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('stops online sales without disabling the plan status', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm')
    const wrapper = await mountView()

    expect(wrapper.text()).toContain('停售只会关闭新用户在线购买')
    await buttonByText(wrapper, '停售').trigger('click')
    await flushPromises()

    expect(api.plans.stopSales).toHaveBeenCalledWith(7)
    expect(api.plans.update).not.toHaveBeenCalled()
    expect(api.plans.remove).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('offers safe delisting when permanent deletion finds historical data', async () => {
    const dependencyError = {
      response: {
        status: 409,
        data: {
          detail: {
            code: 'PLAN_IN_USE',
            dependencies: { licenses: 2, card_batches: 1, activation_codes: 2, orders: 3, commission_rules: 0 },
            recommended_action: 'STOP_ONLINE_SALES',
          },
        },
      },
    }
    api.plans.remove.mockRejectedValue(dependencyError)
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
      .mockResolvedValueOnce('confirm')
      .mockResolvedValueOnce('confirm')
    const wrapper = await mountView()

    await buttonByText(wrapper, '删除').trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1][0]).toContain('不能永久删除')
    expect(confirm.mock.calls[1][0]).toContain('授权 2 条')
    expect(confirm.mock.calls[1][0]).toContain('订单 3 条')
    expect(confirm.mock.calls[1][0]).not.toContain('Plan has')
    expect(api.plans.stopSales).toHaveBeenCalledWith(7)
    wrapper.unmount()
  })
})
