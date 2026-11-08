import { readFileSync } from 'node:fs'
import { Agent } from 'node:https'

export function createBackendProxy(target, caFile = '') {
  const url = new URL(target)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ADMIN_BACKEND_URL_INVALID')
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('ADMIN_REMOTE_BACKEND_REQUIRES_HTTPS')
  }
  if (caFile && url.protocol !== 'https:') throw new Error('ADMIN_CA_REQUIRES_HTTPS')
  return {
    target: url.origin,
    changeOrigin: true,
    secure: true,
    ...(caFile ? { agent: new Agent({ ca: readFileSync(caFile), rejectUnauthorized: true }) } : {}),
  }
}
