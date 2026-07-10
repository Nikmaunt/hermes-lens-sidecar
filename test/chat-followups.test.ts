import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { toWarsawDate } from '../src/lib/time'
import { ChatStartResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * Followups context on chat turns. The agent's own turn context
 * (SOUL/MEMORY/USER/skills) does not include followups.md, and the chat
 * channel has no file tools — so the sidecar injects the ACTIVE follow-up
 * lines as a leading system message on every turn. These pin: active lines
 * (and only active) reach the system block, overdue items are marked, every
 * empty/broken/missing shape fails open to a turn without the block, the
 * CHAT_FOLLOWUPS_CONTEXT switch works, and no secret reaches the new surface.
 */

interface UpstreamMessage {
  role: string
  content: string
}

function warsawDatePlus(days: number): string {
  return toWarsawDate(new Date(Date.now() + days * 86_400_000))
}

/** Poll GET /api/chat/{jobId} until it leaves "running". */
async function pollTerminal(env: TestEnv, jobId: string, timeoutMs = 10_000): Promise<{ status: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await env.get(`/api/chat/${jobId}`)
    const body = r.json as { status: string }
    if (body.status !== 'running') return body
    if (Date.now() > deadline) throw new Error(`poll timed out: ${JSON.stringify(body)}`)
    await new Promise((res) => setTimeout(res, 20))
  }
}

/** Run one full turn and return the messages array the upstream received. */
async function turnMessages(env: TestEnv, message: string, clientId: string): Promise<UpstreamMessage[]> {
  const start = await env.post('/api/chat', { message, clientId })
  expect(start.status).toBe(202)
  const accepted = ChatStartResponse.parse(start.json)
  const terminal = await pollTerminal(env, accepted.jobId)
  expect(terminal.status).toBe('done')
  const call = env.agent.calls.find((c) => {
    const messages = (c.body as { messages?: UpstreamMessage[] } | undefined)?.messages
    return messages?.[messages.length - 1]?.content === message
  })
  expect(call).toBeDefined()
  return (call?.body as { messages: UpstreamMessage[] }).messages
}

describe('active follow-ups reach the turn as a system message', () => {
  let env: TestEnv
  beforeAll(async () => {
    env = await buildEnv()
  })
  afterAll(async () => {
    await env.close()
  })

  // The fixture followups.md: overdue (-1 d), today, soon (+4 d) active
  // lines, a [x] done line, and a broken line — see helpers/env.ts.
  it('injects active lines as a leading system message; done lines stay out', async () => {
    const messages = await turnMessages(env, 'Какие у меня дела?', 'fu-active-1')
    expect(messages[0]?.role).toBe('system')
    const block = messages[0]?.content ?? ''
    // human label, no internal file names or vault mechanics anywhere
    expect(block).toContain('Активные дела пользователя (с датами):')
    for (const internal of ['followups.md', 'someday.md', 'vault']) {
      expect(block).not.toContain(internal)
    }
    expect(block).toContain('ответить Олегу про маршрут')
    expect(block).toContain('продлить проездной')
    expect(block).toContain('записаться к стоматологу')
    expect(block).toContain(warsawDatePlus(-1)) // dates come along
    expect(block).not.toContain('оплатить интернет') // [x] done
    expect(block).not.toContain('сломанная строка') // unparsable line
    // the "call these just делами" instruction closes the block
    expect(block.trimEnd().split('\n').at(-1)).toContain('называй это просто делами')
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'Какие у меня дела?' })
  })

  it('marks overdue items — and only them', async () => {
    const messages = await turnMessages(env, 'Что просрочено?', 'fu-overdue-1')
    const block = messages[0]?.content ?? ''
    const lineOf = (needle: string): string =>
      block.split('\n').find((l) => l.includes(needle)) ?? ''
    expect(lineOf('ответить Олегу')).toContain('просрочено')
    expect(lineOf('продлить проездной')).not.toContain('просрочено')
    expect(lineOf('записаться к стоматологу')).not.toContain('просрочено')
  })

  it('no secret reaches the upstream request body (system block included)', async () => {
    const messages = await turnMessages(env, 'Секреты на месте?', 'fu-leak-1')
    const wire = JSON.stringify(messages)
    expect(wire).not.toContain(env.agent.key)
    expect(wire).not.toContain(env.token)
  })
})

describe('fail-open: no block, turn goes out as before', () => {
  let env: TestEnv
  beforeAll(async () => {
    env = await buildEnv()
  })
  afterAll(async () => {
    await env.close()
  })

  // The file is read fresh on every turn, so each case sets its own state.
  const setFollowupsFile = (content: string | undefined): void => {
    rmSync(env.paths.followupsPath, { recursive: true, force: true })
    if (content !== undefined) writeFileSync(env.paths.followupsPath, content, 'utf8')
  }

  it('no active lines → no system message', async () => {
    setFollowupsFile(`# Follow-ups\n\n- [x] [[${warsawDatePlus(-2)}]] — оплатить интернет (from [[oplata-interneta]])\n`)
    const messages = await turnMessages(env, 'Дела при пустом списке', 'fu-empty-1')
    expect(messages.every((m) => m.role !== 'system')).toBe(true)
  })

  it('file missing → no system message, turn still done', async () => {
    setFollowupsFile(undefined)
    const messages = await turnMessages(env, 'Дела без файла', 'fu-missing-1')
    expect(messages.every((m) => m.role !== 'system')).toBe(true)
  })

  it('unreadable file (a directory in its place) → no system message, no error', async () => {
    setFollowupsFile(undefined)
    mkdirSync(env.paths.followupsPath)
    const messages = await turnMessages(env, 'Дела при битом файле', 'fu-broken-1')
    expect(messages.every((m) => m.role !== 'system')).toBe(true)
  })

  it('a fresh read every turn: new active line appears on the very next turn', async () => {
    setFollowupsFile(`# Follow-ups\n\n- [ ] [[${warsawDatePlus(1)}]] — забрать посылку (from [[posylka]])\n`)
    const messages = await turnMessages(env, 'Дела после обновления файла', 'fu-fresh-1')
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('забрать посылку')
  })
})

describe('CHAT_FOLLOWUPS_CONTEXT=false switches the block off', () => {
  it('active lines exist, flag off → no system message', async () => {
    const off = await buildEnv({ followupsContext: false })
    try {
      const messages = await turnMessages(off, 'Дела при выключенном флаге', 'fu-off-1')
      expect(messages.every((m) => m.role !== 'system')).toBe(true)
      expect(messages[messages.length - 1]?.content).toBe('Дела при выключенном флаге')
    } finally {
      await off.close()
    }
  })
})

describe('CHAT_FOLLOWUPS_CONTEXT config parsing', () => {
  const base = {
    LENS_TOKEN: 'test-token-0123456789abcdef0123456789abcdef',
  }
  const load = (value?: string) =>
    loadConfig(
      value === undefined ? base : { ...base, CHAT_FOLLOWUPS_CONTEXT: value },
      'nonexistent.env',
    )

  it('defaults to true', () => {
    expect(load().chatFollowupsContext).toBe(true)
  })
  it('parses true/false strictly', () => {
    expect(load('true').chatFollowupsContext).toBe(true)
    expect(load('false').chatFollowupsContext).toBe(false)
    expect(() => load('yes')).toThrow(/CHAT_FOLLOWUPS_CONTEXT/)
  })
})
