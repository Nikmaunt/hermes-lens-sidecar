import { appendFileSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentStatus,
  InboxResponse,
  MemoryResponse,
  SomedayResponse,
  TimelineResponse,
  TodaySummary,
} from '../contract/schemas/index'
import { toWarsawDate, toWarsawIso } from '../src/lib/time.js'
import { tokenSpend } from '../src/readers/status.js'
import type { SessionRow } from '../src/readers/statedb.js'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * Contract evolution, server half: journal writers stamp a machine-readable
 * `kind` on every record, /api/timeline serves it verbatim (old records
 * without kind → field omitted, the app falls back to title prefixes), and
 * /api/status grows tokenSpend.since — the date of the first accounted
 * session. Kinds are aligned with the app's KIND_TARGETS routing table
 * (hermes-lens src/lib/eventRoute.ts); kinds outside that table expand in
 * place on the client, so `system` is the safe bucket for the rest.
 */

let env: TestEnv

/** journal type → expected kind, one row per appendJournal call site. */
const WRITER_KINDS: Record<string, string> = {
  capture: 'capture', // writes/capture.ts
  triage: 'triage-queued', // writes/queue.ts triage
  flag: 'memory-flag', // writes/queue.ts memory flag
  ack: 'system', // writes/syncack.ts — no screen behind it
  'followup-action': 'followup-queued', // writes/queue.ts
  'followup-undo': 'system', // undo rows expand in place, as before kind
  'someday-action': 'someday-queued', // writes/queue.ts
  'someday-undo': 'system',
  'habit-tick': 'habit-queued', // writes/queue.ts
  notification: 'notification', // writes/notifications.ts
  command: 'command', // writes/commands.ts
}

