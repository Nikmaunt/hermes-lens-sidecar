import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NotificationCaptureResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * POST /api/notifications — the phone's notification listener posts one
 * sanitized notification per request; the sidecar files it into
 * vault/system/notif-inbox/ for the agent's triage cron (observation phase).
 * Same guarantees as capture: bearer auth, clientId dedup ledger, writes only
 * through Writer — plus a total-size cap and a sliding-window rate limit.
 */

const POSTED_AT = '2026-07-11T09:15:00+02:00'

function makeNotif(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: 'notif-client-0001-abcdef',
    package: 'com.google.android.gm',
    postedAt: POSTED_AT,
    capturedAt: '2026-07-11T09:15:03+02:00',
    title: 'Новое письмо от Олега',
    text: 'Контракт: финальная версия во вложении',
    ...over,
  }
}

function notifDir(env: TestEnv): string {
  return join(env.root, 'vault', 'system', 'notif-inbox')
}

function listNotifFiles(env: TestEnv): string[] {
  try {
    return readdirSync(notifDir(env))
  } catch {
    return []
  }
}

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('auth and validation', () => {
  it('401 without token, 401 with wrong token', async () => {
    const noToken = await env.post('/api/notifications', makeNotif(), null)
    expect(noToken.status).toBe(401)
    expect(noToken.json).toEqual({ error: 'unauthorized' })
    const badToken = await env.post('/api/notifications', makeNotif(), 'wrong-token-wrong-token-wrong')
    expect(badToken.status).toBe(401)
  })

  it('400 on schema violations: missing package, short clientId, non-string title, oversized single field', async () => {
    const cases: Record<string, unknown>[] = [
      makeNotif({ package: undefined }),
      makeNotif({ clientId: 'short' }), // min 8
      makeNotif({ title: 42 }),
      makeNotif({ package: 'x'.repeat(101) }), // max 100
      makeNotif({ text: 'x'.repeat(4097) }), // per-field max 4096 → schema 400, not 413
      makeNotif({ bigText: 42 }),
    ]
    for (const body of cases) {
      const r = await env.post('/api/notifications', body)
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect((r.json as { error: string }).error).toBeTruthy()
    }
  })

  it('400 on unparseable postedAt (the file name derives from it)', async () => {
    const r = await env.post('/api/notifications', makeNotif({ postedAt: 'not-a-date' }))
    expect(r.status).toBe(400)
  })

  it('413 {error:"record too large"} when text+bigText together exceed 4 KiB', async () => {
    const r = await env.post(
      '/api/notifications',
      makeNotif({ text: 'a'.repeat(3000), bigText: 'b'.repeat(3000) }),
    )
    expect(r.status).toBe(413)
    expect(r.json).toEqual({ error: 'record too large' })
    expect(listNotifFiles(env)).toEqual([])
  })
})

