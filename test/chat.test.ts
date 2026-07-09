import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ChatStartResponse, ChatJobResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'
import { cannedCompletion } from './helpers/fake-agent'

/**
 * Chat proxy (job+poll). The sidecar accepts a turn, runs it against the fake
 * agent server in the background, and exposes the result via GET. These assert
 * the full lifecycle, clientId idempotency (one turn per replay), leak-free
 * error surfaces, 401+CORS parity, and — the security invariant — that the
 * upstream API_SERVER_KEY never appears in a log line or a response body.
 */

const ORIGIN = 'https://localhost'

interface StatusBody {
  jobId: string
  status: string
  reply?: string
  error?: string
  finishedAt?: string
  tokensUsed?: number
}

/** Poll GET /api/chat/{jobId} until it leaves "running". */
async function pollTerminal(env: TestEnv, jobId: string, timeoutMs = 10_000): Promise<{ httpStatus: number; body: StatusBody }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await env.get(`/api/chat/${jobId}`)
    const body = r.json as StatusBody
    if (body.status !== 'running') return { httpStatus: r.status, body }
    if (Date.now() > deadline) throw new Error(`poll timed out: ${JSON.stringify(body)}`)
    await new Promise((res) => setTimeout(res, 20))
  }
}

/** Upstream calls whose final user message matches `text` — one per real turn. */
function upstreamTurnsFor(env: TestEnv, text: string): number {
  return env.agent.calls.filter((c) => {
    const messages = (c.body as { messages?: { role?: string; content?: string }[] } | undefined)?.messages
    const last = messages?.[messages.length - 1]
    return last?.role === 'user' && last?.content === text
  }).length
}

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})
afterEach(() => {
  env.agent.setHandler(() => cannedCompletion())
})

describe('POST /api/chat → GET lifecycle', () => {
  it('accepts a turn as running, then drives running→done with reply + tokensUsed', async () => {
    env.agent.setHandler(() => cannedCompletion('Привет, Сэм!'))
    const start = await env.post('/api/chat', { message: 'Поздоровайся', clientId: 'life-1' })
    expect(start.status).toBe(202)
    const accepted = ChatStartResponse.parse(start.json)
    expect(accepted.status).toBe('running')
    expect(accepted.jobId).toBeTruthy()
    expect(accepted.sessionId).toBeTruthy()

    const { httpStatus, body } = await pollTerminal(env, accepted.jobId)
    expect(httpStatus).toBe(200)
    const done = ChatJobResponse.parse(body)
    expect(done.status).toBe('done')
    expect(done.jobId).toBe(accepted.jobId)
    expect(done.reply).toBe('Привет, Сэм!')
    expect(done.tokensUsed).toBe(17_042)
    expect(done.finishedAt).toBeTruthy()
    expect(done.error).toBeUndefined()
  })

  it('GET on an unknown jobId → 404 {error}', async () => {
    const r = await env.get('/api/chat/job-does-not-exist')
    expect(r.status).toBe(404)
    expect((r.json as { error: string }).error).toBeTruthy()
  })
})

describe('idempotency (clientId dedup)', () => {
  it('replaying the same clientId returns the same jobId and starts exactly one turn', async () => {
    const req = { message: 'Один turn пожалуйста', clientId: 'dedup-1' }
    const first = ChatStartResponse.parse((await env.post('/api/chat', req)).json)
    const replay = await env.post('/api/chat', req)
    expect(replay.status).toBe(200) // replay is not a fresh 202
    const replayBody = ChatStartResponse.parse(replay.json)
    expect(replayBody.jobId).toBe(first.jobId)
    expect(replayBody.sessionId).toBe(first.sessionId)

    await pollTerminal(env, first.jobId)
    // even a third replay after completion stays the same job, no new turn
    const third = ChatStartResponse.parse((await env.post('/api/chat', req)).json)
    expect(third.jobId).toBe(first.jobId)
    expect(upstreamTurnsFor(env, 'Один turn пожалуйста')).toBe(1)
  })
})

describe('bad requests → 400', () => {
  it('missing message → 400', async () => {
    const r = await env.post('/api/chat', { clientId: 'bad-1' })
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toBeTruthy()
  })
  it('missing clientId → 400', async () => {
    const r = await env.post('/api/chat', { message: 'привет' })
    expect(r.status).toBe(400)
  })
  it('invalid sessionId → 400', async () => {
    const r = await env.post('/api/chat', { message: 'привет', clientId: 'bad-2', sessionId: '../../etc' })
    expect(r.status).toBe(400)
  })
})

describe('upstream failures → status:error, leak-free', () => {
  it('upstream 5xx → error with a human message, upstream body never forwarded', async () => {
    env.agent.setHandler(() => ({ status: 500, bodyJson: { error: 'internal boom stacktrace' } }))
    const start = ChatStartResponse.parse((await env.post('/api/chat', { message: 'вызови сбой', clientId: 'err-1' })).json)
    const { body } = await pollTerminal(env, start.jobId)
    const errored = ChatJobResponse.parse(body)
    expect(errored.status).toBe('error')
    expect(errored.error).toBeTruthy()
    expect(errored.reply).toBeUndefined()
    expect(errored.finishedAt).toBeTruthy()
    expect(JSON.stringify(errored)).not.toContain('boom')
    expect(JSON.stringify(errored)).not.toContain('stacktrace')
  })

  it('unreadable upstream body → error', async () => {
    env.agent.setHandler(() => ({ status: 200, raw: 'not json at all' }))
    const start = ChatStartResponse.parse((await env.post('/api/chat', { message: 'мусор', clientId: 'err-2' })).json)
    const { body } = await pollTerminal(env, start.jobId)
    expect(ChatJobResponse.parse(body).status).toBe('error')
  })
})

