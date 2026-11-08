export function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date).replaceAll('/', '-')
}

export function formatCurrency(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'CNY', minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(amount)
}

export function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0)
}

export function formatCentAmount(value, currency = 'CNY') {
  if (value === null || value === undefined || value === '') return '—'
  const cents = Number(value)
  if (!Number.isFinite(cents)) return '—'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: String(currency || 'CNY').toUpperCase(),
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(cents / 100)
}

export function formatRateBps(value) {
  const bps = Number(value)
  if (!Number.isFinite(bps)) return '—'
  return `${(bps / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`
}

export function yuanToCent(value) {
  if (value === '' || value === null || value === undefined) return undefined
  const amount = Number(value)
  if (!Number.isFinite(amount)) return undefined
  return Math.round((amount + Number.EPSILON) * 100)
}
