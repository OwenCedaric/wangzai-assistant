import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  summary: vi.fn(), providers: vi.fn(), keys: vi.fn(), models: vi.fn(),
  autoConnect: vi.fn(),
  createProvider: vi.fn(), updateProvider: vi.fn(), removeProvider: vi.fn(),
  replaceProviderEndpoint: vi.fn(),
  createKey: vi.fn(), updateKey: vi.fn(), rotateKey: vi.fn(), removeKey: vi.fn(),
  createModel: vi.fn(), updateModel: vi.fn(), removeModel: vi.fn(),
}))
const crossBorder = vi.hoisted(() => ({ status: vi.fn(), saveSecret: vi.fn() }))

vi.mock('../api/admin.js', () => ({ apiPoolApi: api, crossBorderProviderApi: crossBorder }))

import ApiPoolView from './ApiPoolView.vue'

const provider = {
  id: 1, code: 'pool-text', name: '文本接口池', adapter: 'openai-compatible',
  base_url: 'https://api.openai.com/v1', auth_scheme: 'bearer',
  auth_header_name: 'Authorization', capability_kinds: ['text'], timeout_seconds: 60,
  priority: 100, status: 'active', key_count: 5, active_key_count: 5,
  model_count: 1, active_lease_count: 0,
}

describe('ApiPoolView', () => {
  beforeEach(() => {
    api.summary.mockResolvedValue({
      provider_count: 1, active_provider_count: 1, key_count: 5,
      available_key_count: 5, cooling_key_count: 0, invalid_key_count: 0,
      model_count: 1, active_lease_count: 0,
    })
    api.providers.mockResolvedValue([provider])
    api.keys.mockResolvedValue(Array.from({ length: 5 }, (_, index) => ({
      id: index + 1, provider_id: 1, label: `Key ${index + 1}`,
      masked_hint: `sk-a••••000${index}`, weight: 100, max_concurrency: 1,
      status: 'active', active_leases: 0, cooldown_until: null,
      success_count: 0, failure_count: 0, request_count: 0,
      consecutive_failures: 0, last_error_code: null,
    })))
    api.models.mockResolvedValue([{
      id: 1, provider_id: 1, capability_kind: 'text', model_code: 'gpt-5.6-sol',
      display_name: 'GPT 5.6 Sol', priority: 100, status: 'active',
    }])
    api.autoConnect.mockResolvedValue({
      provider, key_created: true, provider_created: false, discovered_model_count: 1,
    })
    api.replaceProviderEndpoint.mockResolvedValue({
      ...provider, base_url: 'https://new-api.example.com/v1',
    })
    crossBorder.status.mockResolvedValue({ configured: false, token_state_present: false })
    crossBorder.saveSecret.mockResolvedValue({ ok: true, configured: true })
    vi.spyOn(ElMessage, 'success').mockImplementation(() => undefined)
    vi.spyOn(ElMessage, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('shows provider, five isolated keys, and model catalog without secrets', async () => {
    const wrapper = mount(ApiPoolView, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    expect(wrapper.text()).toContain('文本接口池')
    expect(wrapper.text()).toContain('可用 Key')
    expect(wrapper.text()).toContain('5 / 5')
    expect(wrapper.text()).toContain('Key 5')
    expect(wrapper.text()).not.toContain('完整 API Key')
    expect(wrapper.text()).toContain('添加 API')
    expect(wrapper.text()).toContain('更换地址')
    expect(wrapper.text()).toContain('跨境巴士企业授权')
    expect(wrapper.text()).toContain('配置企业 API')

    const modelTab = wrapper.findAll('.el-tabs__item')
      .find((item) => item.text().includes('已识别模型'))
    await modelTab.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('GPT 5.6 Sol')
    expect(wrapper.text()).toContain('gpt-5.6-sol')
    wrapper.unmount()
  })
})
