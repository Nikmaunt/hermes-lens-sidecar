import { existsSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CaptureResponse, InboxResponse, MemoryResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('capture idempotency (clientId dedup ledger)', () => {
  it('replaying the same clientId returns the first response and writes exactly one file', async () => {
    const before = env.listInboxFiles().length
    const req = {
      text: 'Проверить страховку на новый ноутбук',
      tags: ['money', 'documents'],
      clientId: '9f4b2c1e-7d31-4c1a-9b64-0a4d5e8f1c22',
    }
    const first = await env.post('/api/capture', req)
    expect(first.status).toBe(201)
    const firstBody = CaptureResponse.parse(first.json)

    const replay = await env.post('/api/capture', req)
    expect(replay.status).toBe(200) // replay: same body, not a new resource
    expect(replay.json).toEqual(firstBody)

    expect(env.listInboxFiles().length).toBe(before + 1)

    // the note landed in agent format with the sidecar marker
    const noteRaw = readFileSync(`${env.paths.inboxDir}/${firstBody.id}.md`, 'utf8')
    expect(noteRaw).toContain('via: hermes-lens')
    expect(noteRaw).toContain('tags: [money, documents]')
    const inbox = InboxResponse.parse((await env.get('/api/inbox')).json)
    const item = inbox.items.find((i) => i.id === firstBody.id)
    expect(item?.source).toBe('capture')
    expect(item?.tags).toContain('money')
  })

  it('captures without clientId are taken at face value (two files)', async () => {
    const before = env.listInboxFiles().length
    await env.post('/api/capture', { text: 'Без clientId раз', tags: [] })
    await env.post('/api/capture', { text: 'Без clientId раз', tags: [] })
    expect(env.listInboxFiles().length).toBe(before + 2)
  })

  it('rejects invalid capture bodies with 400 {error}', async () => {
    const r = await env.post('/api/capture', { tags: ['no-text'] })
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toBeTruthy()
  })
})

describe('triage idempotency (lens-queue)', () => {
  it('repeat triage → same success shape, exactly one queue file; item hidden from inbox', async () => {
    const inbox = InboxResponse.parse((await env.get('/api/inbox')).json)
    const target = inbox.items.find((i) => i.id === 'kupit-bilety-na-poezd-1815')
    expect(target).toBeDefined()
    const id = target?.id ?? ''

    const first = await env.post(`/api/inbox/${id}/triage`, { destination: 'archive' })
    expect(first.status).toBe(200)
    expect(first.json).toEqual({ status: 'ok', itemId: id })

    const repeat = await env.post(`/api/inbox/${id}/triage`, { destination: 'archive' })
    expect(repeat.status).toBe(200)
    expect(repeat.json).toEqual(first.json)

    const triageFiles = env.listQueueFiles().filter((f) => f.includes(`-triage-${id}`))
    expect(triageFiles).toHaveLength(1)
    const queued = JSON.parse(
      readFileSync(`${env.paths.lensQueueDir}/${triageFiles[0]}`, 'utf8'),
    ) as Record<string, unknown>
    expect(queued).toMatchObject({ type: 'triage', itemId: id, destination: 'archive' })
    expect(typeof queued.requestedAt).toBe('string')

    const after = InboxResponse.parse((await env.get('/api/inbox')).json)
    expect(after.items.find((i) => i.id === id)).toBeUndefined()
  })

  it('invalid destination → 400; path-traversal id → 400', async () => {
    const bad = await env.post('/api/inbox/whatever/triage', { destination: 'yeet' })
    expect(bad.status).toBe(400)
    const evil = await env.post(`/api/inbox/${encodeURIComponent('../../etc/passwd')}/triage`, {
      destination: 'note',
    })
    expect(evil.status).toBe(400)
  })
})

describe('flag idempotency (lens-queue) + sidecar-side masking', () => {
  it('repeat flag → same shape, one queue file; pendingFlag served; mark-sensitive masks now', async () => {
    const memory = MemoryResponse.parse((await env.get('/api/memory')).json)
    const target = memory.items.find((i) => i.fact.includes('эспрессо'))
    expect(target).toBeDefined()
    const id = target?.id ?? ''

    const first = await env.post(`/api/memory/${id}/flag`, {
      action: 'mark-sensitive',
      reason: 'приватное',
    })
    expect(first.json).toEqual({ status: 'pending', itemId: id })
    const repeat = await env.post(`/api/memory/${id}/flag`, { action: 'mark-sensitive' })
    expect(repeat.json).toEqual(first.json)

    expect(env.listQueueFiles().filter((f) => f.includes(`-flag-${id}`))).toHaveLength(1)

    const after = MemoryResponse.parse((await env.get('/api/memory')).json)
    const item = after.items.find((i) => i.id === id)
    expect(item?.pendingFlag?.action).toBe('mark-sensitive')
    expect(item?.pendingFlag?.status).toBe('pending')
    expect(item?.sensitivity).toBe('sensitive') // masked before the agent confirms
  })

  it('forget flag sets pendingFlag but does not mask', async () => {
    const memory = MemoryResponse.parse((await env.get('/api/memory')).json)
    const target = memory.items.find((i) => i.fact.includes('Сиэтле'))
    const id = target?.id ?? ''
    await env.post(`/api/memory/${id}/flag`, { action: 'forget' })
    const after = MemoryResponse.parse((await env.get('/api/memory')).json)
    const item = after.items.find((i) => i.id === id)
    expect(item?.pendingFlag?.action).toBe('forget')
    expect(item?.sensitivity).toBe('normal')
  })
})

describe('sync-ack idempotency', () => {
  it('repeat ack → ok; last-sync.json overwritten with the latest', async () => {
    const body = { syncedAt: '2026-07-05T12:00:00+02:00', lastSeenRevision: 'rev-first' }
    expect((await env.post('/api/sync/ack', body)).json).toEqual({ status: 'ok' })
    expect((await env.post('/api/sync/ack', body)).json).toEqual({ status: 'ok' })
    const again = { syncedAt: '2026-07-05T13:00:00+02:00', lastSeenRevision: 'rev-second' }
    expect((await env.post('/api/sync/ack', again)).json).toEqual({ status: 'ok' })

    expect(existsSync(env.paths.lastSyncPath)).toBe(true)
    const saved = JSON.parse(readFileSync(env.paths.lastSyncPath, 'utf8')) as Record<string, unknown>
    expect(saved.lastSeenRevision).toBe('rev-second')
    expect(typeof saved.receivedAt).toBe('string')
  })

  it('malformed ack (naive datetime) → 400', async () => {
    const r = await env.post('/api/sync/ack', { syncedAt: '2026-07-05T12:00:00', lastSeenRevision: 'x' })
    expect(r.status).toBe(400)
  })
})

describe('write-journal feeds /api/timeline', () => {
  it('sidecar-performed capture/triage/flag/ack appear as capture/system events', async () => {
    const r = (await env.get('/api/timeline')).json as {
      events: { id: string; category: string; title: string }[]
    }
    const titles = r.events.map((e) => e.title)
    expect(titles).toContain('Inbox triage queued')
    expect(titles).toContain('Memory flag queued')
    expect(titles).toContain('Reminders sync acknowledged')
    expect(
      r.events.filter((e) => e.title === 'Inbox triage queued').every((e) => e.category === 'system'),
    ).toBe(true)
    // the captured note is a capture event (live file wins over journal dup)
    expect(r.events.some((e) => e.category === 'capture' && e.id.startsWith('note-'))).toBe(true)
  })
})
