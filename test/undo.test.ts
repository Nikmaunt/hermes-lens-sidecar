import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FollowupActionResponse,
  HabitsResponse,
  HabitTickResponse,
  InboxResponse,
  TimelineResponse,
  TodaySummary,
  UntriageResponse,
} from '../contract/schemas/index'
import { Writer } from '../src/writes/fswrite.js'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * Undo semantics: an action can be recalled only while its lens-queue file
 * still exists (the agent has not consumed it). Undo = deleting that file;
 * every pending overlay derived from it must vanish naturally, because the
 * overlays re-read the queue directory on every GET.
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

function queueFilesFor(marker: string): string[] {
  return env.listQueueFiles().filter((f) => f.includes(marker))
}

describe('Writer: deletion allowed ONLY inside lens-queue', () => {
  it('refuses deleting vault notes, its own data dir, and the queue dir itself', () => {
    const writer = new Writer({
      inboxDir: env.paths.inboxDir,
      lensQueueDir: env.paths.lensQueueDir,
      lastSyncPath: env.paths.lastSyncPath,
      dataDir: env.paths.dataDir,
    })
    // inboxDir and dataDir are WRITE-allowed roots — deletion must still refuse
    for (const target of [
      join(env.paths.inboxDir, 'pozvonit-v-bank-0930.md'),
      join(env.paths.dataDir, 'journal.ndjson'),
      env.paths.lastSyncPath,
      env.paths.followupsPath,
      env.paths.lensQueueDir, // the dir itself is not a queue file
    ]) {
      expect(() => writer.deleteQueueFile(target), target).toThrow(/delete refused/)
    }
  })

  it('refuses path traversal escaping lens-queue and nested paths inside it', () => {
    const writer = new Writer({
      inboxDir: env.paths.inboxDir,
      lensQueueDir: env.paths.lensQueueDir,
      lastSyncPath: env.paths.lastSyncPath,
      dataDir: env.paths.dataDir,
    })
    for (const target of [
      join(env.paths.lensQueueDir, '..', 'inbox', 'pozvonit-v-bank-0930.md'),
      join(env.paths.lensQueueDir, '..', '..', 'followups.md'),
      join(env.paths.lensQueueDir, 'sub', 'x.json'), // same direct-child rule as writes
    ]) {
      expect(() => writer.deleteQueueFile(target), target).toThrow(/delete refused/)
    }
  })

  it('deleting an already-gone queue file reports false, never throws', () => {
    const writer = new Writer({
      inboxDir: env.paths.inboxDir,
      lensQueueDir: env.paths.lensQueueDir,
      lastSyncPath: env.paths.lastSyncPath,
      dataDir: env.paths.dataDir,
    })
    expect(writer.deleteQueueFile(join(env.paths.lensQueueDir, 'nope.json'))).toBe(false)
  })
})

