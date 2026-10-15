// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { UserThemeSettings } from '@/api/studio/theme'

const api = vi.hoisted(() => ({
  updateThemeSettings: vi.fn(), fetchThemeSettings: vi.fn(), fetchThemeBackgroundBlob: vi.fn(),
  clearThemeBackgroundCache: vi.fn(), deleteThemeBackground: vi.fn(), uploadThemeBackground: vi.fn(),
}))
vi.mock('@/api/studio/theme', () => api)
const defaults: UserThemeSettings = { fontSize: 14, textColor: null, accentColor: null, appearance: { global: {}, regions: {} }, background: null, updatedAt: 0 }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('theme preview and persistence ordering', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); localStorage.clear()
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList))
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('serializes saves and never replaces a newer live preview with an older response', async () => {
    const first = deferred<UserThemeSettings>(), second = deferred<UserThemeSettings>()
    api.updateThemeSettings.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const save1 = theme.saveThemeCustomization({ fontSize: 16 })
    const save2 = theme.saveThemeCustomization({ fontSize: 18 })
    await flushPromises()
    expect(api.updateThemeSettings).toHaveBeenCalledTimes(1)
    expect(theme.fontSize.value).toBe(18)
    first.resolve({ ...defaults, fontSize: 16 })
    await save1; await flushPromises()
    expect(api.updateThemeSettings).toHaveBeenCalledTimes(2)
    expect(theme.fontSize.value).toBe(18)
    theme.previewThemeSettings({ fontSize: 20 })
    second.resolve({ ...defaults, fontSize: 18 })
    await save2
    expect(theme.fontSize.value).toBe(20)
    expect(JSON.parse(localStorage.getItem('hermes_theme_customization_v1:1')!).fontSize).toBe(18)
  })

  it('rolls a failed last save back to the last committed appearance and clears stale CSS', async () => {
    api.updateThemeSettings.mockRejectedValueOnce(new Error('offline'))
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const saving = theme.saveThemeCustomization({ appearance: { global: { opacity: 0.2, radius: 22 }, regions: {} } })
    expect(document.documentElement.style.getPropertyValue('--theme-card-radius')).toBe('22px')
    await expect(saving).rejects.toThrow('offline')
    expect(theme.appearance.value).toEqual({ global: {}, regions: {} })
    expect(document.documentElement.style.getPropertyValue('--theme-card-radius')).toBe('')
    expect(document.documentElement.classList.contains('theme-card-bg')).toBe(false)
  })

  it('ignores the previous account response after switching accounts', async () => {
    const request = deferred<UserThemeSettings>()
    api.updateThemeSettings.mockReturnValueOnce(request.promise)
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const saving = theme.saveThemeCustomization({ fontSize: 20 })
    await flushPromises()
    theme.activateUserTheme(2, { ...defaults, fontSize: 12 })
    request.resolve({ ...defaults, fontSize: 20 })
    await saving
    expect(theme.fontSize.value).toBe(12)
    expect(JSON.parse(localStorage.getItem('hermes_theme_customization_v1:2')!).fontSize).toBe(12)
  })

  it('keeps the wallpaper URL stable across appearance saves and preserves a preview during upload', async () => {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:theme-test')
      static revokeObjectURL = vi.fn()
    })
    const background = { name: 'wall.png', mime: 'image/png', updatedAt: 10 }
    api.fetchThemeBackgroundBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    api.updateThemeSettings.mockResolvedValue({ ...defaults, fontSize: 16, background })
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, { ...defaults, background })
    await flushPromises()
    await theme.saveThemeCustomization({ fontSize: 16 })
    expect(api.fetchThemeBackgroundBlob).toHaveBeenCalledTimes(1)
    const upload = deferred<UserThemeSettings>()
    api.uploadThemeBackground.mockReturnValueOnce(upload.promise)
    const uploading = theme.uploadBackground(new File(['image'], 'new.png'))
    await flushPromises()
    theme.previewThemeSettings({ fontSize: 20 })
    upload.resolve({ ...defaults, fontSize: 16, background: { ...background, updatedAt: 20 } })
    await uploading
    expect(theme.fontSize.value).toBe(20)
    expect(api.fetchThemeBackgroundBlob).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem('hermes_theme_customization_v1:1')!).fontSize).toBe(16)
  })

  it('ignores a stale initial fetch after a local preview', async () => {
    const request = deferred<UserThemeSettings>()
    api.fetchThemeSettings.mockReturnValueOnce(request.promise)
    const theme = (await import('@/composables/useTheme')).useTheme()
    theme.activateUserTheme(1, defaults)
    const loading = theme.syncThemeFromServer()
    theme.previewThemeSettings({ fontSize: 20 })
    request.resolve(defaults)
    await loading
    expect(theme.fontSize.value).toBe(20)
  })
})
