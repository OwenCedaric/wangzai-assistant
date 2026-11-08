import { describe, expect, it } from 'vitest'
import {
  centToYuan,
  fulfillmentLabel,
  makeChannelCode,
  maskedPhone,
  paymentProviderLabel,
  yuanToCent,
} from './commerce.js'

describe('commerce presentation helpers', () => {
  it('generates a delivery-safe channel identifier without creating a token', () => {
    expect(makeChannelCode(new Uint8Array([1, 2, 10, 254, 255]))).toBe('CH_01020AFEFF')
  })

  it('localizes provider and fulfillment status', () => {
    expect(paymentProviderLabel('wechat')).toBe('微信支付')
    expect(paymentProviderLabel('development')).toBe('开发模拟支付')
    expect(fulfillmentLabel({ status: 'paid' })).toBe('待履约')
    expect(fulfillmentLabel({ status: 'paid', fulfilled_at: '2026-01-01' })).toBe('已履约')
    expect(fulfillmentLabel({ status: 'refunded' })).toBe('已退款')
  })

  it('masks a phone number while retaining an already masked value', () => {
    expect(maskedPhone('13800138000')).toBe('138****8000')
    expect(maskedPhone('138****8000')).toBe('138****8000')
  })

  it('converts online sale amounts without floating point cents', () => {
    expect(yuanToCent(299.99)).toBe(29999)
    expect(centToYuan(29999)).toBe(299.99)
  })
})
