import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'

import ApiQuickConnectDialog from './ApiQuickConnectDialog.vue'

describe('ApiQuickConnectDialog', () => {
  it('only asks for the interface URL and API key', async () => {
    const wrapper = mount(ApiQuickConnectDialog, {
      props: { modelValue: true, submitting: false },
      global: { plugins: [ElementPlus], stubs: { teleport: true } },
    })
    await flushPromises()

    const inputs = wrapper.findAll('input')
    expect(inputs).toHaveLength(2)
    await inputs[0].setValue('https://api.example.com/v1')
    await inputs[1].setValue('sk-test-simple-connect')
    await wrapper.find('.el-button--primary').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('submit')?.[0]).toEqual([{
      base_url: 'https://api.example.com/v1',
      api_key: 'sk-test-simple-connect',
    }])
    expect(wrapper.text()).not.toContain('供应商代码')
    expect(wrapper.text()).not.toContain('模型代码')
    expect(wrapper.text()).not.toContain('并发')
    wrapper.unmount()
  })
})