function journalLines(): Record<string, unknown>[] {
  return readFileSync(env.paths.journalPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

beforeAll(async () => {
  env = await buildEnv()

  // Exercise every journal writer once.
  await env.post('/api/capture', { text: 'проверка kind у журнала' })

  const inbox = InboxResponse.parse((await env.get('/api/inbox')).json)
  await env.post(`/api/inbox/${inbox.items[0]?.id ?? ''}/triage`, { destination: 'archive' })

  const memory = MemoryResponse.parse((await env.get('/api/memory')).json)
  await env.post(`/api/memory/${memory.items[0]?.id ?? ''}/flag`, { action: 'forget' })

  await env.post('/api/sync/ack', {
    syncedAt: '2026-07-11T12:00:00+02:00',
    lastSeenRevision: 'rev-kind',
  })

  const followUps = TodaySummary.parse((await env.get('/api/today')).json).followUps
  const fuId = followUps[0]?.id ?? ''
  await env.post(`/api/followups/${fuId}/action`, { action: 'done' })
  await env.post(`/api/followups/${fuId}/action`, { action: 'undo' })

  const someday = SomedayResponse.parse((await env.get('/api/someday')).json)
  const sdId = someday.items[0]?.id ?? ''
  await env.post(`/api/someday/${sdId}/action`, { action: 'activate', date: '2026-09-01' })
  await env.post(`/api/someday/${sdId}/action`, { action: 'undo' })

  await env.post('/api/habits/hab-zaryadka/tick', { date: toWarsawDate(new Date()) })

  await env.post('/api/notifications', {
    clientId: 'notif-kind-0001-abcdef',
    package: 'com.google.android.gm',
    postedAt: '2026-07-11T09:15:00+02:00',
    capturedAt: '2026-07-11T09:15:03+02:00',
    title: 'Новое письмо',
    text: 'Тело уведомления',
  })

  await env.post('/api/commands', {
    clientId: 'command-kind-0001',
    type: 'adhoc-digest',
    payload: { topic: 'Проверка kind' },
  })
})
afterAll(async () => {
  await env.close()
})

describe('journal writers emit kind', () => {
  it('covers every journal type exactly once in this suite', () => {
    const seen = new Set(journalLines().map((l) => l.type as string))
    for (const type of Object.keys(WRITER_KINDS)) {
      expect(seen, `journal has a ${type} record`).toContain(type)
    }
  })

  for (const [type, kind] of Object.entries(WRITER_KINDS)) {
    it(`${type} records carry kind "${kind}"`, () => {
      const records = journalLines().filter((l) => l.type === type)
      expect(records.length).toBeGreaterThan(0)
      for (const r of records) expect(r.kind, `kind of ${type}`).toBe(kind)
    })
  }
})

describe('/api/timeline serves kind as-is', () => {
  it('journal-fed events carry their writer kind', async () => {
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    const byTitle = (title: string) => t.events.find((e) => e.title === title)
    expect(byTitle('Inbox triage queued')?.kind).toBe('triage-queued')
    expect(byTitle('Memory flag queued')?.kind).toBe('memory-flag')
    expect(byTitle('Follow-up action queued')?.kind).toBe('followup-queued')
    expect(byTitle('Follow-up action undone')?.kind).toBe('system')
    expect(byTitle('Someday action queued')?.kind).toBe('someday-queued')
    expect(byTitle('Someday action undone')?.kind).toBe('system')
    expect(byTitle('Habit tick queued')?.kind).toBe('habit-queued')
    expect(byTitle('Notification captured')?.kind).toBe('notification')
    expect(byTitle('Command queued')?.kind).toBe('command')
    expect(byTitle('Reminders sync acknowledged')?.kind).toBe('system')
  })

  it('captured notes are kind "capture" even when the live inbox file wins over the journal', async () => {
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    const capture = t.events.find((e) => e.category === 'capture' && e.id.startsWith('note-'))
    expect(capture).toBeDefined()
    expect(capture?.kind).toBe('capture')
  })

  it('backup files → kind "backup", cron sessions → "cron", chat sessions → no kind', async () => {
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    const backup = t.events.find((e) => e.id.startsWith('backup-'))
    expect(backup?.kind).toBe('backup')
    expect(t.events.find((e) => e.id === 'sess-s-recompute')?.kind).toBe('cron')
    expect(t.events.find((e) => e.id === 'sess-s-today')?.kind).toBeUndefined()
  })

  it('old journal records without kind stay valid and the field is omitted', async () => {
    // A line written by a pre-kind sidecar version.
    appendFileSync(
      env.paths.journalPath,
      JSON.stringify({
        type: 'triage',
        at: toWarsawIso(new Date()),
        title: 'Старая запись без kind',
        detail: null,
        relatedId: null,
      }) + '\n',
    )
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    const legacy = t.events.find((e) => e.title === 'Старая запись без kind')
    expect(legacy).toBeDefined()
    expect(legacy?.kind).toBeUndefined()
    expect('kind' in (legacy ?? {})).toBe(false)
  })
})

describe('tokenSpend.since — date of the first accounted session', () => {
  const session = (id: string, startedAtMs: number): SessionRow => ({
    id,
    source: 'telegram',
    title: null,
    startedAtMs,
    endedAtMs: null,
    messageCount: 1,
    toolCallCount: 0,
    costUsd: 0.01,
  })

  it('unit: since is the Warsaw date of the earliest session', () => {
    const now = new Date('2026-07-11T12:00:00+02:00')
    const spend = tokenSpend(
      [session('b', Date.parse('2026-06-20T10:00:00+02:00')), session('a', Date.parse('2026-03-05T23:30:00+01:00'))],
      now,
    ) as Record<string, unknown>
    expect(spend.since).toBe('2026-03-05')
  })

  it('unit: no sessions → the field is omitted, not null/empty', () => {
    const spend = tokenSpend([], new Date()) as Record<string, unknown>
    expect('since' in spend).toBe(false)
  })

  it('/api/status: since matches the oldest fixture session', async () => {
    const s = AgentStatus.parse((await env.get('/api/status')).json)
    const oldest = Math.min(...env.sessionSpecs.map((x) => x.startedAtMs))
    expect(s.tokenSpend.since).toBe(toWarsawDate(new Date(oldest)))
  })
})
