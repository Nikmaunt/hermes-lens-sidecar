import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DecisionsResponse } from '../contract/schemas/index'
import { createLogger } from '../src/lib/log.js'
import { readDecisions } from '../src/readers/decisions.js'
import { buildEnv, fixturePath, type TestEnv } from './helpers/env'

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

const silentLog = createLogger(() => {})

describe('decisions.md parser', () => {
  it('parses blocks with all bullets, splits alternatives on ";"', () => {
    const items = readDecisions(fixturePath('vault', 'decisions.md'), silentLog)
    const cloudbox = items.find((d) => d.title === 'Хостинг остаётся на CloudBox')
    expect(cloudbox).toMatchObject({
      decidedOn: '2026-06-20',
      context: 'продление VPS в декабре 2026',
      reasoning: 'дешевле аналогов, стабильный аптайм',
      alternatives: ['Hetzner CX22', 'OVH VPS'],
      revisitBy: '2026-11-01',
      projectId: 'hermes',
    })
    expect(cloudbox?.id).toMatch(/^dec-[0-9a-f]{10}$/)
  })

  it('missing bullets → empty strings / empty array / nulls; bad revisit date → null', () => {
    const items = readDecisions(fixturePath('vault', 'decisions.md'), silentLog)
    const bare = items.find((d) => d.title === 'Решение без буллетов')
    expect(bare).toMatchObject({
      decidedOn: '2026-07-01',
      context: '',
      reasoning: '',
      alternatives: [],
      projectId: null,
      revisitBy: null,
    })
    // 'пересмотреть: скоро' is not a date
    expect(items.find((d) => d.title === 'Приложение пишем на Capacitor')?.revisitBy).toBeNull()
  })

  it('heading without a date is skipped with its bullets; newest first', () => {
    const items = readDecisions(fixturePath('vault', 'decisions.md'), silentLog)
    expect(items).toHaveLength(3)
    expect(items.map((d) => d.decidedOn)).toEqual(['2026-07-01', '2026-06-20', '2026-05-02'])
    expect(items.some((d) => d.title.includes('кривой'))).toBe(false)
  })

  it('ids are stable content hashes of the heading', () => {
    const a = readDecisions(fixturePath('vault', 'decisions.md'), silentLog)
    const b = readDecisions(fixturePath('vault', 'decisions.md'), silentLog)
    expect(a.map((d) => d.id)).toEqual(b.map((d) => d.id))
    expect(new Set(a.map((d) => d.id)).size).toBe(a.length)
  })
})

describe('GET /api/decisions', () => {
  it('serves parsed decisions, schema-valid', async () => {
    const r = await env.get('/api/decisions')
    expect(r.status).toBe(200)
    const parsed = DecisionsResponse.parse(r.json)
    expect(parsed.decisions).toHaveLength(3)
  })

  it('?project= filters by project slug', async () => {
    const filtered = DecisionsResponse.parse((await env.get('/api/decisions?project=hermes')).json)
    expect(filtered.decisions).toHaveLength(1)
    expect(filtered.decisions[0]?.projectId).toBe('hermes')
    const none = DecisionsResponse.parse((await env.get('/api/decisions?project=nope')).json)
    expect(none.decisions).toEqual([])
  })

  it('garbage or empty decisions.md → 200 with empty list, never 500', async () => {
    for (const content of [']]]труха\n- почему: без заголовка\n## тоже — не дата\n', '']) {
      writeFileSync(env.paths.decisionsPath, content, 'utf8')
      const r = await env.get('/api/decisions')
      expect(r.status).toBe(200)
      expect(DecisionsResponse.parse(r.json).decisions).toEqual([])
    }
  })
})
