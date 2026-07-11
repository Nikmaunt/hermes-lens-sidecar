import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CommandAccepted, CommandsResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * POST /api/commands + GET /api/commands — the app enqueues fire-and-forget
 * commands (adhoc digest, create person note); the sidecar drops a queue file
 * into vault/system/lens-queue/ for the VPS runner and reports each command's
 * lifecycle by joining three sources: its own ledger (accepted), the queue
 * dir (pending) and vault/system/command-results/ (done/error; neither file
 * → running). Same guarantees as notifications: bearer auth, clientId dedup
 * BEFORE the rate limit, 4 KiB payload cap, writes only through Writer.
 */

function digestCmd(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: 'digest-client-0001',
    type: 'adhoc-digest',
    payload: { topic: 'Обзор рынка недвижимости в Портленде' },
    ...over,
  }
}

function noteCmd(payload: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: 'note-client-000001',
    type: 'create-note',
    payload: {
      target: 'people',
      person: 'Олег',
      title: 'Договорённости про маршрут',
      text: 'Созвон в четверг, финальную версию присылает Олег',
      ...payload,
    },
    ...over,
  }
}

function resultsDir(env: TestEnv): string {
  return join(env.root, 'vault', 'system', 'command-results')
}

function queueDir(env: TestEnv): string {
  return join(env.root, 'vault', 'system', 'lens-queue')
}

function writeResultFile(env: TestEnv, name: string, content: string): void {
  mkdirSync(resultsDir(env), { recursive: true })
  writeFileSync(join(resultsDir(env), name), content, 'utf8')
}

interface StatusItem {
  commandId: string
  type: string
  requestedAt: string
  state: string
  summary?: string | undefined
  result?: { kind: string; id: string } | undefined
}

async function getStatuses(env: TestEnv, query = ''): Promise<StatusItem[]> {
  const r = await env.get(`/api/commands${query}`)
  expect(r.status).toBe(200)
  return CommandsResponse.parse(r.json).items
}

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('auth and validation', () => {
  it('401 without token, 401 with wrong token — POST and GET', async () => {
    const noToken = await env.post('/api/commands', digestCmd(), null)
    expect(noToken.status).toBe(401)
    expect(noToken.json).toEqual({ error: 'unauthorized' })
    const badToken = await env.post('/api/commands', digestCmd(), 'wrong-token-wrong-token-wrong')
    expect(badToken.status).toBe(401)
    const getNoToken = await env.get('/api/commands', null)
    expect(getNoToken.status).toBe(401)
    const getBadToken = await env.get('/api/commands', 'wrong-token-wrong-token-wrong')
    expect(getBadToken.status).toBe(401)
  })

  it('400 on unknown command type — a mirror of the discriminated union, no fallback', async () => {
    for (const type of ['delete-vault', 'triage', '', 42, undefined]) {
      const r = await env.post('/api/commands', digestCmd({ type }))
      expect(r.status, `type=${JSON.stringify(type)}`).toBe(400)
      expect((r.json as { error: string }).error).toBeTruthy()
    }
    expect(env.listQueueFiles()).toEqual([])
  })

  it('400 on malformed adhoc-digest payloads', async () => {
    const cases: Record<string, unknown>[] = [
      digestCmd({ clientId: 'short' }), // min 8
      digestCmd({ payload: undefined }),
      digestCmd({ payload: { topic: '' } }), // min 1
      digestCmd({ payload: { topic: 'x'.repeat(501) } }), // max 500
      digestCmd({ payload: { topic: 42 } }),
    ]
    for (const body of cases) {
      const r = await env.post('/api/commands', body)
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400)
    }
    expect(env.listQueueFiles()).toEqual([])
  })

  it('400 on malformed create-note payloads', async () => {
    const cases: Record<string, unknown>[] = [
      noteCmd({ target: 'projects' }), // literal 'people' only
      noteCmd({ target: undefined }),
      noteCmd({ person: '' }), // min 1
      noteCmd({ person: 'x'.repeat(121) }), // max 120
      noteCmd({ title: 'x'.repeat(121) }), // max 120
      noteCmd({ text: '' }), // min 1
      noteCmd({ text: 'x'.repeat(4097) }), // per-field max 4096 → schema 400, not 413
      noteCmd({ text: 42 }),
    ]
    for (const body of cases) {
      const r = await env.post('/api/commands', body)
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400)
    }
    expect(env.listQueueFiles()).toEqual([])
  })

  it('413 {error:"payload too large"} when the schema-valid payload exceeds 4 KiB of bytes', async () => {
    // 2500 Cyrillic chars pass the 4096-char field cap but weigh 5000 bytes
    const r = await env.post('/api/commands', noteCmd({ text: 'я'.repeat(2500) }, { clientId: 'oversize-client-1' }))
    expect(r.status).toBe(413)
    expect(r.json).toEqual({ error: 'payload too large' })
    expect(env.listQueueFiles()).toEqual([])
  })
})

