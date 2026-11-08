import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElInput, ElPagination } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import BatchCodesDialog from './BatchCodesDialog.vue'

const cardBatchesApiMock = vi.hoisted(() => ({
  revealedCodes: vi.fn(),
  searchRevealedCodes: vi.fn(),
  updateCodeStatus: vi.fn(),
}))

vi.mock('../../api/admin.js', () => ({ cardBatchesApi: cardBatchesApiMock }))

const batch = { id: 3, name: '专业版测试批次' }
const firstCode = {
  id: 31,
  card_key: '7EPH-6JLQ-ABCD-EFGH',
  code_prefix: '7EPH-6JLQ',
  status: 'unused',
  expires_at: null,
  activated_by_user_id: null,
  activated_license_id: null,
  activated_at: null,
  activated_license_expire_at: '2027-08-01T11:52:51Z',
  bound_shops: [{
    id: 7,
    license_id: 11,
    platform: 'ozon',
    shop_name: 'Ozon 1店',
    shop_id: '4616153',
    status: 'active',
  }],
}

let clipboardWrite

async function mountDialog() {
  const wrapper = mount(BatchCodesDialog, {
    attachTo: document.body,
    props: { modelValue: true, batch },
    global: { plugins: [ElementPlus] },
  })
  await flushPromises()
  return wrapper
}

async function setSearchValue(wrapper, value) {
  const input = wrapper.findComponent(ElInput)
  await input.setValue(value)
  return input
}

