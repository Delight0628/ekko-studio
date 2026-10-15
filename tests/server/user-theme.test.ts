import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

describe('user theme storage', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/public/config')
    vi.resetModules()
  })

  async function initStore() {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    return {
      schemas,
      store: await import('../../packages/server/src/modules/studio/repositories/user-theme-store'),
    }
  }

  it('creates the user theme table and returns defaults', async () => {
    const { schemas, store } = await initStore()
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    ).get(schemas.USER_THEMES_TABLE)

    expect(table).toBeTruthy()
    expect(store.getUserTheme(4)).toMatchObject({
      userId: 4,
      fontSize: 14,
      textColor: null,
      accentColor: null,
      backgroundFilename: null,
    })
  })

  it('stores isolated theme settings for each user', async () => {
    const { store } = await initStore()

    const first = store.saveUserTheme(1, {
      fontSize: 18,
      textColor: '#123456',
      accentColor: '#abcdef',
    })
    const second = store.saveUserTheme(2, {
      fontSize: 12,
      accentColor: '#ff8800',
    })

    expect(first).toMatchObject({
      userId: 1,
      fontSize: 18,
      textColor: '#123456',
      accentColor: '#abcdef',
    })
    expect(second).toMatchObject({
      userId: 2,
      fontSize: 12,
      textColor: null,
      accentColor: '#ff8800',
    })
    expect(store.getUserTheme(1)).toMatchObject(first)
  })

  it('rejects invalid sizes and colors', async () => {
    const { store } = await initStore()

    expect(() => store.saveUserTheme(1, { fontSize: 30 }))
      .toThrow(/between 12 and 20/)
    expect(() => store.saveUserTheme(1, { textColor: 'red' }))
      .toThrow(/six-digit hex color/)
  })

  it('persists sparse regional overrides per user and resets inheritance', async () => {
    const { store } = await initStore()
    const appearance = { global: { backgroundColor: '#123456', opacity: 0.4 }, regions: { input: { radius: 0, opacity: 0 } } }
    store.saveUserTheme(1, { appearance })
    expect(store.getUserTheme(1).appearance).toEqual(appearance)
    expect(store.getUserTheme(2).appearance).toEqual({ global: {}, regions: {} })
    expect(() => store.saveUserTheme(1, { appearance: { global: { opacity: 2 } } })).toThrow('Invalid theme appearance')
    expect(store.getUserTheme(1).appearance).toEqual(appearance)
    expect(store.saveUserTheme(1, { appearance: null }).appearance).toEqual({ global: {}, regions: {} })
  })

  it('migrates legacy settings without losing colors or changing the wallpaper cache key on saves', async () => {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    db.exec(`CREATE TABLE ${schemas.USER_THEMES_TABLE} (
      user_id INTEGER PRIMARY KEY, font_size INTEGER, text_color TEXT, accent_color TEXT,
      background_filename TEXT, background_original_name TEXT, background_mime TEXT,
      created_at INTEGER, updated_at INTEGER
    )`)
    db.prepare(`INSERT INTO ${schemas.USER_THEMES_TABLE} VALUES (1, 16, '#123456', NULL, 'wall.png', 'wall.png', 'image/png', 100, 200)`).run()
    const { store } = await initStore()
    expect(store.getUserTheme(1)).toMatchObject({ fontSize: 16, textColor: '#123456', appearance: { global: {}, regions: {} }, backgroundUpdatedAt: 200 })
    const appearance = { global: { radius: 12 }, regions: {} }
    const updated = store.saveUserTheme(1, { appearance })
    expect(store.toUserThemePayload(updated).background?.updatedAt).toBe(200)
    expect(store.saveUserTheme(1, { fontSize: 20 }).backgroundUpdatedAt).toBe(200)
    const uploaded = store.saveUserThemeBackground(1, { filename: 'new.png', originalName: 'new.png', mime: 'image/png' })
    expect(uploaded.backgroundUpdatedAt).toBeGreaterThan(200)
    expect(uploaded.appearance).toEqual(appearance)
    expect(store.clearUserThemeBackground(1).appearance).toEqual(appearance)
  })

  it('keeps color settings when the background metadata changes', async () => {
    const { store } = await initStore()
    store.saveUserTheme(1, {
      fontSize: 17,
      textColor: '#111111',
      accentColor: '#2255ff',
    })

    const withBackground = store.saveUserThemeBackground(1, {
      filename: '0123456789abcdef0123456789abcdef.png',
      originalName: 'wallpaper.png',
      mime: 'image/png',
    })
    expect(withBackground).toMatchObject({
      fontSize: 17,
      textColor: '#111111',
      accentColor: '#2255ff',
      backgroundFilename: '0123456789abcdef0123456789abcdef.png',
      backgroundOriginalName: 'wallpaper.png',
    })

    const cleared = store.clearUserThemeBackground(1)
    expect(cleared).toMatchObject({
      fontSize: 17,
      textColor: '#111111',
      accentColor: '#2255ff',
      backgroundFilename: null,
    })
  })

  it('stores validated background files outside SQLite and removes them cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-theme-test-'))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({
      config: { appHome: root },
    }))

    try {
      await initStore()
      const service = await import('../../packages/server/src/modules/studio/services/theme/user-theme')
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00,
      ])

      const saved = await service.replaceThemeBackground(3, '../../wallpaper.png', png)
      expect(saved).toMatchObject({
        userId: 3,
        backgroundOriginalName: 'wallpaper.png',
        backgroundMime: 'image/png',
      })
      expect(saved.backgroundFilename).toMatch(/^[a-f0-9]{32}\.png$/)

      const loaded = await service.readThemeBackground(3)
      expect(loaded?.mime).toBe('image/png')
      expect(loaded?.data).toEqual(png)

      await service.removeThemeBackground(3)
      expect(await service.readThemeBackground(3)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