describe('accept, queue file form, dedup', () => {
  let digestId = ''
  let noteId = ''

  it('201 → queue file <ts>-command-<commandId>.json of the designed shape', async () => {
    const r = await env.post('/api/commands', digestCmd())
    expect(r.status).toBe(201)
    const body = CommandAccepted.parse(r.json)
    expect(body.status).toBe('ok')
    expect(body.commandId).toMatch(/^cmd-[0-9a-f]{8}$/)
    digestId = body.commandId

    const files = env.listQueueFiles()
    expect(files).toHaveLength(1)
    const name = files[0] ?? ''
    expect(name).toMatch(/^\d{13}-command-cmd-[0-9a-f]{8}\.json$/)
    expect(name).toContain(`-command-${digestId}.`)

    const parsed = JSON.parse(readFileSync(join(queueDir(env), name), 'utf8')) as Record<string, unknown>
    expect(parsed.type).toBe('command')
    expect(parsed.commandId).toBe(digestId)
    expect(parsed.command).toBe('adhoc-digest')
    expect(parsed.payload).toEqual({ topic: 'Обзор рынка недвижимости в Портленде' })
    expect(parsed.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })

  it('replaying the same clientId → 200 {status:"duplicate"}, same commandId, no second queue file', async () => {
    const replay = await env.post('/api/commands', digestCmd())
    expect(replay.status).toBe(200)
    const body = CommandAccepted.parse(replay.json)
    expect(body.status).toBe('duplicate')
    expect(body.commandId).toBe(digestId)
    expect(env.listQueueFiles()).toHaveLength(1)
  })

  it('create-note lands as its own queue file with the full payload', async () => {
    const r = await env.post('/api/commands', noteCmd())
    expect(r.status).toBe(201)
    noteId = CommandAccepted.parse(r.json).commandId
    expect(noteId).not.toBe(digestId)

    const name = env.listQueueFiles().find((f) => f.includes(`-command-${noteId}.`)) ?? ''
    expect(name).not.toBe('')
    const parsed = JSON.parse(readFileSync(join(queueDir(env), name), 'utf8')) as Record<string, unknown>
    expect(parsed.command).toBe('create-note')
    expect(parsed.payload).toEqual({
      target: 'people',
      person: 'Олег',
      title: 'Договорённости про маршрут',
      text: 'Созвон в четверг, финальную версию присылает Олег',
    })
  })

  it('accepted commands appear in /api/timeline as system events', async () => {
    const r = (await env.get('/api/timeline')).json as {
      events: { category: string; title: string }[]
    }
    const queued = r.events.filter((e) => e.title === 'Command queued')
    expect(queued.length).toBeGreaterThanOrEqual(2)
    expect(queued.every((e) => e.category === 'system')).toBe(true)
  })

  it('GET /api/commands — both accepted commands are pending while their queue files exist', async () => {
    const items = await getStatuses(env)
    expect(items.map((i) => i.commandId).sort()).toEqual([digestId, noteId].sort())
    for (const item of items) {
      expect(item.state).toBe('pending')
      expect(item.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
    expect(items.find((i) => i.commandId === digestId)?.type).toBe('adhoc-digest')
    expect(items.find((i) => i.commandId === noteId)?.type).toBe('create-note')
  })

  it('queue file consumed, no result yet → running', async () => {
    const name = env.listQueueFiles().find((f) => f.includes(`-command-${digestId}.`)) ?? ''
    rmSync(join(queueDir(env), name)) // the agent's runner consumed it
    const items = await getStatuses(env)
    expect(items.find((i) => i.commandId === digestId)?.state).toBe('running')
    expect(items.find((i) => i.commandId === noteId)?.state).toBe('pending')
  })

  it('done result file → done with summary and result; unknown-command results are ignored', async () => {
    writeResultFile(
      env,
      `${digestId}.json`,
      JSON.stringify({
        commandId: digestId,
        state: 'done',
        summary: 'Бриф собран',
        result: { kind: 'brief', id: '2026-07-11-rynok-portlenda' },
      }),
    )
    // a result for a command this sidecar never accepted → no phantom item
    writeResultFile(env, 'stray.json', JSON.stringify({ commandId: 'cmd-deadbeef', state: 'done' }))

    const items = await getStatuses(env)
    const digest = items.find((i) => i.commandId === digestId)
    expect(digest?.state).toBe('done')
    expect(digest?.summary).toBe('Бриф собран')
    expect(digest?.result).toEqual({ kind: 'brief', id: '2026-07-11-rynok-portlenda' })
    expect(items.some((i) => i.commandId === 'cmd-deadbeef')).toBe(false)
  })

  it('error result file → error; a result wins even while the queue file still exists', async () => {
    // runner wrote the result but has not deleted the queue file yet
    writeResultFile(
      env,
      `${noteId}.json`,
      JSON.stringify({ commandId: noteId, state: 'error', summary: 'Не удалось создать заметку' }),
    )
    expect(env.listQueueFiles().some((f) => f.includes(`-command-${noteId}.`))).toBe(true)

    const items = await getStatuses(env)
    const note = items.find((i) => i.commandId === noteId)
    expect(note?.state).toBe('error')
    expect(note?.summary).toBe('Не удалось создать заметку')
    expect(note?.result).toBeUndefined()
  })

  it('items are sorted by requestedAt desc; ?limit caps the page; bad limit → 400', async () => {
    const items = await getStatuses(env)
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]?.requestedAt ?? ''
      const cur = items[i]?.requestedAt ?? ''
      expect(prev >= cur, `${prev} >= ${cur}`).toBe(true)
    }
    const limited = await getStatuses(env, '?limit=1')
    expect(limited).toHaveLength(1)
    for (const bad of ['abc', '0', '-1', '1.5']) {
      const r = await env.get(`/api/commands?limit=${bad}`)
      expect(r.status, `limit=${bad}`).toBe(400)
    }
  })
})

describe('tolerant result parsing', () => {
  it('broken result file and a traversal-shaped commandId are skipped with a warning, never served', async () => {
    const r = await env.post('/api/commands', digestCmd({ clientId: 'trav-client-000001' }))
    expect(r.status).toBe(201)
    const cmdId = CommandAccepted.parse(r.json).commandId
    const name = env.listQueueFiles().find((f) => f.includes(`-command-${cmdId}.`)) ?? ''
    rmSync(join(queueDir(env), name))

    writeResultFile(env, 'broken.json', 'not-json{{{')
    writeResultFile(
      env,
      'evil.json',
      JSON.stringify({ commandId: '../../../etc/passwd', state: 'done', result: { kind: 'brief', id: 'x' } }),
    )

    const items = await getStatuses(env)
    expect(items.find((i) => i.commandId === cmdId)?.state).toBe('running')
    expect(items.some((i) => i.commandId.includes('..'))).toBe(false)
    expect(env.logs.join('\n')).toContain('command result skipped')
  })
})

describe('write surface stays narrow', () => {
  it('command-results joined the Writer allowlist; deleteRoot is still lens-queue only', () => {
    const fswrite = readFileSync(join(import.meta.dirname, '..', 'src', 'writes', 'fswrite.ts'), 'utf8')
    expect(fswrite).toContain('commandResultsDir')
    expect(fswrite).toContain('this.deleteRoot = resolve(opts.lensQueueDir)')
    expect(fswrite.match(/this\.deleteRoot\s*=/g)).toHaveLength(1)
  })

  it('neither the token nor command payload content ever reaches the logs', () => {
    const joined = env.logs.join('\n')
    expect(joined).not.toContain(env.token)
    expect(joined).not.toContain('Обзор рынка недвижимости')
    expect(joined).not.toContain('Договорённости про маршрут')
    expect(joined).not.toContain('финальную версию присылает')
  })
})

describe('rate limit — sliding window, 20 commands/hour, dedup first', () => {
  let fresh: TestEnv
  beforeAll(async () => {
    fresh = await buildEnv()
  })
  afterAll(async () => {
    await fresh.close()
  })

  it('the 20th command in the window passes, the 21st answers 429; a replay still dedups', async () => {
    for (let i = 1; i <= 20; i++) {
      const r = await fresh.post(
        '/api/commands',
        digestCmd({ clientId: `rate-client-${String(i).padStart(4, '0')}` }),
      )
      expect(r.status, `command #${i} must pass`).toBe(201)
    }
    const over = await fresh.post('/api/commands', digestCmd({ clientId: 'rate-client-0021' }))
    expect(over.status).toBe(429)
    expect(over.json).toEqual({ error: 'rate limited' })
    expect(fresh.listQueueFiles()).toHaveLength(20)

    // dedup sits BEFORE the rate limit: offline replays never eat the budget
    const replay = await fresh.post('/api/commands', digestCmd({ clientId: 'rate-client-0001' }))
    expect(replay.status).toBe(200)
    expect(CommandAccepted.parse(replay.json).status).toBe('duplicate')
  })
})