describe('budget timeout → status:error', () => {
  it('a turn slower than CHAT_TURN_BUDGET_MS is abandoned as an error', async () => {
    const slow = await buildEnv({ chatBudgetMs: 600 })
    try {
      slow.agent.setHandler(() => ({ ...cannedCompletion(), delayMs: 4_000 }))
      const start = ChatStartResponse.parse((await slow.post('/api/chat', { message: 'засни', clientId: 'to-1' })).json)
      const { body } = await pollTerminal(slow, start.jobId, 8_000)
      const errored = ChatJobResponse.parse(body)
      expect(errored.status).toBe('error')
      expect(errored.error).toMatch(/tim(e|ed) out|unavailable/i)
    } finally {
      await slow.close()
    }
  })
})

describe('session continuity', () => {
  it('a second turn on the same session carries the prior turn as rolling context', async () => {
    env.agent.setHandler(() => cannedCompletion('Приятно познакомиться.'))
    const t1 = ChatStartResponse.parse((await env.post('/api/chat', { message: 'Меня зовут Сэм', clientId: 'sess-1' })).json)
    await pollTerminal(env, t1.jobId)

    env.agent.setHandler(() => cannedCompletion('Тебя зовут Сэм.'))
    const t2 = ChatStartResponse.parse(
      (await env.post('/api/chat', { message: 'Как меня зовут?', clientId: 'sess-2', sessionId: t1.sessionId })).json,
    )
    expect(t2.sessionId).toBe(t1.sessionId)
    await pollTerminal(env, t2.jobId)

    // the upstream call for turn 2 must include turn 1's exchange before the new question
    const t2Call = env.agent.calls.find((c) => {
      const messages = (c.body as { messages?: { content?: string }[] }).messages
      return messages?.[messages.length - 1]?.content === 'Как меня зовут?'
    })
    // The followups system block (chat-followups.test.ts) rides first;
    // the rolling dialog itself must be exactly the prior exchange + the
    // new question, in order.
    const all = (t2Call?.body as { messages: { role: string; content: string }[] }).messages
    const dialog = all.filter((m) => m.role !== 'system')
    expect(dialog.length).toBe(3)
    expect(dialog[0]).toEqual({ role: 'user', content: 'Меня зовут Сэм' })
    expect(dialog[1]).toEqual({ role: 'assistant', content: 'Приятно познакомиться.' })
    expect(dialog[2]).toEqual({ role: 'user', content: 'Как меня зовут?' })
  })
})

describe('auth + CORS parity', () => {
  it('POST /api/chat without bearer → 401 with allow-origin header', async () => {
    const res = await fetch(`${env.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', clientId: 'noauth-1' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('GET /api/chat/{jobId} without bearer → 401 with allow-origin header', async () => {
    const res = await fetch(`${env.baseUrl}/api/chat/whatever`, { headers: { origin: ORIGIN } })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('unconfigured chat → 503', () => {
  it('POST /api/chat with empty API_SERVER_KEY → 503, other endpoints unaffected', async () => {
    const off = await buildEnv({ chatConfigured: false })
    try {
      const r = await off.post('/api/chat', { message: 'привет', clientId: 'off-1' })
      expect(r.status).toBe(503)
      expect((await off.get('/api/status')).status).toBe(200) // rest of the API still works
    } finally {
      await off.close()
    }
  })
})

describe('job buffer is the only new write, and lands in DATA_DIR', () => {
  it('writes chat-jobs.ndjson under DATA_DIR and never persists the upstream key', async () => {
    const start = ChatStartResponse.parse((await env.post('/api/chat', { message: 'на диск', clientId: 'disk-1' })).json)
    await pollTerminal(env, start.jobId)

    // the buffer is a direct child of the configured DATA_DIR
    expect(dirname(env.paths.chatJobsPath)).toBe(env.cfg.dataDir)
    expect(basename(env.paths.chatJobsPath)).toBe('chat-jobs.ndjson')
    expect(existsSync(env.paths.chatJobsPath)).toBe(true)

    const buffer = readFileSync(env.paths.chatJobsPath, 'utf8')
    expect(buffer).toContain(start.jobId) // the turn is really persisted
    expect(buffer).not.toContain(env.agent.key) // the key is used upstream only
  })
})

describe('the upstream key never leaks', () => {
  it('API_SERVER_KEY is used upstream but appears in no log line and no response body', async () => {
    const start = ChatStartResponse.parse((await env.post('/api/chat', { message: 'секрет?', clientId: 'leak-1' })).json)
    const { body } = await pollTerminal(env, start.jobId)

    // the sidecar DID authenticate to the agent with the key
    expect(env.agent.calls.some((c) => c.authHeader === `Bearer ${env.agent.key}`)).toBe(true)
    expect(env.agent.key.length).toBeGreaterThan(16)

    const surfaces = [
      ...env.logs,
      JSON.stringify(start),
      JSON.stringify(body),
      JSON.stringify((await env.get(`/api/chat/${start.jobId}`)).json),
    ].join('\n')
    expect(surfaces).not.toContain(env.agent.key)
    // and the app-facing bearer is not leaked either
    expect(surfaces).not.toContain(env.token)
  })
})
