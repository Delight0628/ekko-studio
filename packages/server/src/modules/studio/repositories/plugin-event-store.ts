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
    ); CREATE INDEX IF NOT EXISTS studio_plugin_events_profile_position ON studio_plugin_events(profile_id, position);`)
  }

  append(events: EventEnvelope[]): EventEnvelope[] {
    const accepted: EventEnvelope[] = []
    this.db.exec('SAVEPOINT studio_plugin_event_batch')
    try {
      for (const input of events) {
        const previous = this.db.prepare('SELECT envelope_json FROM studio_plugin_events WHERE id=?').get(input.id) as { envelope_json: string } | undefined
        if (previous) continue
        const last = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM studio_plugin_events WHERE partition_key=?').get(input.partitionKey) as { value: number }
        const event: EventEnvelope = { ...input, sequence: last.value + 1 }
        this.db.prepare('INSERT INTO studio_plugin_events (id, partition_key, sequence, profile_id, occurred_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?)')
          .run(event.id, event.partitionKey, event.sequence, event.subject.profileId, event.occurredAt, JSON.stringify(event))
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
}
