import { describe, expect, it } from 'vitest'
import { formatUsageTokens, formatUsagePercent } from '@/utils/usage-display'

describe('localized usage numbers', () => {
  it('keeps token scales and precision while using the selected language', () => {
    expect(formatUsageTokens(999, 'zh')).toBe('999')
    expect(formatUsageTokens(1250, 'en')).toBe('1.3K')
    expect(formatUsageTokens(1_500_000, 'fr')).toBe('1,50M')
    expect(formatUsageTokens(2_500_000_000, 'de')).toBe('2,50B')
    expect(formatUsageTokens(1250, 'ar-EG')).toBe('١٫٣K')
  })

  it('formats percentages with locale punctuation and spacing', () => {
    expect(formatUsagePercent(12.5, 'en')).toBe('12.5%')
    expect(formatUsagePercent(12.5, 'zh')).toBe('12.5%')
    expect(formatUsagePercent(12.5, 'fr').replace(/\s/g, ' ')).toBe('12,5 %')
  })
})
