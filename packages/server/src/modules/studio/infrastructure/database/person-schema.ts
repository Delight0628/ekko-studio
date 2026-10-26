import type { DatabaseSync } from 'node:sqlite'

/** Account-owned goals share session_tasks, but do not depend on a chat's lifetime. */
export function initPersonTables(db: DatabaseSync): void {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_tasks'").get() as { sql: string }).sql
  if (/"?(?:session_id|source_message_id)"?\s+(?:TEXT|INTEGER)\s+NOT NULL/i.test(sql)) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='session_tasks' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[]
      const columns = (db.prepare('PRAGMA table_info(session_tasks)').all() as { name: string }[]).map(c => `"${c.name}"`).join(',')
      const create = sql.replace(/^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"session_tasks"|session_tasks)/i, '$1person_goal_migration')
        .replace(/("?(?:session_id|source_message_id)"?\s+(?:TEXT|INTEGER))\s+NOT NULL/gi, '$1')
      db.exec(create)
      db.exec(`INSERT INTO person_goal_migration (${columns}) SELECT ${columns} FROM session_tasks`)
      db.exec('DROP TABLE session_tasks; ALTER TABLE person_goal_migration RENAME TO session_tasks')
      for (const object of objects) db.exec(object.sql)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_person_goals ON session_tasks(owner_user_id, bot_id, updated_at);
    CREATE TABLE IF NOT EXISTS person_accounts (
      user_id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS person_memories (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, content TEXT NOT NULL,
      source TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_memories ON person_memories(owner_user_id, updated_at);
    CREATE TABLE IF NOT EXISTS person_selections (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, selection_json TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_executions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_user_id INTEGER NOT NULL, requirements_revision INTEGER NOT NULL,
      state TEXT NOT NULL, session_id TEXT NOT NULL, selection_json TEXT NOT NULL,
      output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', review_json TEXT NOT NULL DEFAULT '',
      stop_action TEXT NOT NULL DEFAULT '', review_round INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, occurrence_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_person_runs ON person_executions(owner_user_id, task_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_person_active_run ON person_executions(task_id)
      WHERE state IN ('queued','starting','stopping','running','waiting_person','waiting_user','waiting_approval','reviewing','paused');
    CREATE TABLE IF NOT EXISTS person_interactions (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, task_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      native_id TEXT NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL, choices_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'pending', answer TEXT NOT NULL DEFAULT '', answered_by TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      UNIQUE(execution_id, native_id)
    );
    CREATE TABLE IF NOT EXISTS person_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, execution_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_events ON person_events(owner_user_id, execution_id, id);
    CREATE TABLE IF NOT EXISTS person_schedules (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, task_id TEXT NOT NULL,
      kind TEXT NOT NULL, expression TEXT NOT NULL, timezone TEXT NOT NULL, next_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 0,
      misfire TEXT NOT NULL DEFAULT 'skip', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_occurrences (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, revision INTEGER NOT NULL, scheduled_at INTEGER NOT NULL,
      state TEXT NOT NULL, execution_id TEXT, UNIQUE(schedule_id, revision, scheduled_at)
    );
    CREATE TABLE IF NOT EXISTS person_operations (
      owner_user_id INTEGER NOT NULL, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, PRIMARY KEY(owner_user_id, operation_key)
    );
  `)
}
