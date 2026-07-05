import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BriefDetail, BriefsResponse, TodaySummary } from '../contract/schemas/index'
import { toWarsawDate } from '../src/lib/time.js'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * vault/system/briefs/*.md → /api/briefs, /api/briefs/{id}, and the
 * today.brief pointer. Frontmatter is agent-written and may be broken —
 * every field falls back (kind → adhoc, title → filename, date → filename).
 */

let env: TestEnv
const today = toWarsawDate(new Date())

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('GET /api/briefs', () => {
  it('lists newest first inside the 90-day window', async () => {
    const r = BriefsResponse.parse((await env.get('/api/briefs')).json)
    const ids = r.items.map((i) => i.id)
    expect(ids[0]).toBe(`${today}-morning`)
    expect(ids).toContain(`${env.briefDates.recent}-rynok`)
    expect(ids).not.toContain(`${env.briefDates.old}-staryy`) // 120 days ago → outside
    // sorted by date, newest first
    const dates = r.items.map((i) => i.date)
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('missing kind falls back to adhoc, morning kept for the morning brief', async () => {
    const r = BriefsResponse.parse((await env.get('/api/briefs')).json)
    expect(r.items.find((i) => i.id === `${today}-morning`)?.kind).toBe('morning')
    expect(r.items.find((i) => i.id.endsWith('-rynok'))?.kind).toBe('adhoc')
  })

  it('file without frontmatter: title ← filename, kind ← adhoc, still schema-valid', async () => {
    writeFileSync(
      join(env.paths.briefsDir, 'zametka-bez-frontmattera.md'),
      'Просто текст брифа без фронтматтера.\nВторая строка.\n',
      'utf8',
    )
    const r = BriefsResponse.parse((await env.get('/api/briefs')).json)
    const item = r.items.find((i) => i.id === 'zametka-bez-frontmattera')
    expect(item).toBeDefined()
    expect(item?.title).toBe('zametka-bez-frontmattera')
    expect(item?.kind).toBe('adhoc')
  })

  it('torn frontmatter (fence never closes) → file skipped, endpoint stays 200', async () => {
    writeFileSync(
      join(env.paths.briefsDir, `${today}-torn.md`),
      `---\ndate: ${today}\ntitle: Torn brief\n`,
      'utf8',
    )
    const res = await env.get('/api/briefs')
    expect(res.status).toBe(200)
    const r = BriefsResponse.parse(res.json)
    expect(r.items.find((i) => i.id === `${today}-torn`)).toBeUndefined()
  })
})

describe('GET /api/briefs/{id}', () => {
  it('serves frontmatter-free markdown and mtime-based generatedAt', async () => {
    const r = await env.get(`/api/briefs/${today}-morning`)
    expect(r.status).toBe(200)
    const brief = BriefDetail.parse(r.json)
    expect(brief).toMatchObject({
      id: `${today}-morning`,
      date: today,
      title: 'Утренний бриф',
      kind: 'morning',
    })
    expect(brief.markdown).toContain('Главное')
    expect(brief.markdown).not.toContain('---')
    expect(brief.markdown).not.toContain('kind:')
    expect(brief.generatedAt).toMatch(/[+-]\d{2}:\d{2}$/)
  })

  it('unknown id → 404; traversal-looking id → 404, not an escape', async () => {
    expect((await env.get('/api/briefs/net-takogo')).status).toBe(404)
    expect((await env.get(`/api/briefs/${encodeURIComponent('../../followups')}`)).status).toBe(404)
  })
})

describe('today.brief pointer', () => {
  it("names today's freshest morning brief", async () => {
    const t = TodaySummary.parse((await env.get('/api/today')).json)
    expect(t.brief).toEqual({ id: `${today}-morning`, title: 'Утренний бриф' })
  })

  it('absent when no morning brief exists for today', async () => {
    rmSync(join(env.paths.briefsDir, `${today}-morning.md`))
    const t = TodaySummary.parse((await env.get('/api/today')).json)
    expect(t.brief).toBeUndefined()
  })
})
