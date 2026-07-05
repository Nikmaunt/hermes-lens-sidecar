import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import {
  AgentStatus,
  CaptureResponse,
  DecisionsResponse,
  DocumentsResponse,
  FlagResponse,
  FollowupActionResponse,
  HabitsResponse,
  InboxResponse,
  MemoryResponse,
  PeopleResponse,
  PolishWordsResponse,
  ProjectsResponse,
  RemindersResponse,
  SearchResponse,
  SyncAckResponse,
  TimelineResponse,
  TodaySummary,
  TriageResponse,
} from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'
import { toWarsawDate } from '../src/lib/time.js'

/**
 * The contract walk: every endpoint of the real server, booted against the
 * fixture vault + a real node:sqlite state.db, validated against the
 * VERBATIM schema mirror from hermes-lens. 401 without/with-wrong token is
 * asserted for every route.
 */

const GET_ENDPOINTS: { path: string; schema: ZodType }[] = [
  { path: '/api/status', schema: AgentStatus },
  { path: '/api/today', schema: TodaySummary },
  { path: '/api/timeline', schema: TimelineResponse },
  { path: '/api/memory', schema: MemoryResponse },
  { path: '/api/projects', schema: ProjectsResponse },
  { path: '/api/people', schema: PeopleResponse },
  { path: '/api/documents', schema: DocumentsResponse },
  { path: '/api/decisions', schema: DecisionsResponse },
  { path: '/api/habits', schema: HabitsResponse },
  { path: '/api/polish-words', schema: PolishWordsResponse },
  { path: '/api/inbox', schema: InboxResponse },
  { path: '/api/reminders', schema: RemindersResponse },
  { path: '/api/search?q=%D0%BA%D0%BE%D1%84%D0%B5', schema: SearchResponse },
]

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('contract walk — every GET endpoint', () => {
  for (const { path, schema } of GET_ENDPOINTS) {
    const route = path.split('?')[0] ?? path
    it(`${route}: 401 without token, 401 wrong token, 200 + schema-valid with token`, async () => {
      const noToken = await env.get(path, null)
      expect(noToken.status).toBe(401)
      expect(noToken.json).toEqual({ error: 'unauthorized' })

      const badToken = await env.get(path, 'wrong-token-wrong-token-wrong')
      expect(badToken.status).toBe(401)

      const ok = await env.get(path)
      expect(ok.status).toBe(200)
      const parsed = schema.safeParse(ok.json)
      if (!parsed.success) {
        throw new Error(`${route} failed schema: ${JSON.stringify(parsed.error.issues, null, 2)}`)
      }
      console.log(`  ✓ ${route} — 401/401/200, schema-valid`)
    })
  }
})

describe('contract walk — POST endpoints', () => {
  let capturedId = ''

  it('POST /api/capture → CaptureResponse (201), 401 without token', async () => {
    const noToken = await env.post('/api/capture', { text: 'x', tags: [] }, null)
    expect(noToken.status).toBe(401)

    const r = await env.post('/api/capture', {
      text: 'Идея для романа: станция прячет логи',
      tags: ['novel', 'idea'],
      clientId: 'contract-walk-1',
    })
    expect(r.status).toBe(201)
    capturedId = CaptureResponse.parse(r.json).id
    console.log('  ✓ POST /api/capture — 201, schema-valid')
  })

  it('POST /api/inbox/{id}/triage → TriageResponse', async () => {
    // triage the note we just captured, leaving the fixture notes intact
    // for the semantics assertions below
    expect(capturedId).not.toBe('')
    const r = await env.post(`/api/inbox/${capturedId}/triage`, { destination: 'note' })
    expect(r.status).toBe(200)
    expect(TriageResponse.parse(r.json).itemId).toBe(capturedId)
    console.log('  ✓ POST /api/inbox/{id}/triage — 200, schema-valid')
  })

  it('POST /api/memory/{id}/flag → FlagResponse', async () => {
    const memory = MemoryResponse.parse((await env.get('/api/memory')).json)
    const target = memory.items[0]
    expect(target).toBeDefined()
    const r = await env.post(`/api/memory/${target?.id}/flag`, { action: 'forget', reason: 'test' })
    expect(r.status).toBe(200)
    expect(FlagResponse.parse(r.json)).toEqual({ status: 'pending', itemId: target?.id })
    console.log('  ✓ POST /api/memory/{id}/flag — 200, schema-valid')
  })

  it('POST /api/followups/{id}/action → FollowupActionResponse, 401 without/wrong token', async () => {
    const today = TodaySummary.parse((await env.get('/api/today')).json)
    const fu = today.followUps.at(-1)
    expect(fu).toBeDefined()

    const noToken = await env.post(`/api/followups/${fu?.id}/action`, { action: 'done' }, null)
    expect(noToken.status).toBe(401)
    const badToken = await env.post(
      `/api/followups/${fu?.id}/action`,
      { action: 'done' },
      'wrong-token-wrong-token-wrong',
    )
    expect(badToken.status).toBe(401)

    const r = await env.post(`/api/followups/${fu?.id}/action`, { action: 'done' })
    expect(r.status).toBe(200)
    expect(FollowupActionResponse.parse(r.json)).toEqual({ status: 'ok', itemId: fu?.id })
    console.log('  ✓ POST /api/followups/{id}/action — 401/401/200, schema-valid')
  })

  it('POST /api/sync/ack → SyncAckResponse', async () => {
    const r = await env.post('/api/sync/ack', {
      syncedAt: '2026-07-05T12:00:00+02:00',
      lastSeenRevision: 'rev-abc',
    })
    expect(r.status).toBe(200)
    expect(SyncAckResponse.parse(r.json)).toEqual({ status: 'ok' })
    console.log('  ✓ POST /api/sync/ack — 200, schema-valid')
  })
})