describe('followup undo (POST /api/followups/{id}/action {action:"undo"})', () => {
  let id = ''

  it('undoes a queued done: 200 ok, queue file deleted', async () => {
    const fu = (await todayFollowUps())[0]
    expect(fu).toBeDefined()
    id = fu?.id ?? ''

    await env.post(`/api/followups/${id}/action`, { action: 'done' })
    expect(queueFilesFor(`-followup-${id}`)).toHaveLength(1)

    const r = await env.post(`/api/followups/${id}/action`, { action: 'undo' })
    expect(r.status).toBe(200)
    expect(FollowupActionResponse.parse(r.json)).toEqual({ status: 'ok', itemId: id })
    expect(queueFilesFor(`-followup-${id}`)).toHaveLength(0)
  })

  it('overlay disappears: /api/today serves the item without pendingAction', async () => {
    const fu = (await todayFollowUps()).find((f) => f.id === id)
    expect(fu).toBeDefined()
    expect(fu?.pendingAction).toBeUndefined()
  })

  it('replaying undo → 200 gone (nothing pending anymore)', async () => {
    const r = await env.post(`/api/followups/${id}/action`, { action: 'undo' })
    expect(r.status).toBe(200)
    expect(FollowupActionResponse.parse(r.json)).toEqual({ status: 'gone', itemId: id })
  })

  it('undo for an item that was never queued → 200 gone, no journal noise', async () => {
    const fu = (await todayFollowUps())[2]
    const r = await env.post(`/api/followups/${fu?.id}/action`, { action: 'undo' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ status: 'gone', itemId: fu?.id })
  })

  it('undo deletes ALL pending queue files of the item (done, then snooze)', async () => {
    const fu = (await todayFollowUps())[1]
    const target = fu?.id ?? ''
    await env.post(`/api/followups/${target}/action`, { action: 'done' })
    await env.post(`/api/followups/${target}/action`, { action: 'snooze', until: '2026-12-24' })
    expect(queueFilesFor(`-followup-${target}`)).toHaveLength(2)

    const r = await env.post(`/api/followups/${target}/action`, { action: 'undo' })
    expect(r.json).toEqual({ status: 'ok', itemId: target })
    expect(queueFilesFor(`-followup-${target}`)).toHaveLength(0)
  })

  it('journal: followup-undo lands in /api/timeline as a system event', async () => {
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    // find by (title, relatedId): the suite performs several undos, and when
    // two land in different seconds the newest-first sort makes plain
    // find-by-title return the OTHER item's event (rare, timing-dependent).
    const ev = t.events.find((e) => e.title === 'Follow-up action undone' && e.relatedId === id)
    expect(ev).toBeDefined()
    expect(ev?.category).toBe('system')
  })

  it('unrelated queue files survive an undo', async () => {
    // a habit tick queued before the undo below must remain untouched
    await env.post('/api/habits/hab-ispanskiy-yazyk/tick', { date: '2026-07-04' })
    const fu = (await todayFollowUps())[0]
    await env.post(`/api/followups/${fu?.id}/action`, { action: 'done' })
    await env.post(`/api/followups/${fu?.id}/action`, { action: 'undo' })
    expect(queueFilesFor('-habit-tick-hab-ispanskiy-yazyk')).toHaveLength(1)
  })
})

