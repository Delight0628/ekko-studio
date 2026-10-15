import { normalizeThemeAppearance, type ThemeAppearance } from '../../../../../shared/theme-appearance'
import { getDb } from '../infrastructure/database'
import { USER_THEMES_TABLE } from '../infrastructure/database/schemas'

export const DEFAULT_THEME_FONT_SIZE = 14
export const MIN_THEME_FONT_SIZE = 12
export const MAX_THEME_FONT_SIZE = 20

export interface UserThemeRecord {
  userId: number
  fontSize: number
  textColor: string | null
  accentColor: string | null
  appearance: ThemeAppearance
  backgroundFilename: string | null
  backgroundUpdatedAt: number
  backgroundOriginalName: string | null
  backgroundMime: string | null
  createdAt: number
  updatedAt: number
}

export interface UserThemePayload {
  fontSize: number
  textColor: string | null
  accentColor: string | null
  appearance: ThemeAppearance
  background: {
    name: string
    mime: string | null
    updatedAt: number
  } | null
  updatedAt: number
}

interface StoredUserThemeRow {
  user_id: number
  font_size: number
  text_color: string | null
  accent_color: string | null
  appearance_json: string | null
  background_updated_at: number
  background_filename: string | null
  background_original_name: string | null
  background_mime: string | null
  created_at: number
  updated_at: number
}

export interface UserThemePatch {
  fontSize?: unknown
  textColor?: unknown
  accentColor?: unknown
  appearance?: unknown
}

function requireDb() {
  const db = getDb()
  if (!db) throw new Error('Theme storage unavailable')
  return db
}

function normalizeUserId(value: unknown): number {
  const userId = Number(value)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new UserThemeValidationError('Invalid user')
  }
  return userId
}

function normalizeFontSize(value: unknown): number {
  const fontSize = Number(value)
  if (!Number.isInteger(fontSize) || fontSize < MIN_THEME_FONT_SIZE || fontSize > MAX_THEME_FONT_SIZE) {
    throw new UserThemeValidationError(
      `Font size must be between ${MIN_THEME_FONT_SIZE} and ${MAX_THEME_FONT_SIZE}`,
    )
  }
  return fontSize
}

function normalizeColor(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    throw new UserThemeValidationError(`${label} must be a six-digit hex color`)
  }
  return value.trim().toLowerCase()
}

function readAppearance(value: string | null): ThemeAppearance {
  try { return normalizeThemeAppearance(value ? JSON.parse(value) : null) }
  catch { return normalizeThemeAppearance(null) }
}

function mapRow(row: StoredUserThemeRow): UserThemeRecord {
  return {
    userId: row.user_id,
    fontSize: row.font_size,
    textColor: row.text_color,
    accentColor: row.accent_color,
    appearance: readAppearance(row.appearance_json),
    backgroundUpdatedAt: row.background_updated_at || row.updated_at,
    backgroundFilename: row.background_filename,
    backgroundOriginalName: row.background_original_name,
    backgroundMime: row.background_mime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function defaultTheme(userId: number): UserThemeRecord {
  return {
    userId,
    fontSize: DEFAULT_THEME_FONT_SIZE,
    textColor: null,
    accentColor: null,
    appearance: normalizeThemeAppearance(null),
    backgroundUpdatedAt: 0,
    backgroundFilename: null,
    backgroundOriginalName: null,
    backgroundMime: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

export class UserThemeValidationError extends Error {}

export function toUserThemePayload(theme: UserThemeRecord): UserThemePayload {
  return {
    fontSize: theme.fontSize,
    textColor: theme.textColor,
    accentColor: theme.accentColor,
    appearance: theme.appearance,
    background: theme.backgroundFilename ? {
      name: theme.backgroundOriginalName || 'background',
      mime: theme.backgroundMime,
      updatedAt: theme.backgroundUpdatedAt,
    } : null,
    updatedAt: theme.updatedAt,
  }
}

export function getUserTheme(userIdValue: unknown): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  const db = getDb()
  if (!db) return defaultTheme(userId)
  const row = db.prepare(
    `SELECT * FROM ${USER_THEMES_TABLE} WHERE user_id = ?`,
  ).get(userId) as StoredUserThemeRow | undefined
  return row ? mapRow(row) : defaultTheme(userId)
}

export function saveUserTheme(userIdValue: unknown, patch: UserThemePatch): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new UserThemeValidationError('Invalid theme settings')
  }

  const current = getUserTheme(userId)
  const fontSize = Object.prototype.hasOwnProperty.call(patch, 'fontSize')
    ? normalizeFontSize(patch.fontSize)
    : current.fontSize
  const textColor = Object.prototype.hasOwnProperty.call(patch, 'textColor')
    ? normalizeColor(patch.textColor, 'Text color')
    : current.textColor
  const accentColor = Object.prototype.hasOwnProperty.call(patch, 'accentColor')
    ? normalizeColor(patch.accentColor, 'Accent color')
    : current.accentColor
  let appearance = current.appearance
  if (Object.prototype.hasOwnProperty.call(patch, 'appearance')) {
    try { appearance = normalizeThemeAppearance(patch.appearance, true) }
    catch (error) { throw new UserThemeValidationError((error as Error).message) }
  }
  const now = Date.now()
  const createdAt = current.createdAt || now
  const db = requireDb()

  db.prepare(
    `INSERT INTO ${USER_THEMES_TABLE}
      (user_id, font_size, text_color, accent_color, background_filename,
       background_original_name, background_mime, created_at, updated_at, appearance_json, background_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       font_size = excluded.font_size,
       text_color = excluded.text_color,
       accent_color = excluded.accent_color,
       appearance_json = excluded.appearance_json,
       background_updated_at = excluded.background_updated_at,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    fontSize,
    textColor,
    accentColor,
    current.backgroundFilename,
    current.backgroundOriginalName,
    current.backgroundMime,
    createdAt,
    now,
    JSON.stringify(appearance),
    current.backgroundUpdatedAt,
  )
  return getUserTheme(userId)
}

export function saveUserThemeBackground(
  userIdValue: unknown,
  background: { filename: string; originalName: string; mime: string },
): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  const current = getUserTheme(userId)
  const now = Date.now()
  const createdAt = current.createdAt || now
  const db = requireDb()
  db.prepare(
    `INSERT INTO ${USER_THEMES_TABLE}
      (user_id, font_size, text_color, accent_color, background_filename,
       background_original_name, background_mime, created_at, updated_at, appearance_json, background_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       background_filename = excluded.background_filename,
       background_original_name = excluded.background_original_name,
       background_mime = excluded.background_mime,
       background_updated_at = excluded.background_updated_at,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    current.fontSize,
    current.textColor,
    current.accentColor,
    background.filename,
    background.originalName,
    background.mime,
    createdAt,
    now,
    JSON.stringify(current.appearance),
    Math.max(now, current.backgroundUpdatedAt + 1),
  )
  return getUserTheme(userId)
}

export function clearUserThemeBackground(userIdValue: unknown): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  const current = getUserTheme(userId)
  if (!current.createdAt) return current
  const db = requireDb()
  db.prepare(
    `UPDATE ${USER_THEMES_TABLE}
     SET background_filename = NULL,
         background_original_name = NULL,
         background_mime = NULL,
         background_updated_at = 0,
         updated_at = ?
     WHERE user_id = ?`,
  ).run(Date.now(), userId)
  return getUserTheme(userId)
}
