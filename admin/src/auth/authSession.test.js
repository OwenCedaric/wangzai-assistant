import { afterEach, describe, expect, it } from 'vitest'
import { clearAuthSession, getAccessToken, hasAuthSession, setAuthSession } from './authSession.js'

describe('in-memory auth session', () => {
  afterEach(clearAuthSession)

  it('stores the bearer token only in module memory', () => {
    setAuthSession({ access_token: 'test-runtime-token', user: { username: 'admin' } })

    expect(getAccessToken()).toBe('test-runtime-token')
    expect(hasAuthSession()).toBe(true)
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('clears the current session', () => {
    setAuthSession({ access_token: 'test-runtime-token' })
    clearAuthSession()
    expect(hasAuthSession()).toBe(false)
  })
})
