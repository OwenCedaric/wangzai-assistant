import { afterEach, describe, expect, it } from 'vitest'
import {
  apiEnvironments,
  findApiEnvironment,
  getActiveApiBaseUrl,
  getApiEnvironmentId,
  setApiEnvironment,
} from './apiEnvironment.js'

describe('admin api environment', () => {
  afterEach(() => setApiEnvironment('primary'))

  it('keeps primary and isolated test environments in a fixed allowlist', () => {
    expect(apiEnvironments.map((item) => item.id)).toEqual(['primary', 'test'])
    expect(findApiEnvironment('unknown').id).toBe('primary')
  })

  it('switches all requests to the isolated test proxy', () => {
    setApiEnvironment('test')
    expect(getApiEnvironmentId()).toBe('test')
    expect(getActiveApiBaseUrl()).toBe('/test-runtime')
  })
})
