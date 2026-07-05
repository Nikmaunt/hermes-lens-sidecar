import { copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import {
  AgentStatus,
  BriefsResponse,
  DecisionsResponse,
  DocumentsResponse,
  HabitsResponse,
  InboxResponse,
  MemoryResponse,
  PeopleResponse,
  PolishWordsResponse,
  ProjectsResponse,
  RemindersResponse,
  SearchResponse,
  TimelineResponse,
  TodaySummary,
} from '../contract/schemas/index'
import { buildEnv, fixturePath, type TestEnv } from './helpers/env'

/**
 * Malformed / torn agent files must never 500 an endpoint: the broken item
 * is skipped (or served degraded) with a warning, the response stays 200
 * and schema-valid. Readers open files per request, so overlaying breakage
 * after boot exercises the real paths.
 */

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
  copyFileSync(fixturePath('broken', 'inbox-torn-frontmatter.md'), join(env.paths.inboxDir, 'torn-note.md'))
  copyFileSync(fixturePath('broken', 'inbox-bad-yaml.md'), join(env.paths.inboxDir, 'bad-yaml-note.md'))
  copyFileSync(fixturePath('broken', 'inbox-torn-frontmatter.md'), join(env.paths.briefsDir, 'torn-brief.md'))
  copyFileSync(fixturePath('broken', 'reminders-naive-datetime.json'), env.paths.remindersPath)
  copyFileSync(fixturePath('broken', 'gateway_state-torn.json'), env.paths.gatewayStatePath)
  copyFileSync(fixturePath('broken', 'jobs-torn.json'), env.paths.jobsPath)
  // state.db gone entirely — sqlite-backed features must degrade to empty
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(env.paths.stateDbPath + suffix, { force: true })
  }
})
afterAll(async () => {
  await env.close()
})

const ENDPOINTS: { path: string; schema: ZodType }[] = [
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
  { path: '/api/briefs', schema: BriefsResponse },
  { path: '/api/inbox', schema: InboxResponse },
  { path: '/api/reminders', schema: RemindersResponse },
  { path: '/api/search?q=%D0%B1%D0%B0%D0%BD%D0%BA', schema: SearchResponse },
]

describe('broken fixtures: no endpoint 500s', () => {
  for (const { path, schema } of ENDPOINTS) {
    const route = path.split('?')[0] ?? path
    it(`${route} → 200 + schema-valid despite torn/malformed sources`, async () => {
      const r = await env.get(path)
      expect(r.status).toBe(200)
      const parsed = schema.safeParse(r.json)
      if (!parsed.success) {
        throw new Error(`${route}: ${JSON.stringify(parsed.error.issues, null, 2)}`)
      }
      console.log(`  ✓ ${route} — degraded gracefully, still schema-valid`)
    })
  }

  it('inbox: torn-frontmatter note skipped, junk-yaml note served body-only', async () => {
    const inbox = InboxResponse.parse((await env.get('/api/inbox')).json)
    const ids = inbox.items.map((i) => i.id)
    expect(ids).not.toContain('torn-note')
    expect(ids).toContain('bad-yaml-note')
    expect(inbox.items.find((i) => i.id === 'bad-yaml-note')?.text).toContain('тело должно выжить')
    expect(ids).toContain('pozvonit-v-bank-0930') // healthy notes unaffected
  })

  it('reminders: naive-datetime and missing-title items skipped, good item served', async () => {
    const r = RemindersResponse.parse((await env.get('/api/reminders')).json)
    expect(r.items.map((i) => i.id)).toEqual(['good-one'])
  })

  it('status: torn gateway json → alive false, torn jobs json → no cron jobs, no state.db → zero spend', async () => {
    const s = AgentStatus.parse((await env.get('/api/status')).json)
    expect(s.gateway.alive).toBe(false)
    expect(s.cronJobs).toEqual([])
    expect(s.tokenSpend).toEqual({ todayUsd: 0, monthUsd: 0 })
  })

  it('warnings were logged for every degraded source', () => {
    const warned = env.logs.filter((l) => l.includes('"warn"')).join('\n')
    expect(warned).toContain('unterminated frontmatter')
    expect(warned).toContain('bad datetime')
    expect(warned).toContain('malformed json')
    expect(warned).toContain('state.db unavailable')
  })

  it('writes still work while reads are degraded (capture 201)', async () => {
    const r = await env.post('/api/capture', { text: 'запись при деградации', tags: [] })
    expect(r.status).toBe(201)
  })
})
