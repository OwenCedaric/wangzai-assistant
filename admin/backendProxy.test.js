import { describe, expect, it } from 'vitest'
import { createBackendProxy } from './backendProxy.js'

describe('admin backend proxy transport', () => {
  it('keeps certificate verification enabled for local and remote HTTPS', () => {
    for (const url of ['https://127.0.0.1:18443', 'https://license.example.com']) {
      expect(createBackendProxy(url)).toMatchObject({ target: url, secure: true })
    }
    expect(createBackendProxy('http://127.0.0.1:8000').target).toBe('http://127.0.0.1:8000')
  })
  it('rejects remote plaintext, embedded credentials and URL tokens', () => {
    for (const url of ['http://license.example.com', 'https://name:secret@example.com', 'https://example.com/?token=secret', 'https://example.com/#secret', 'https://example.com/api']) {
      expect(() => createBackendProxy(url)).toThrow()
    }
  })
  it('fails on missing CA instead of disabling TLS validation', () => {
    expect(() => createBackendProxy('https://127.0.0.1:18443', 'missing-admin-fixture-ca.pem')).toThrow()
    expect(() => createBackendProxy('http://127.0.0.1:8000', 'missing-admin-fixture-ca.pem')).toThrow('ADMIN_CA_REQUIRES_HTTPS')
  })
})
