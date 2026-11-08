import { describe, expect, it } from 'vitest'
import { formatCentAmount, formatRateBps, yuanToCent } from './formatters.js'

describe('commerce formatters', () => {
  it('formats integer cents as yuan without floating point input', () => {
    expect(formatCentAmount(1299)).toContain('12.99')
    expect(formatCentAmount(null)).toBe('—')
  })

  it('formats basis points and converts a yuan form value back to cents', () => {
    expect(formatRateBps(1250)).toBe('12.5%')
    expect(yuanToCent('19.99')).toBe(1999)
    expect(yuanToCent('')).toBeUndefined()
  })
})