describe('contract semantics', () => {
  it('/api/status: gateway alive, 2 cron jobs (never-ran skipped), backup group, real spend', async () => {
    const s = AgentStatus.parse((await env.get('/api/status')).json)
    expect(s.gateway.alive).toBe(true)
    expect(s.cronJobs.map((c) => c.id).sort()).toEqual(['inbox-triage', 'reminders-regen'])
    expect(s.cronJobs.find((c) => c.id === 'reminders-regen')?.lastResult).toBe('error')
    expect(s.lastBackup).not.toBeNull()
    expect(s.lastBackup?.sizeBytes).toBe(1024 + 2048)
    expect(s.system.diskTotalBytes).toBeGreaterThan(0)

    // recompute expected spend with the same Warsaw-day rule
    const today = toWarsawDate(new Date())
    const month = today.slice(0, 7)
    const expToday = env.sessionSpecs
      .filter((x) => toWarsawDate(new Date(x.startedAtMs)) === today)
      .reduce((a, x) => a + x.costUsd, 0)
    const expMonth = env.sessionSpecs
      .filter((x) => toWarsawDate(new Date(x.startedAtMs)).startsWith(month))
      .reduce((a, x) => a + x.costUsd, 0)
    expect(s.tokenSpend.todayUsd).toBeCloseTo(expToday, 6)
    expect(s.tokenSpend.monthUsd).toBeCloseTo(expMonth, 6)
  })

  it('/api/today: urgencies, 30-day deadline window, 24h activity, inboxCount = inbox length', async () => {
    const t = TodaySummary.parse((await env.get('/api/today')).json)
    expect(t.followUps.map((f) => f.urgency)).toEqual(['overdue', 'today', 'soon'])
    expect(t.followUps[0]?.source).toBe('vstrecha-s-olegom')
    expect(t.followUps[2]?.source).toBe('')

    // criticality words never reach display titles — urgency carries the signal
    expect(t.followUps[0]?.title).toBe('ответить Олегу про маршрут')
    for (const f of t.followUps) {
      expect(f.title).not.toMatch(/критично|важно|critical/i)
    }

    // Spotify renews in ~10 days (in window); Proton in ~200 days (out)
    expect(t.deadlines).toHaveLength(1)
    expect(t.deadlines[0]?.kind).toBe('subscription')
    expect(t.deadlines[0]?.title).toContain('Spotify')
    expect(t.deadlines[0]?.daysLeft).toBeGreaterThanOrEqual(9)
    expect(t.deadlines[0]?.daysLeft).toBeLessThanOrEqual(10)

    const ids = t.agentActivity.map((a) => a.id)
    expect(ids).toContain('sess-s-today') // 2 h ago → inside 24 h
    expect(ids).not.toContain('sess-s-digest') // 30 h ago → outside

    const inbox = InboxResponse.parse((await env.get('/api/inbox')).json)
    expect(t.inboxCount).toBe(inbox.items.length)
  })

  it('/api/inbox: triage markers stripped, tags from category, agent notes → telegram', async () => {
    const inbox = InboxResponse.parse((await env.get('/api/inbox')).json)
    const bank = inbox.items.find((i) => i.id === 'pozvonit-v-bank-0930')
    expect(bank).toBeDefined()
    expect(bank?.text).toContain('Позвонить в банк')
    expect(bank?.text).not.toContain('<!--')
    expect(bank?.text).not.toContain('[!question]')
    expect(bank?.text).not.toContain('Не уверен') // callout body stripped
    expect(bank?.tags).toContain('finance')
    expect(bank?.source).toBe('telegram')
  })

  it('/api/inbox: real agent note layout — frontmatter never leaks, body flattened to plain text', async () => {
    const inbox = InboxResponse.parse((await env.get('/api/inbox')).json)
    for (const item of inbox.items) {
      expect(item.text).not.toContain('---')
      expect(item.text).not.toContain('criticality')
      expect(item.text).not.toContain('<!--')
      expect(item.text).not.toContain('[!question]')
      expect(item.text).not.toContain('date:')
    }
    const visit = inbox.items.find((i) => i.id === 'osmotr-kotla-1900')
    expect(visit).toBeDefined()
    expect(visit?.text.startsWith('Осмотр котла')).toBe(true)
    expect(visit?.text).toContain('Дата: вторник, 7 июля 2026 г., 19:00')
    expect(visit?.text).toContain('котельная в подвале')
    expect(visit?.text).not.toMatch(/[#*]/)
    expect(visit?.tags).toContain('appointment')
  })

  it('/api/reminders: field mapping and criticality', async () => {
    const r = RemindersResponse.parse((await env.get('/api/reminders')).json)
    const first = r.items.find((i) => i.id === 'napisat-olegu')
    expect(first).toMatchObject({
      title: 'Написать Олегу про маршрут',
      dueAt: '2026-07-06T09:00:00+02:00',
      critical: true,
      sourceRef: 'napisat-olegu',
      notes: 'followup',
    })
    expect(first?.leadTimeMinutes).toBeUndefined()
    expect(r.items.find((i) => i.id === 'prodlit-proezdnoy')?.critical).toBe(false)
  })

  it('/api/documents: monthlyTotal normalizes yearly ÷ 12 per currency', async () => {
    const d = DocumentsResponse.parse((await env.get('/api/documents')).json)
    expect(d.items).toHaveLength(2)
    expect(d.monthlyTotal).toEqual([{ currency: 'USD', cents: 1799 + Math.round(7999 / 12) }])
  })

  it('/api/people: grouped by frontmatter person', async () => {
    const p = PeopleResponse.parse((await env.get('/api/people')).json)
    expect(p.people.map((x) => x.name).sort()).toEqual(['Rosa', 'Олег'])
    const oleg = p.people.find((x) => x.name === 'Олег')
    expect(oleg?.context).toContain('Обсудили поход в горы')
  })

  it('/api/memory: content-hash ids, section categories', async () => {
    const m = MemoryResponse.parse((await env.get('/api/memory')).json)
    expect(m.items.length).toBeGreaterThanOrEqual(6)
    expect(m.items.every((i) => i.id.startsWith('mem-'))).toBe(true)
    expect(m.items.some((i) => i.category === 'identity')).toBe(true)
    expect(m.items.some((i) => i.category === 'preferences')).toBe(true)
  })

  it('/api/timeline: merged sources, category filter, cursor exhaustion', async () => {
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    const ids = t.events.map((e) => e.id)
    expect(ids.some((i) => i.startsWith('sess-'))).toBe(true)
    expect(ids.some((i) => i.startsWith('note-'))).toBe(true)
    expect(ids.some((i) => i.startsWith('backup-'))).toBe(true)
    expect(t.nextBefore).toBeNull() // fewer than 25 events in the fixture set

    const filtered = TimelineResponse.parse((await env.get('/api/timeline?category=capture')).json)
    expect(filtered.events.length).toBeGreaterThan(0)
    expect(filtered.events.every((e) => e.category === 'capture')).toBe(true)

    // NULL-title session falls back, cron session is category agent
    const agent = TimelineResponse.parse((await env.get('/api/timeline?category=agent')).json)
    expect(agent.events.find((e) => e.id === 'sess-s-old')?.title).toBe('Agent session')
    expect(agent.events.find((e) => e.id === 'sess-s-digest')?.category).toBe('agent')
  })

  it('/api/timeline: session titles humanized, no trailing dates, calm meta', async () => {
    const agent = TimelineResponse.parse((await env.get('/api/timeline?category=agent')).json)
    const recompute = agent.events.find((e) => e.id === 'sess-s-recompute')
    expect(recompute?.title).toBe('Пересчёт напоминаний')
    expect(recompute?.detail).toBe('автозадача · 15 шагов')

    const chat = agent.events.find((e) => e.id === 'sess-s-today')
    expect(chat?.title).toBe('Обсуждение бюджета поездки') // human title untouched
    expect(chat?.detail).toBe('telegram · 12 сообщений')

    const digest = agent.events.find((e) => e.id === 'sess-s-digest')
    expect(digest?.title).toBe('Morning digest') // unknown cron title passes through
    expect(digest?.detail).toBe('автозадача · 1 шаг')

    for (const e of agent.events) {
      expect(e.title).not.toMatch(/·\s*[A-Z][a-z]{2}\s+\d{1,2}(\s+\d{1,2}:\d{2})?\s*$/)
      expect(e.detail).not.toMatch(/messages|tool calls/)
    }
  })

  it('unknown query params ignored; unknown route 404; wrong method 405', async () => {
    const ok = await env.get('/api/status?foo=bar&baz=1')
    expect(ok.status).toBe(200)
    const missing = await env.get('/api/nope')
    expect(missing.status).toBe(404)
    expect(missing.json).toEqual({ error: 'not found' })
    const res = await fetch(env.baseUrl + '/api/status', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${env.token}` },
    })
    expect(res.status).toBe(405)
  })

  it('the bearer token never appears in any log line', () => {
    expect(env.logs.length).toBeGreaterThan(0)
    expect(env.logs.join('\n')).not.toContain(env.token)
  })
})
