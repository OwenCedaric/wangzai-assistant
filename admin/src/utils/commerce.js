const providerLabels = Object.freeze({
  wechat: '微信支付', wechat_pay: '微信支付', alipay: '支付宝',
  development: '开发模拟支付', mock: '模拟支付',
})

export function paymentProviderLabel(value) {
  if (!value) return '—'
  const key = String(value).toLowerCase()
  return providerLabels[key] || String(value)
}

export function fulfillmentLabel(order) {
  if (order?.fulfilled_at || order?.status === 'fulfilled') return '已履约'
  if (order?.status === 'paid') return '待履约'
  if (order?.status === 'refunding') return '退款处理中'
  if (order?.status === 'refunded') return '已退款'
  if (['closed', 'failed'].includes(order?.status)) return '无需履约'
  return '等待支付'
}

export function makeChannelCode(bytes) {
  let source = bytes
  if (!source) {
    source = new Uint8Array(5)
    globalThis.crypto.getRandomValues(source)
  }
  const suffix = Array.from(source).map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `CH_${suffix}`
}

export function maskedPhone(value) {
  if (!value) return '—'
  const text = String(value)
  if (text.includes('*')) return text
  return text.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2')
}

export function yuanToCent(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0
}

export function centToYuan(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount / 100 : 0
}
