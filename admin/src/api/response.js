export function normalizeList(payload, fallbackPage = 1, fallbackPageSize = 20) {
  const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const items = Array.isArray(source) ? source : Array.isArray(source?.items) ? source.items : []
  return {
    items,
    total: Number(source?.total ?? items.length) || 0,
    page: Number(source?.page ?? fallbackPage) || fallbackPage,
    pageSize: Number(source?.page_size ?? source?.pageSize ?? fallbackPageSize) || fallbackPageSize,
  }
}

export function normalizeItem(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload
}

export function getApiError(error, fallback = '请求失败，请稍后重试') {
  const detail = error?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return stripMarkup(detail.trim())
  if (Array.isArray(detail) && detail[0]?.msg) return stripMarkup(String(detail[0].msg))
  if (typeof error?.message === 'string' && error.message.trim()) return stripMarkup(error.message.trim())
  return fallback
}

function stripMarkup(value) {
  return value.replace(/<[^>]*>/g, '').slice(0, 240)
}
