import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FollowupActionResponse, TimelineResponse, TodaySummary } from '../contract/schemas/index'
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
