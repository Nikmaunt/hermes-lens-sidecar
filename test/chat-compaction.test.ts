import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatStartResponse } from '../contract/schemas/index'
import { createLogger } from '../src/lib/log.js'
import { compactJobs } from '../src/chat/store.js'
import { Writer } from '../src/writes/fswrite.js'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * chat-jobs.ndjson compaction (§8.1 tail, privacy). The buffer accumulates
 * plaintext agent replies; TTL used to filter READS only, so the file grew
 * forever. Now every accepted turn rewrites the file with live records only
 * (atomic tmp + rename in the sidecar's own DATA_DIR): expired lines vanish
 * PHYSICALLY, live jobs keep polling, a malformed line never breaks a turn.
 */

let env: TestEnv
const TTL = 600_000

async function pollTerminal(jobId: string, timeoutMs = 10_000): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await env.get(`/api/chat/${jobId}`)
    const body = r.json as { status: string }
    if (body.status !== 'running') return body
    if (Date.now() > deadline) throw new Error(`poll timed out: ${JSON.stringify(body)}`)
    await new Promise((res) => setTimeout(res, 20))
  }
}

async function runTurn(message: string, clientId: string): Promise<string> {
  const start = await env.post('/api/chat', { message, clientId })
  expect(start.status).toBe(202)
  const { jobId } = ChatStartResponse.parse(start.json)
  const terminal = await pollTerminal(jobId)
  expect(terminal.status).toBe('done')
  return jobId
}

const fileText = (): string => readFileSync(env.paths.chatJobsPath, 'utf8')

const expiredLine = (tag: string): string =>
  JSON.stringify({
    jobId: `job-${tag}`,
    clientId: `c-${tag}`,
    sessionId: `sess-${tag}`,
    status: 'done',
    startedAtMs: Date.now() - TTL - 60_000,
    message: `старый вопрос ${tag}`,
    reply: `STALE-REPLY-${tag}`,
    finishedAt: '2026-01-01T00:00:00+01:00',
  }) + '\n'

beforeAll(async () => {
  env = await buildEnv({ chatTtlMs: TTL })
})
afterAll(async () => {
  await env.close()
})

describe('chat-jobs.ndjson compaction', () => {
  let firstJobId = ''

  it('expired records vanish from the file PHYSICALLY on the next accepted turn', async () => {
    firstJobId = await runTurn('Первый живой вопрос', 'compact-live-1')
    appendFileSync(env.paths.chatJobsPath, expiredLine('old-a'), 'utf8')
    expect(fileText()).toContain('STALE-REPLY-old-a')

    await runTurn('Второй живой вопрос', 'compact-live-2')
    const after = fileText()
    expect(after).not.toContain('STALE-REPLY-old-a') // reply gone from disk
    expect(after).not.toContain('старый вопрос old-a') // message gone too
    expect(after).toContain(firstJobId) // live record survived
  })

  it('live jobs survive compaction: polling still answers with the reply', async () => {
    const r = await env.get(`/api/chat/${firstJobId}`)
    expect(r.status).toBe(200)
    expect((r.json as { status: string }).status).toBe('done')
    expect(typeof (r.json as { reply?: unknown }).reply).toBe('string')
  })

  it('a malformed ndjson line never breaks compaction or the turn', async () => {
    appendFileSync(env.paths.chatJobsPath, 'это не json {{{\n' + expiredLine('old-b'), 'utf8')
    const jobId = await runTurn('Тёрн при битой строке', 'compact-broken-1')
    const after = fileText()
    expect(after).not.toContain('это не json')
    expect(after).not.toContain('STALE-REPLY-old-b')
    expect((await env.get(`/api/chat/${jobId}`)).status).toBe(200)
  })

  it('compacted buffer holds ONE line per prior job, every line valid JSON', async () => {
    await runTurn('Финальный вопрос', 'compact-final-1')
    const lines = fileText().split('\n').filter((l) => l.trim() !== '')
    const perJob = new Map<string, number>()
    for (const line of lines) {
      const rec = JSON.parse(line) as { jobId: string } // throws on a torn write
      perJob.set(rec.jobId, (perJob.get(rec.jobId) ?? 0) + 1)
    }
    // every job except the just-finished one is collapsed to its last snapshot
    for (const [jobId, count] of perJob) {
      if (count > 1) expect(jobId).toBe([...perJob.keys()].at(-1))
    }
    expect(perJob.get(firstJobId)).toBe(1)
  })
})

describe('compactJobs unit (the startup path)', () => {
  const setup = (): { path: string; writer: Writer; compact: (nowMs: number) => void } => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lens-compact-'))
    const path = join(dataDir, 'chat-jobs.ndjson')
    const writer = new Writer({
      inboxDir: join(dataDir, 'nope-inbox'),
      lensQueueDir: join(dataDir, 'nope-queue'),
      notifInboxDir: join(dataDir, 'nope-notif'),
      lastSyncPath: join(dataDir, 'nope-sync.json'),
      dataDir,
    })
    const log = createLogger(() => {})
    return { path, writer, compact: (nowMs) => compactJobs(writer, path, TTL, nowMs, log) }
  }

  const record = (jobId: string, startedAtMs: number, extra = ''): string =>
    JSON.stringify({
      jobId,
      clientId: `c-${jobId}`,
      sessionId: 's-1',
      status: 'done',
      startedAtMs,
      message: 'm',
      reply: `r${extra}`,
    }) + '\n'

  it('missing file → no-op; superseded snapshots collapse; result is idempotent', () => {
    const { path, writer, compact } = setup()
    const now = 1_800_000_000_000
    compact(now) // no file yet — must not throw or create one
    expect(() => readFileSync(path, 'utf8')).toThrow()

    writer.appendLine(path, record('job-live', now - 1000, '-old-snapshot').trim())
    writer.appendLine(path, record('job-live', now - 1000, '-final').trim())
    writer.appendLine(path, record('job-dead', now - TTL - 1, '-expired').trim())
    compact(now)
    const once = readFileSync(path, 'utf8')
    expect(once).toBe(record('job-live', now - 1000, '-final'))

    compact(now) // second pass: already compact, byte-identical
    expect(readFileSync(path, 'utf8')).toBe(once)
  })

  it('all records expired → the file is emptied, not deleted', () => {
    const { path, writer, compact } = setup()
    const now = 1_800_000_000_000
    writer.appendLine(path, record('job-a', now - TTL - 1).trim())
    expect(readFileSync(path, 'utf8')).not.toBe('')
    compact(now)
    expect(readFileSync(path, 'utf8')).toBe('')
  })
})