beforeEach(() => {
  clipboardWrite = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  })
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  cardBatchesApiMock.revealedCodes.mockReset()
  cardBatchesApiMock.searchRevealedCodes.mockReset()
  cardBatchesApiMock.updateCodeStatus.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('BatchCodesDialog', () => {
  it('shows complete card keys in a centered dialog and supports row/page copying', async () => {
    cardBatchesApiMock.revealedCodes.mockResolvedValue({
      items: [firstCode],
      total: 1,
      page: 1,
      page_size: 20,
    })

    const wrapper = await mountDialog()

    expect(cardBatchesApiMock.revealedCodes).toHaveBeenCalledWith(3, { page: 1, page_size: 20 })
    expect(document.body.querySelector('.batch-codes-dialog')).not.toBeNull()
    expect(document.body.querySelector('.el-drawer')).toBeNull()
    expect(document.body.textContent).toContain('7EPH-6JLQ-ABCD-EFGH')
    expect(document.body.textContent).toContain('Ozon 1店')
    expect(document.body.textContent).toContain('Ozon Client ID：4616153')
    expect(document.body.textContent).toContain('禁用')

    document.body.querySelector('.copy-code-button').click()
    await flushPromises()
    expect(clipboardWrite).toHaveBeenLastCalledWith('7EPH-6JLQ-ABCD-EFGH')

    document.body.querySelector('.copy-page-button').click()
    await flushPromises()
    expect(clipboardWrite).toHaveBeenLastCalledWith('7EPH-6JLQ-ABCD-EFGH')

    wrapper.unmount()
  })

  it('clears the previous page while the next page is loading', async () => {
    let resolveSecondPage
    cardBatchesApiMock.revealedCodes
      .mockResolvedValueOnce({ items: [firstCode], total: 40, page: 1, page_size: 20 })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondPage = resolve }))
    const wrapper = await mountDialog()

    wrapper.findComponent(ElPagination).vm.$emit('current-change', 2)
    await nextTick()
    expect(document.body.textContent).not.toContain('7EPH-6JLQ-ABCD-EFGH')

    const secondCode = { ...firstCode, id: 32, card_key: 'WA29-EMXV-2345-6789' }
    resolveSecondPage({ items: [secondCode], total: 40, page: 2, page_size: 20 })
    await flushPromises()

    expect(cardBatchesApiMock.revealedCodes).toHaveBeenLastCalledWith(3, { page: 2, page_size: 20 })
    expect(document.body.textContent).toContain('WA29-EMXV-2345-6789')
    wrapper.unmount()
  })

  it('searches on Enter, trims the query, and discards a late search response', async () => {
    let resolveFirstSearch
    let resolveSecondSearch
    cardBatchesApiMock.revealedCodes.mockResolvedValueOnce({
      items: [firstCode], total: 100, page: 1, page_size: 20,
    })
    cardBatchesApiMock.searchRevealedCodes
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstSearch = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecondSearch = resolve }))
    const wrapper = await mountDialog()

    let input = await setSearchValue(wrapper, ' 7EPH-6JLQ-ABCD-EFGH ')
    await input.find('input').trigger('keyup.enter')
    await nextTick()
    expect(cardBatchesApiMock.searchRevealedCodes).toHaveBeenLastCalledWith(3, {
      page: 1,
      page_size: 20,
      q: '7EPH-6JLQ-ABCD-EFGH',
    })
    expect(cardBatchesApiMock.revealedCodes).toHaveBeenCalledTimes(1)
    expect(cardBatchesApiMock.revealedCodes).toHaveBeenCalledWith(3, {
      page: 1,
      page_size: 20,
    })
    expect(input.props('maxlength')).toBe(128)
    expect(document.body.textContent).not.toContain('7EPH-6JLQ-ABCD-EFGH')

    input = await setSearchValue(wrapper, 'WA29')
    await input.find('input').trigger('keyup.enter')
    const secondCode = { ...firstCode, id: 32, card_key: 'WA29-EMXV-2345-6789' }
    resolveSecondSearch({ items: [secondCode], total: 1, page: 1, page_size: 20 })
    await flushPromises()
    resolveFirstSearch({ items: [firstCode], total: 1, page: 1, page_size: 20 })
    await flushPromises()

    expect(document.body.textContent).toContain('WA29-EMXV-2345-6789')
    expect(document.body.textContent).not.toContain('7EPH-6JLQ-ABCD-EFGH')
    wrapper.unmount()
  })

  it('search button resets pagination and clearing the input restores all codes', async () => {
    const secondCode = { ...firstCode, id: 32, card_key: 'WA29-EMXV-2345-6789' }
    cardBatchesApiMock.revealedCodes
      .mockResolvedValueOnce({ items: [firstCode], total: 40, page: 1, page_size: 20 })
      .mockResolvedValueOnce({ items: [secondCode], total: 40, page: 2, page_size: 20 })
      .mockResolvedValueOnce({ items: [firstCode, secondCode], total: 40, page: 1, page_size: 20 })
    cardBatchesApiMock.searchRevealedCodes.mockResolvedValueOnce({
      items: [firstCode], total: 1, page: 1, page_size: 20,
    })
    const wrapper = await mountDialog()

    wrapper.findComponent(ElPagination).vm.$emit('current-change', 2)
    await flushPromises()
    await setSearchValue(wrapper, '7EPH')
    document.body.querySelector('.search-button').click()
    await flushPromises()

    expect(cardBatchesApiMock.searchRevealedCodes).toHaveBeenLastCalledWith(3, {
      page: 1,
      page_size: 20,
      q: '7EPH',
    })
    expect(wrapper.findComponent(ElPagination).props('currentPage')).toBe(1)

    document.body.querySelector('.el-input__clear').click()
    await flushPromises()
    expect(cardBatchesApiMock.revealedCodes).toHaveBeenLastCalledWith(3, {
      page: 1,
      page_size: 20,
    })
    expect(document.body.textContent).toContain('WA29-EMXV-2345-6789')
    wrapper.unmount()
  })

  it('clears the search term before reopening the dialog', async () => {
    cardBatchesApiMock.revealedCodes.mockResolvedValue({
      items: [firstCode],
      total: 1,
      page: 1,
      page_size: 20,
    })
    cardBatchesApiMock.searchRevealedCodes.mockResolvedValue({
      items: [firstCode], total: 1, page: 1, page_size: 20,
    })
    const wrapper = await mountDialog()

    await setSearchValue(wrapper, '7EPH')
    document.body.querySelector('.search-button').click()
    await flushPromises()
    await wrapper.setProps({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    await flushPromises()

    expect(cardBatchesApiMock.revealedCodes).toHaveBeenLastCalledWith(3, {
      page: 1,
      page_size: 20,
    })
    expect(wrapper.findComponent(ElInput).props('modelValue')).toBe('')
    wrapper.unmount()
  })

  it('discards a late response and clears complete card keys after closing', async () => {
    let resolveRequest
    cardBatchesApiMock.revealedCodes.mockImplementation(
      () => new Promise((resolve) => { resolveRequest = resolve }),
    )
    const wrapper = await mountDialog()

    await wrapper.setProps({ modelValue: false })
    resolveRequest({ items: [firstCode], total: 1, page: 1, page_size: 20 })
    await flushPromises()

    expect(document.body.textContent).not.toContain('7EPH-6JLQ-ABCD-EFGH')
    wrapper.unmount()
  })
})
