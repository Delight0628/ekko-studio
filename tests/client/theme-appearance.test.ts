import { describe, expect, it } from 'vitest'
import { normalizeThemeAppearance } from '../../packages/shared/theme-appearance'
import { resolveAppearance } from '@/styles/theme-appearance'
import { editorTheme, terminalTheme } from '@/styles/theme-integrations'
import { getThemeOverrides } from '@/styles/theme'

const defaults = { fontSize: 14, textColor: null, accentColor: null }

describe('appearance inheritance and native adapters', () => {
  it('preserves preset surfaces until a property is explicitly configured', () => {
    const theme = resolveAppearance(defaults, false)
    expect(theme.variables['--theme-card-bg']).toBeUndefined()
    expect(theme.variables['--radius-component']).toBeUndefined()
  })

  it('allows zero opacity, blur, radius and shadow; local values override global values', () => {
    const appearance = normalizeThemeAppearance({ global: { opacity: 0.6, radius: 12, backgroundColor: '#AABBCC' }, regions: { input: { opacity: 0, radius: 0, blur: 0, shadow: 0 } } }, true)
    const theme = resolveAppearance({ ...defaults, appearance }, false)
    expect(theme.variables).toMatchObject({
      '--theme-card-bg': 'rgba(170, 187, 204, 0.6)',
      '--theme-card-radius': '12px',
      '--theme-input-bg': 'rgba(170, 187, 204, 0)',
      '--theme-input-radius': '0px',
      '--theme-input-filter': 'blur(0px) saturate(1.1)',
      '--theme-input-shadow': 'none',
    })
    delete appearance.regions.input
    expect(resolveAppearance({ ...defaults, appearance }, false).variables['--theme-input-radius']).toBe('12px')
  })

  it.each([
    { global: { opacity: -1 } }, { global: { opacity: 1.1 } },
    { global: { radius: '10' } }, { global: { fontFamily: 'url(https://bad.invalid)' } },
    { global: { backgroundColor: 'red; display:none' } },
    { regions: { missing: { opacity: 1 } } }, { regions: { input: { spacing: 1 } } },
    { css: 'body { display:none }' },
  ])('rejects invalid writes and tolerantly reads old settings: %j', value => {
    expect(() => normalizeThemeAppearance(value, true)).toThrow('Invalid theme appearance')
    expect(normalizeThemeAppearance(value)).toEqual({ global: {}, regions: {} })
  })

  it('keeps CSS, Naive UI, terminal and Monaco colors aligned', () => {
    const customization = { ...defaults, fontSize: 18, textColor: '#f0f0f0', accentColor: '#ff8833', appearance: {
      global: { backgroundColor: '#102030', radius: 20 }, regions: { content: { opacity: 0.5 }, input: { backgroundColor: '#203040', radius: 0 } },
    } }
    const overrides = getThemeOverrides(true, false, customization)
    expect(overrides.common).toMatchObject({ bodyColor: '#102030', fontSize: '18px', borderRadius: '20px' })
    expect(overrides.Input).toMatchObject({ color: 'rgba(32, 48, 64, 1)', borderRadius: '0px' })
    expect(terminalTheme(customization, true)).toMatchObject({ background: 'rgba(16, 32, 48, 0.5)', foreground: '#f0f0f0', cursor: '#ff8833' })
    expect(editorTheme(customization, true).colors).toMatchObject({ 'editor.background': '#10203080', 'editor.foreground': '#f0f0f0', 'editorCursor.foreground': '#ff8833' })
  })

  it('applies card overrides to description tables without an opaque header layer', () => {
    const customization = { ...defaults, appearance: {
      global: {}, regions: { card: { backgroundColor: '#336699', opacity: 0.25, radius: 16, borderColor: '#6688aa' } },
    } }
    for (const dark of [false, true]) {
      const overrides = getThemeOverrides(dark, false, customization)
      expect(overrides.Descriptions).toMatchObject({
        tdColor: 'rgba(51, 102, 153, 0.25)', tdColorModal: 'rgba(51, 102, 153, 0.25)', tdColorPopover: 'rgba(51, 102, 153, 0.25)',
        thColor: 'rgba(var(--text-primary-rgb), 0.04)', borderColor: '#6688aa', borderRadius: '16px',
      })
      expect(getThemeOverrides(dark, false, defaults).Descriptions?.tdColor).toBeUndefined()
    }
  })
})
