import type { DatabaseSync } from 'node:sqlite'
import type { EventEnvelope } from '../contracts/plugins'

/** Public event projections only. Internal business payloads never enter this table. */
export class PluginEventStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_plugin_events (
      position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      partition_key TEXT NOT NULL, sequence INTEGER NOT NULL,
      profile_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, envelope_json TEXT NOT NULL,
      UNIQUE(partition_key, sequence)
    ); CREATE INDEX IF NOT EXISTS studio_plugin_events_profile_position ON studio_plugin_events(profile_id, position);
    CREATE TABLE IF NOT EXISTS studio_plugin_event_partitions (partition_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO studio_plugin_event_partitions SELECT partition_key, MAX(sequence) FROM studio_plugin_events GROUP BY partition_key;
    CREATE TABLE IF NOT EXISTS studio_plugin_event_retention (id INTEGER PRIMARY KEY CHECK(id=1), floor INTEGER NOT NULL);
    INSERT OR IGNORE INTO studio_plugin_event_retention VALUES (1, 0);`)
  }

  append(events: EventEnvelope[]): EventEnvelope[] {
    const accepted: EventEnvelope[] = []
    this.db.exec('SAVEPOINT studio_plugin_event_batch')
    try {
      for (const input of events) {
        const previous = this.db.prepare('SELECT envelope_json FROM studio_plugin_events WHERE id=?').get(input.id) as { envelope_json: string } | undefined
        if (previous) continue
        const last = this.db.prepare('SELECT sequence FROM studio_plugin_event_partitions WHERE partition_key=?').get(input.partitionKey) as { sequence: number } | undefined
        const event: EventEnvelope = { ...input, sequence: (last?.sequence || 0) + 1 }
        this.db.prepare('INSERT INTO studio_plugin_events (id, partition_key, sequence, profile_id, occurred_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?)')
          .run(event.id, event.partitionKey, event.sequence, event.subject.profileId, event.occurredAt, JSON.stringify(event))
        this.db.prepare('INSERT INTO studio_plugin_event_partitions VALUES (?, ?) ON CONFLICT(partition_key) DO UPDATE SET sequence=excluded.sequence')
          .run(event.partitionKey, event.sequence)
        accepted.push(event)
      }
      this.db.exec('RELEASE studio_plugin_event_batch')
      return accepted
    } catch (error) {
      this.db.exec('ROLLBACK TO studio_plugin_event_batch; RELEASE studio_plugin_event_batch')
      throw error
    }
  }

  read(profileId: string, afterPosition = 0, limit = 100): Array<{ position: number; event: EventEnvelope }> {
    const rows = this.db.prepare('SELECT position, envelope_json FROM studio_plugin_events WHERE profile_id=? AND position>? ORDER BY position LIMIT ?')
      .all(profileId, afterPosition, Math.max(1, Math.min(limit, 1000))) as Array<{ position: number; envelope_json: string }>
    return rows.map(row => ({ position: row.position, event: JSON.parse(row.envelope_json) as EventEnvelope }))
  }

  head(): number {
    return (this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='studio_plugin_events'").get() as { seq: number } | undefined)?.seq || 0
  }

  floor(): number { return (this.db.prepare('SELECT floor FROM studio_plugin_event_retention WHERE id=1').get() as { floor: number }).floor }

  get(position: number): EventEnvelope | null {
    const row = this.db.prepare('SELECT envelope_json FROM studio_plugin_events WHERE position=?').get(position) as { envelope_json: string } | undefined
    return row ? JSON.parse(row.envelope_json) as EventEnvelope : null
  }

  /** Bounded retention work; partition sequences survive deletion of their last event. */
  prune(before: number, limit = 1000): number {
    this.db.exec('SAVEPOINT studio_plugin_event_retention')
    try {
      const rows = this.db.prepare('SELECT position FROM studio_plugin_events WHERE occurred_at<? ORDER BY position LIMIT ?')
        .all(before, Math.max(1, Math.min(10_000, limit))) as Array<{ position: number }>
      for (const row of rows) this.db.prepare('DELETE FROM studio_plugin_events WHERE position=?').run(row.position)
      if (rows.length) this.db.prepare('UPDATE studio_plugin_event_retention SET floor=MAX(floor, ?) WHERE id=1').run(rows.at(-1)!.position)
      this.db.exec('RELEASE studio_plugin_event_retention')
      return rows.length
    } catch (error) { this.db.exec('ROLLBACK TO studio_plugin_event_retention; RELEASE studio_plugin_event_retention'); throw error }
  }
}
