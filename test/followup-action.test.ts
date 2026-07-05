import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FollowupActionResponse, TimelineResponse, TodaySummary } from '../contract/schemas/index'
import { sha256Hex } from '../src/lib/hash.js'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * POST /api/followups/{id}/action — done / snooze queued for the agent.
 * The agent cannot compute content hashes, so every queue file MUST carry
 * the verbatim followups.md line the id was derived from.
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

describe('followup action: done', () => {
  it('queues a file carrying the verbatim line whose hash is the item id', async () => {
    const fu = (await todayFollowUps())[0]
    expect(fu).toBeDefined()
    const id = fu?.id ?? ''

    const r = await env.post(`/api/followups/${id}/action`, { action: 'done' })
    expect(r.status).toBe(200)
    expect(FollowupActionResponse.parse(r.json)).toEqual({ status: 'ok', itemId: id })

    const files = env.listQueueFiles().filter((f) => f.includes(`-followup-${id}`))
    expect(files).toHaveLength(1)
    const queued = JSON.parse(
      readFileSync(`${env.paths.lensQueueDir}/${files[0]}`, 'utf8'),
    ) as Record<string, unknown>
    expect(queued).toMatchObject({ type: 'followup', itemId: id, action: 'done' })
    expect(queued.until).toBeUndefined()
    expect(typeof queued.requestedAt).toBe('string')

    // the line is verbatim from followups.md and hashes back to the id
    const line = queued.line as string
    expect(readFileSync(env.paths.followupsPath, 'utf8')).toContain(line)
    expect('fu-' + sha256Hex(line).slice(0, 10)).toBe(id)
  })

  it('replay of the same (itemId, action) → same success, still one queue file', async () => {
    const fu = (await todayFollowUps())[0]
    const id = fu?.id ?? ''
    const repeat = await env.post(`/api/followups/${id}/action`, { action: 'done' })
    expect(repeat.status).toBe(200)
    expect(repeat.json).toEqual({ status: 'ok', itemId: id })
    expect(env.listQueueFiles().filter((f) => f.includes(`-followup-${id}`))).toHaveLength(1)
  })

  it('/api/today serves the item with pendingAction while the queue file exists', async () => {
    const followUps = await todayFollowUps()
    const decorated = followUps[0]
    expect(decorated?.pendingAction?.action).toBe('done')
    expect(decorated?.pendingAction?.until).toBeUndefined()
    expect(typeof decorated?.pendingAction?.requestedAt).toBe('string')
    // untouched items carry no pendingAction
    expect(followUps[2]?.pendingAction).toBeUndefined()
  })

  it('the queued action appears in /api/timeline via the write-journal', async () => {
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    const ev = t.events.find((e) => e.title === 'Follow-up action queued')
    expect(ev).toBeDefined()
    expect(ev?.category).toBe('system')
  })
})

describe('followup action: snooze', () => {
  it('queues with until and overlays it into /api/today', async () => {
    const fu = (await todayFollowUps())[1]
    expect(fu).toBeDefined()
    const id = fu?.id ?? ''

    const r = await env.post(`/api/followups/${id}/action`, { action: 'snooze', until: '2026-12-24' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ status: 'ok', itemId: id })

    const files = env.listQueueFiles().filter((f) => f.includes(`-followup-${id}`))
    expect(files).toHaveLength(1)
    const queued = JSON.parse(
      readFileSync(`${env.paths.lensQueueDir}/${files[0]}`, 'utf8'),
    ) as Record<string, unknown>
    expect(queued).toMatchObject({ type: 'followup', itemId: id, action: 'snooze', until: '2026-12-24' })
    expect(typeof queued.line).toBe('string')

    const after = (await todayFollowUps()).find((f) => f.id === id)
    expect(after?.pendingAction).toMatchObject({ action: 'snooze', until: '2026-12-24' })
  })
})

describe('followup action: validation', () => {
  it('unknown action → 400', async () => {
    const fu = (await todayFollowUps())[2]
    const r = await env.post(`/api/followups/${fu?.id}/action`, { action: 'yeet' })
    expect(r.status).toBe(400)
  })

  it('snooze without until / with malformed or impossible until → 400', async () => {
    const fu = (await todayFollowUps())[2]
    for (const body of [
      { action: 'snooze' },
      { action: 'snooze', until: 'tomorrow' },
      { action: 'snooze', until: '2026-13-01' },
      { action: 'snooze', until: '2026-02-30' },
    ]) {
      const r = await env.post(`/api/followups/${fu?.id}/action`, body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    // no queue file was written for any rejected request
    expect(env.listQueueFiles().filter((f) => f.includes(`-followup-${fu?.id}`))).toHaveLength(0)
  })

  it('path-traversal id → 400', async () => {
    const r = await env.post(`/api/followups/${encodeURIComponent('../../etc/passwd')}/action`, {
      action: 'done',
    })
    expect(r.status).toBe(400)
  })
})

describe('followup action: gone semantics (offline replay, NOT 404)', () => {
  it('id absent from followups.md → 200 {status:"gone"} and no queue file', async () => {
    const id = 'fu-0123456789'
    const r = await env.post(`/api/followups/${id}/action`, { action: 'done' })
    expect(r.status).toBe(200)
    expect(FollowupActionResponse.parse(r.json)).toEqual({ status: 'gone', itemId: id })
    expect(env.listQueueFiles().filter((f) => f.includes(`-followup-${id}`))).toHaveLength(0)
  })

  it('replay for an already-queued id keeps succeeding even after the line vanished', async () => {
    const fu = (await todayFollowUps())[0]
    const id = fu?.id ?? ''
    // agent consumed the item: line disappears from followups.md but the
    // queue file is still there → replay answers ok (idempotent), not gone
    const raw = readFileSync(env.paths.followupsPath, 'utf8')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      env.paths.followupsPath,
      raw
        .split('\n')
        .filter((l) => !l.includes('ответить Олегу'))
        .join('\n'),
      'utf8',
    )
    const r = await env.post(`/api/followups/${id}/action`, { action: 'done' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ status: 'ok', itemId: id })
    writeFileSync(env.paths.followupsPath, raw, 'utf8')
  })
})
