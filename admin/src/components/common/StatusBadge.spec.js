import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import StatusBadge from './StatusBadge.vue'

describe('StatusBadge', () => {
  it('renders a localized active status', () => {
    const wrapper = mount(StatusBadge, {
      props: { status: 'active' },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toBe('正常')
    expect(wrapper.find('.el-tag--success').exists()).toBe(true)
  })

  it('keeps unknown server statuses visible', () => {
    const wrapper = mount(StatusBadge, {
      props: { status: 'reviewing' },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toBe('reviewing')
  })

  it('uses commerce-specific status wording when a context is supplied', () => {
    const wrapper = mount(StatusBadge, {
      props: { status: 'pending', context: 'order' },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toBe('待支付')
  })
})
