import { expect, it } from 'vitest'
import { projectPluginBusinessEvent } from '../../packages/server/src/modules/studio/services/events/plugin-business-events'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { DatabaseSync } from 'node:sqlite'

it('projects existing run events without internal payload or notification targets', () => {
  const projected = projectPluginBusinessEvent({ schema_version: 1, id: 'event', type: 'chat.run.completed', occurred_at: '2026-10-23T00:00:00Z', profile: 'private', source: 'chat',
    subject: { session_id: 'session', run_id: 'run' }, payload: { token: 'secret', content: 'private text', actor: 'admin' }, push_target_id: 'private-target' }, 2)
  expect(projected).toMatchObject({ type: 'run.completed', subject: { profileId: 'private', sessionId: 'session', runId: 'run' }, data: { runId: 'run' }, sequence: 2 })
  expect(JSON.stringify(projected)).not.toMatch(/secret|private text|private-target|admin/)
})

it('does not turn unknown business events into a public plugin payload', () => {
  expect(projectPluginBusinessEvent({ schema_version: 1, id: 'event', type: 'internal.secret', occurred_at: '2026-10-23T00:00:00Z', profile: 'private', source: 'chat', subject: {}, payload: { token: 'secret' } }, 1)).toBeNull()
})

it('publishes deletion callbacks for deletion only, never for archive notifications', () => {
  const event = { schema_version: 1 as const, id: 'event', type: 'chat.session.removed', occurred_at: '2026-10-23T00:00:00Z', profile: 'default', source: 'chat', subject: { session_id: 'session' }, payload: { reason: 'archived' } }
  expect(projectPluginBusinessEvent(event, 1)).toBeNull()
  expect(projectPluginBusinessEvent({ ...event, payload: { reason: 'deleted' } }, 1)).toMatchObject({ type: 'session.deleted', data: { sessionId: 'session' } })
})

it('persists public events once with partition sequence and profile isolation', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new PluginEventStore(db)
    const first = { schemaVersion: 1 as const, id: 'one', type: 'plugin.ready', occurredAt: 1, partitionKey: 'profile:plugin', sequence: 0, subject: { profileId: 'profile' }, data: {}, correlationId: 'trace' }
    expect(store.append([first, { ...first, id: 'two' }]).map(event => event.sequence)).toEqual([1, 2])
    expect(store.append([first])).toEqual([])
    expect(store.read('other')).toEqual([])
    expect(new PluginEventStore(db).read('profile')).toHaveLength(2)
  } finally { db.close() }
})
