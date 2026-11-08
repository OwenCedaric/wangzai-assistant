import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElInputNumber } from 'element-plus'
import { afterEach, describe, expect, it } from 'vitest'

import PlanFormDialog from './PlanFormDialog.vue'

const product = { id: 2, project_id: 1, name: '桌面端', version: '1.0' }
const plan = {
  id: 7,
  product_id: 2,
  name: '专业版年卡',
  price: 299,
  sale_price_cent: 29900,
  online_sale_enabled: true,
  duration_days: 365,
  max_devices: 2,
  max_shops: 5,
  offline_hours: 0,
  status: 'active',
  is_trial: false,
  permission_ids: [],
}

async function mountDialog(props = {}) {
  const wrapper = mount(PlanFormDialog, {
    attachTo: document.body,
    props: {
      modelValue: false,
      products: [product],
      permissions: [],
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
  await wrapper.setProps({ modelValue: true })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PlanFormDialog offline access', () => {
  it('defaults new plans to online-only access', async () => {
    const wrapper = await mountDialog()

    expect(document.body.textContent).toContain('允许离线使用（小时）')
    expect(document.body.textContent).toContain('禁止离线使用（必须联网）')
    expect(document.body.textContent).toContain('推荐设置')
    const offlineInput = wrapper
      .findAllComponents(ElInputNumber)
      .find((item) => item.props('max') === 168)
    expect(offlineInput.props('modelValue')).toBe(0)
    expect(offlineInput.props('min')).toBe(0)

    wrapper.unmount()
  })

  it('preserves and submits zero offline hours when editing', async () => {
    const wrapper = await mountDialog({ plan })
    const saveButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '保存套餐')

    saveButton.click()
    await flushPromises()

    expect(wrapper.emitted('submit')).toHaveLength(1)
    expect(wrapper.emitted('submit')[0][0]).toMatchObject({
      product_id: 2,
      name: '专业版年卡',
      offline_hours: 0,
    })

    wrapper.unmount()
  })

  it('uses the fixed standard monthly shop-card contract', async () => {
    const wrapper = await mountDialog({
      plan: {
        ...plan,
        name: '标准店铺月卡',
        price: 50,
        sale_price_cent: 5000,
        duration_days: 30,
        max_shops: 1,
        license_role: 'shop_standard_monthly',
      },
    })
    expect(document.body.textContent).toContain('标准月卡固定 50 元、30 天、1 个 Ozon 店铺')

    const saveButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '保存套餐')
    saveButton.click()
    await flushPromises()

    expect(wrapper.emitted('submit')[0][0]).toMatchObject({
      license_role: 'shop_standard_monthly',
      price: 50,
      sale_price_cent: 5000,
      duration_days: 30,
      max_shops: 1,
      is_trial: false,
    })
    wrapper.unmount()
  })

  it('uses the fixed one-time introductory shop-card contract', async () => {
    const wrapper = await mountDialog({
      plan: {
        ...plan,
        name: '首店首月卡',
        price: 19.9,
        sale_price_cent: 1990,
        duration_days: 30,
        max_shops: 1,
        license_role: 'shop_intro',
      },
    })
    expect(document.body.textContent).toContain('每个账号终身只能使用一次')

    const saveButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '保存套餐')
    saveButton.click()
    await flushPromises()

    expect(wrapper.emitted('submit')[0][0]).toMatchObject({
      license_role: 'shop_intro',
      price: 19.9,
      sale_price_cent: 1990,
      duration_days: 30,
      max_shops: 1,
      is_trial: false,
    })
    wrapper.unmount()
  })

  it('uses the fixed six-hundred-yuan annual shop-card contract', async () => {
    const wrapper = await mountDialog({
      plan: {
        ...plan,
        name: '标准店铺年卡',
        price: 600,
        sale_price_cent: 60000,
        duration_days: 365,
        max_shops: 1,
        license_role: 'shop_standard_annual',
      },
    })
    expect(document.body.textContent).toContain('按 50 元/月固定为 600 元、365 天')

    const saveButton = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '保存套餐')
    saveButton.click()
    await flushPromises()

    expect(wrapper.emitted('submit')[0][0]).toMatchObject({
      license_role: 'shop_standard_annual',
      price: 600,
      sale_price_cent: 60000,
      duration_days: 365,
      max_shops: 1,
    })
    wrapper.unmount()
  })
})
