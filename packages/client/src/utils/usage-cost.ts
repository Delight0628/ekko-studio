export interface UsageCostCoverage { reported: number; estimated: number; unknown: number }
export type UsageCostState = 'unknown' | 'partial' | 'reported' | 'estimated' | 'mixed' | ''

export function usageCostState(amount: number, coverage?: UsageCostCoverage, hasActivity = true): UsageCostState {
  if (!coverage) return amount > 0 || !hasActivity ? '' : 'unknown'
  const known = coverage.reported + coverage.estimated
  if (!known) return coverage.unknown > 0 || hasActivity ? 'unknown' : ''
  if (coverage.unknown > 0) return 'partial'
  if (!coverage.reported) return 'estimated'
  return coverage.estimated > 0 ? 'mixed' : 'reported'
}

export function formatUsageCurrency(amount: number, locale = 'en'): string {
  return amount.toLocaleString(locale, {
    style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
}

export function formatUsageCost(amount: number, coverage?: UsageCostCoverage, hasActivity = true, locale = 'en'): string | null {
  if (usageCostState(amount, coverage, hasActivity) === 'unknown') return null
  return amount > 0 && amount < 0.01 ? `<${formatUsageCurrency(0.01, locale)}` : formatUsageCurrency(amount, locale)
}
