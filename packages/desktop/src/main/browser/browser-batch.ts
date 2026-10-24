import type { BrowserBatchAction } from './browser-types'

export const MAX_BROWSER_BATCH_ACTIONS = 50
export const BROWSER_BATCH_TIMEOUT_MS = 30_000

// Validate the entire request before any page interaction takes place.
export function parseBrowserBatchActions(value: unknown): BrowserBatchAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BROWSER_BATCH_ACTIONS) {
    throw new Error(`actions must contain 1 to ${MAX_BROWSER_BATCH_ACTIONS} browser actions`)
  }
  return value.map((item, index) => {
    const invalid = () => new Error(`Invalid browser batch action at index ${index}`)
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid()
    const row = item as Record<string, unknown>
    const fields: Record<string, string[]> = {
      click: ['action', 'ref'], type: ['action', 'ref', 'text'], hover: ['action', 'ref'], select: ['action', 'ref', 'value'],
      press: ['action', 'key'], scroll: ['action', 'direction', 'pixels'],
    }
    const allowed = typeof row.action === 'string' && Object.hasOwn(fields, row.action) ? fields[row.action] : undefined
    if (!allowed || Object.keys(row).some(key => !allowed.includes(key))) throw invalid()
    switch (row.action) {
      case 'click':
      case 'type':
      case 'hover':
      case 'select': {
        if (typeof row.ref !== 'string' || !/^@e[1-9]\d*$/.test(row.ref) || row.ref.length > 32) throw invalid()
        if (row.action === 'click' || row.action === 'hover') return { action: row.action, ref: row.ref }
        if (row.action === 'select') {
          if (typeof row.value !== 'string' || row.value.length > 1000) throw invalid()
          return { action: 'select', ref: row.ref, value: row.value }
        }
        if (typeof row.text !== 'string' || row.text.length > 100_000) throw invalid()
        return { action: 'type', ref: row.ref, text: row.text }
      }
      case 'press':
        if (typeof row.key !== 'string' || !row.key.trim() || row.key.length > 64) throw invalid()
        return { action: 'press', key: row.key }
      case 'scroll':
        if (!['up', 'down', 'left', 'right'].includes(String(row.direction))) throw invalid()
        if (row.pixels !== undefined && (typeof row.pixels !== 'number' || !Number.isFinite(row.pixels) || row.pixels < 1 || row.pixels > 10_000)) throw invalid()
        return { action: 'scroll', direction: row.direction as 'up' | 'down' | 'left' | 'right', ...(row.pixels === undefined ? {} : { pixels: row.pixels as number }) }
      default:
        throw invalid()
    }
  })
}
