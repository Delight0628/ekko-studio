import { getDb } from '../infrastructure/database'
import { MODEL_API_KEYS_TABLE } from '../infrastructure/database/schemas'

export interface ModelApiKey {
  id: string
  name: string
  models: string[]
  preview: string
  createdAt: number
  lastUsedAt: number | null
}
type KeyRow = {
  id: string; user_id: number; name: string; preview: string; models_json: string
  created_at: number; last_used_at: number | null
}
const columns = 'id, user_id, name, preview, models_json, created_at, last_used_at'
function database() {
  const db = getDb()
  if (!db) throw new Error('API key storage is unavailable.')
  return db
}
function publicKey(row: KeyRow): ModelApiKey {
  return { id: row.id, name: row.name, models: JSON.parse(row.models_json), preview: row.preview, createdAt: row.created_at, lastUsedAt: row.last_used_at }
}
export function listModelApiKeys(userId: number): ModelApiKey[] {
  const rows = database().prepare(`SELECT ${columns} FROM ${MODEL_API_KEYS_TABLE} WHERE user_id = ? ORDER BY created_at DESC, id`).all(userId) as KeyRow[]
  return rows.map(publicKey)
}
export function insertModelApiKey(userId: number, key: ModelApiKey, tokenHash: string) {
  database().prepare(`INSERT INTO ${MODEL_API_KEYS_TABLE} (id, user_id, name, preview, token_hash, models_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(key.id, userId, key.name, key.preview, tokenHash, JSON.stringify(key.models), key.createdAt)
}
export function findModelApiKeyByHash(tokenHash: string): { id: string; userId: number; models: string[] } | null {
  const row = database().prepare(`SELECT id, user_id, models_json FROM ${MODEL_API_KEYS_TABLE} WHERE token_hash = ?`).get(tokenHash) as KeyRow | undefined
  return row ? { id: row.id, userId: row.user_id, models: JSON.parse(row.models_json) } : null
}
export function getModelApiKey(userId: number, id: string): ModelApiKey | null {
  const row = database().prepare(`SELECT ${columns} FROM ${MODEL_API_KEYS_TABLE} WHERE id = ? AND user_id = ?`).get(id, userId) as KeyRow | undefined
  return row ? publicKey(row) : null
}
export function updateModelApiKey(userId: number, id: string, name: string, models: string[]): ModelApiKey | null {
  const result = database().prepare(`UPDATE ${MODEL_API_KEYS_TABLE} SET name = ?, models_json = ? WHERE id = ? AND user_id = ?`)
    .run(name, JSON.stringify(models), id, userId)
  return result.changes ? getModelApiKey(userId, id) : null
}
export function touchModelApiKey(id: string) {
  database().prepare(`UPDATE ${MODEL_API_KEYS_TABLE} SET last_used_at = ? WHERE id = ?`).run(Date.now(), id)
}
export function revokeModelApiKey(userId: number, id: string): boolean {
  return database().prepare(`DELETE FROM ${MODEL_API_KEYS_TABLE} WHERE id = ? AND user_id = ?`).run(id, userId).changes > 0
}