describe('habit tick undo (POST /api/habits/{id}/tick {date, undo:true})', () => {
  it('undoes a pending tick: 200 ok, file deleted, overlay date vanishes', async () => {
    await env.post('/api/habits/hab-zaryadka/tick', { date: '2026-07-04' })
    expect(queueFilesFor('-habit-tick-hab-zaryadka')).toHaveLength(1)
    const before = HabitsResponse.parse((await env.get('/api/habits')).json)
    expect(before.habits.find((h) => h.id === 'hab-zaryadka')?.completedDates).toContain('2026-07-04')

    const r = await env.post('/api/habits/hab-zaryadka/tick', { date: '2026-07-04', undo: true })
    expect(r.status).toBe(200)
    expect(HabitTickResponse.parse(r.json)).toEqual({ status: 'ok', itemId: 'hab-zaryadka' })
    expect(queueFilesFor('-habit-tick-hab-zaryadka')).toHaveLength(0)

    const after = HabitsResponse.parse((await env.get('/api/habits')).json)
    expect(after.habits.find((h) => h.id === 'hab-zaryadka')?.completedDates).toEqual([
      '2026-06-30',
      '2026-07-01',
      '2026-07-03',
    ])
  })

  it('replaying the undo → 200 gone', async () => {
    const r = await env.post('/api/habits/hab-zaryadka/tick', { date: '2026-07-04', undo: true })
    expect(r.status).toBe(200)
    expect(HabitTickResponse.parse(r.json)).toEqual({ status: 'gone', itemId: 'hab-zaryadka' })
  })

  it('a date already recorded in habits.md is NOT pending → gone, date stays', async () => {
    const r = await env.post('/api/habits/hab-zaryadka/tick', { date: '2026-07-01', undo: true })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ status: 'gone', itemId: 'hab-zaryadka' })
    const habits = HabitsResponse.parse((await env.get('/api/habits')).json)
    expect(habits.habits.find((h) => h.id === 'hab-zaryadka')?.completedDates).toContain('2026-07-01')
  })

  it('undo only unions with tick validation: bad date or non-true undo → 400', async () => {
    for (const body of [{ undo: true }, { date: 'вчера', undo: true }, { date: '2026-07-04', undo: 'yes' }]) {
      const r = await env.post('/api/habits/hab-zaryadka/tick', body)
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe('untriage (POST /api/inbox/{id}/untriage)', () => {
  const bank = 'pozvonit-v-bank-0930'
  const visit = 'osmotr-kotla-1900'

  it('pending triage cancelled: 200 ok, item visible in /api/inbox again', async () => {
    await env.post(`/api/inbox/${bank}/triage`, { destination: 'archive' })
    await env.post(`/api/inbox/${visit}/triage`, { destination: 'note' })
    const hidden = InboxResponse.parse((await env.get('/api/inbox')).json)
    expect(hidden.items.find((i) => i.id === bank)).toBeUndefined()

    const r = await env.post(`/api/inbox/${bank}/untriage`, {})
    expect(r.status).toBe(200)
    expect(UntriageResponse.parse(r.json)).toEqual({ status: 'ok', itemId: bank })

    const after = InboxResponse.parse((await env.get('/api/inbox')).json)
    expect(after.items.find((i) => i.id === bank)).toBeDefined()
    // the OTHER item's triage is untouched: still hidden, file still queued
    expect(after.items.find((i) => i.id === visit)).toBeUndefined()
    expect(queueFilesFor(`-triage-${visit}`)).toHaveLength(1)
    expect(queueFilesFor(`-triage-${bank}`)).toHaveLength(0)
  })

  it('repeat untriage → 200 gone (idempotent)', async () => {
    const r = await env.post(`/api/inbox/${bank}/untriage`, {})
    expect(r.status).toBe(200)
    expect(UntriageResponse.parse(r.json)).toEqual({ status: 'gone', itemId: bank })
  })

  it('never-triaged id → gone; path-traversal id → 400', async () => {
    const gone = await env.post('/api/inbox/nikogda-ne-bylo/untriage', {})
    expect(gone.status).toBe(200)
    expect(UntriageResponse.parse(gone.json)).toEqual({ status: 'gone', itemId: 'nikogda-ne-bylo' })

    const evil = await env.post(`/api/inbox/${encodeURIComponent('../../etc/passwd')}/untriage`, {})
    expect(evil.status).toBe(400)
  })

  it('untriaged item can be triaged again (fresh queue file)', async () => {
    const r = await env.post(`/api/inbox/${bank}/triage`, { destination: 'note' })
    expect(r.status).toBe(200)
    expect(queueFilesFor(`-triage-${bank}`)).toHaveLength(1)
    const queued = JSON.parse(
      readFileSync(join(env.paths.lensQueueDir, queueFilesFor(`-triage-${bank}`)[0] ?? ''), 'utf8'),
    ) as Record<string, unknown>
    expect(queued).toMatchObject({ type: 'triage', itemId: bank, destination: 'note' })
  })
})

describe('undo paths hygiene', () => {
  it('vault notes and followups.md are untouched by all the undo traffic above', () => {
    expect(existsSync(join(env.paths.inboxDir, 'pozvonit-v-bank-0930.md'))).toBe(true)
    expect(readFileSync(env.paths.followupsPath, 'utf8')).toContain('ответить Олегу')
  })

  it('the bearer token never appears in any log line (undo paths included)', () => {
    expect(env.logs.length).toBeGreaterThan(0)
    expect(env.logs.join('\n')).not.toContain(env.token)
  })
})
