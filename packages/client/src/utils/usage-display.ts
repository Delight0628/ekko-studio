export const USAGE_TOKEN_COLORS = {
  input: '#5c6bc0',
  output: '#26a69a',
  cache: '#f6ad55',
} as const

export function formatUsageTokens(value: number, locale = 'en'): string {
  const scale = value >= 1_000_000_000 ? { divisor: 1_000_000_000, digits: 2, suffix: 'B' }
    : value >= 1_000_000 ? { divisor: 1_000_000, digits: 2, suffix: 'M' }
      : value >= 1_000 ? { divisor: 1_000, digits: 1, suffix: 'K' }
        : { divisor: 1, digits: 0, suffix: '' }
  return (value / scale.divisor).toLocaleString(locale, {
    minimumFractionDigits: scale.digits, maximumFractionDigits: scale.digits, useGrouping: false,
  }) + scale.suffix
}

export function formatUsagePercent(value: number, locale = 'en'): string {
  return (value / 100).toLocaleString(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
}
