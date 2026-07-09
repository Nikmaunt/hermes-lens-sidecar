import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FollowupActionResponse,
  SomedayResponse,
  TimelineResponse,
  TodaySummary,
} from '../contract/schemas/index'
import { sha256Hex } from '../src/lib/hash.js'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * The someday flow, follow-up side: {action:"someday"} on the EXISTING
 * POST /api/followups/{id}/action parks a follow-up on the someday list.
 * The sidecar only queues the request (type "followup", verbatim line);
 * the agent's cron moves the line into vault/someday.md. Overlay, replay,
 * gone and undo semantics are exactly those of done/snooze.
 */

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

async function todayFollowUps(): Promise<TodaySummary['followUps']> {
  return TodaySummary.parse((await env.get('/api/today')).json).followUps
}

describe('followup action: someday (park without a date)', () => {
  let id = ''

  it('queues a followup-type file with the verbatim line and no until', async () => {
    const fu = (await todayFollowUps())[0]
    expect(fu).toBeDefined()
    id = fu?.id ?? ''

    const r = await env.post(`/api/followups/${id}/action`, { action: 'someday' })
    expect(r.status).toBe(200)
    expect(FollowupActionResponse.parse(r.json)).toEqual({ status: 'ok', itemId: id })

    const files = env.listQueueFiles().filter((f) => f.includes(`-followup-${id}`))
    expect(files).toHaveLength(1)
    const queued = JSON.parse(
      readFileSync(`${env.paths.lensQueueDir}/${files[0]}`, 'utf8'),
    ) as Record<string, unknown>
    expect(queued).toMatchObject({ type: 'followup', itemId: id, action: 'someday' })
    expect(queued.until).toBeUndefined()
    // verbatim followups.md line — the agent locates the item by it
    expect(readFileSync(env.paths.followupsPath, 'utf8')).toContain(queued.line as string)
  })

  it('replay of the same (itemId, someday) → same success, still one queue file', async () => {
    const r = await env.post(`/api/followups/${id}/action`, { action: 'someday' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ status: 'ok', itemId: id })
    expect(env.listQueueFiles().filter((f) => f.includes(`-followup-${id}`))).toHaveLength(1)
  })

  it('/api/today overlays pendingAction {action:"someday"} while the file exists', async () => {
    const fu = (await todayFollowUps()).find((f) => f.id === id)
    expect(fu?.pendingAction?.action).toBe('someday')
    expect(fu?.pendingAction?.until).toBeUndefined()
    expect(typeof fu?.pendingAction?.requestedAt).toBe('string')
  })

  it('journal: the queued someday action lands in /api/timeline as a system event', async () => {
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    const ev = t.events.find((e) => e.title === 'Follow-up action queued' && e.relatedId === id)
    expect(ev).toBeDefined()
    expect(ev?.category).toBe('system')
    expect(ev?.detail).toContain('someday')
  })

  it('undo recalls the pending someday: file deleted, overlay vanishes, replay → gone', async () => {
    const undo = await env.post(`/api/followups/${id}/action`, { action: 'undo' })
    expect(undo.status).toBe(200)
    expect(FollowupActionResponse.parse(undo.json)).toEqual({ status: 'ok', itemId: id })
    expect(env.listQueueFiles().filter((f) => f.includes(`-followup-${id}`))).toHaveLength(0)

    const fu = (await todayFollowUps()).find((f) => f.id === id)
    expect(fu?.pendingAction).toBeUndefined()

    const again = await env.post(`/api/followups/${id}/action`, { action: 'undo' })
    expect(again.json).toEqual({ status: 'gone', itemId: id })
  })

  it('id absent from followups.md → 200 {status:"gone"}, no queue file', async () => {
    const ghost = 'fu-feedc0ffee'
    const r = await env.post(`/api/followups/${ghost}/action`, { action: 'someday' })
    expect(r.status).toBe(200)
    expect(FollowupActionResponse.parse(r.json)).toEqual({ status: 'gone', itemId: ghost })
    expect(env.listQueueFiles().filter((f) => f.includes(`-followup-${ghost}`))).toHaveLength(0)
  })
})

/**
 * GET /api/someday — the parked list from vault/someday.md, per the agent's
 * SKILL.md line format `- [ ] описание (from [[NoteName]])`. The sidecar
 * NEVER creates the file; the agent's first parked item does.
 */

const UKULELE = '- [ ] научиться играть на укулеле (from [[muzykalnye-idei]])'
const LISBON = '- [ ] съездить в Лиссабон на выходные'

function somedayPath(e: TestEnv): string {
  return join(e.cfg.vaultDir, 'someday.md')
}

function writeSomedayFixture(e: TestEnv): void {
  writeFileSync(
    somedayPath(e),
    [
      '# Someday',
      '',
      UKULELE,
      LISBON,
      '- [x] прочитать «Дюну» (from [[knigi]])',
      '- [ ] [[2026-07-01]] — датированная строка: агент промахнулся файлом (from [[oshibka]])',
      '',
    ].join('\n'),
    'utf8',
  )
}

describe('GET /api/someday: parser and id form', () => {
  it('serves active items with sd-<hash> ids; source only when (from [[...]]) is present', async () => {
    writeSomedayFixture(env)
    const r = await env.get('/api/someday')
    expect(r.status).toBe(200)
    const body = SomedayResponse.parse(r.json)
    expect(typeof body.generatedAt).toBe('string')

    expect(body.items).toHaveLength(2)
    const [first, second] = body.items
    expect(first).toEqual({
      id: 'sd-' + sha256Hex(UKULELE).slice(0, 10),
      title: 'научиться играть на укулеле',
      source: 'muzykalnye-idei',
    })
    expect(second).toEqual({
      id: 'sd-' + sha256Hex(LISBON).slice(0, 10),
      title: 'съездить в Лиссабон на выходные',
    })
  })

  it('a dated [[YYYY-MM-DD]] — line is skipped with a warning (misfiled follow-up)', async () => {
    writeSomedayFixture(env)
    const before = env.logs.length
    const r = await env.get('/api/someday')
    const body = SomedayResponse.parse(r.json)
    expect(body.items.map((i) => i.title)).not.toContain(
      expect.stringContaining('датированная строка'),
    )
    const fresh = env.logs.slice(before).join('\n')
    expect(fresh).toMatch(/someday.*skipped/i)
  })

  it('missing file → empty list, 200 (fail-open, file is never created)', async () => {
    rmSync(somedayPath(env), { force: true })
    const r = await env.get('/api/someday')
    expect(r.status).toBe(200)
    expect(SomedayResponse.parse(r.json).items).toEqual([])
  })
})