describe('write, file format, dedup', () => {
  it('201 → file lands in notif-inbox with the designed name and frontmatter', async () => {
    const inboxBefore = env.listInboxFiles()
    const r = await env.post('/api/notifications', makeNotif())
    expect(r.status).toBe(201)
    const body = NotificationCaptureResponse.parse(r.json)
    expect(body.status).toBe('ok')

    const files = listNotifFiles(env)
    expect(files).toHaveLength(1)
    const name = files[0] ?? ''
    // <postTimeMs>-<pkgShort>-<hash8>.md; pkgShort = last package segment
    expect(name).toMatch(/^\d{13}-gm-[0-9a-f]{8}\.md$/)
    expect(name.startsWith(`${Date.parse(POSTED_AT)}-gm-`)).toBe(true)
    expect(body.itemId).toBe(name.replace(/\.md$/, ''))

    const raw = readFileSync(join(notifDir(env), name), 'utf8')
    expect(raw.startsWith('---\n')).toBe(true)
    const fmEnd = raw.indexOf('\n---\n', 4)
    expect(fmEnd).toBeGreaterThan(0)
    const fm = raw.slice(4, fmEnd).split('\n')
    expect(fm).toContain('source: notification')
    expect(fm).toContain('package: com.google.android.gm')
    expect(fm).toContain(`postedAt: ${POSTED_AT}`)
    expect(fm).toContain('title: "Новое письмо от Олега"')
    expect(fm).toContain('clientId: notif-client-0001-abcdef')
    const bodyText = raw.slice(fmEnd + 5)
    expect(bodyText).toContain('Контракт: финальная версия во вложении')

    // notification writes never touch the capture inbox
    expect(env.listInboxFiles()).toEqual(inboxBefore)
  })

  it('replaying the same clientId → 200 {status:"duplicate"}, same itemId, no second file', async () => {
    const before = listNotifFiles(env).length
    const first = await env.post('/api/notifications', makeNotif({ clientId: 'dedup-client-01' }))
    expect(first.status).toBe(201)
    const firstBody = NotificationCaptureResponse.parse(first.json)

    const replay = await env.post('/api/notifications', makeNotif({ clientId: 'dedup-client-01' }))
    expect(replay.status).toBe(200)
    const replayBody = NotificationCaptureResponse.parse(replay.json)
    expect(replayBody.status).toBe('duplicate')
    expect(replayBody.itemId).toBe(firstBody.itemId)

    expect(listNotifFiles(env)).toHaveLength(before + 1)
  })

  it('bigText is appended to the body only when present and different from text', async () => {
    const r = await env.post(
      '/api/notifications',
      makeNotif({
        clientId: 'bigtext-client-01',
        title: 'Заголовок',
        text: 'Краткий текст',
        bigText: 'Краткий текст, но с развёрнутым продолжением',
      }),
    )
    expect(r.status).toBe(201)
    const itemId = NotificationCaptureResponse.parse(r.json).itemId
    const raw = readFileSync(join(notifDir(env), `${itemId}.md`), 'utf8')
    expect(raw).toContain('Краткий текст, но с развёрнутым продолжением')

    const same = await env.post(
      '/api/notifications',
      makeNotif({ clientId: 'bigtext-client-02', text: 'Одинаково', bigText: 'Одинаково' }),
    )
    expect(same.status).toBe(201)
    const sameId = NotificationCaptureResponse.parse(same.json).itemId
    const sameRaw = readFileSync(join(notifDir(env), `${sameId}.md`), 'utf8')
    expect(sameRaw.split('Одинаково')).toHaveLength(2) // body carries the text once
  })

  it('accepted notification appears in /api/timeline as a system event', async () => {
    const r = (await env.get('/api/timeline')).json as {
      events: { category: string; title: string }[]
    }
    const notif = r.events.filter((e) => e.title === 'Notification captured')
    expect(notif.length).toBeGreaterThan(0)
    expect(notif.every((e) => e.category === 'system')).toBe(true)
  })
})

describe('write surface stays narrow', () => {
  it('deleteRoot is still lens-queue only — the agent consumes notif-inbox, the sidecar never deletes there', () => {
    const fswrite = readFileSync(join(import.meta.dirname, '..', 'src', 'writes', 'fswrite.ts'), 'utf8')
    expect(fswrite).toContain('this.deleteRoot = resolve(opts.lensQueueDir)')
    expect(fswrite.match(/this\.deleteRoot\s*=/g)).toHaveLength(1)
  })

  it('neither the token nor notification content ever reaches the logs', () => {
    const joined = env.logs.join('\n')
    expect(joined).not.toContain(env.token)
    expect(joined).not.toContain('Новое письмо от Олега')
    expect(joined).not.toContain('Контракт: финальная версия')
  })
})

describe('rate limit — sliding window, 120 records/hour', () => {
  let fresh: TestEnv
  beforeAll(async () => {
    fresh = await buildEnv()
  })
  afterAll(async () => {
    await fresh.close()
  })

  it('the 120th record in the window passes, the 121st answers 429 {error:"rate limited"}', { timeout: 30_000 }, async () => {
    for (let i = 1; i <= 120; i++) {
      const r = await fresh.post('/api/notifications', makeNotif({ clientId: `rate-client-${String(i).padStart(4, '0')}` }))
      expect(r.status, `record #${i} must pass`).toBe(201)
    }
    const over = await fresh.post(
      '/api/notifications',
      makeNotif({ clientId: 'rate-client-0121' }),
    )
    expect(over.status).toBe(429)
    expect(over.json).toEqual({ error: 'rate limited' })
    expect(listNotifFiles(fresh)).toHaveLength(120)
  })
})
