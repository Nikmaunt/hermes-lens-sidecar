import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { ChatStartResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * Someday context on chat turns: a SECOND section in the SAME leading system
 * message the followups block rides in — «Отложенные без срока (someday.md)».
 * Own switch (CHAT_SOMEDAY_CONTEXT, default true), fresh read every turn,
 * every failure shape fails open, and the /api/chat contract is unchanged.
 */

interface UpstreamMessage {
  role: string
  content: string
}

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

function writeSomeday(env: TestEnv, content: string | undefined): void {
  const path = join(env.cfg.vaultDir, 'someday.md')
  rmSync(path, { recursive: true, force: true })
  if (content !== undefined) writeFileSync(path, content, 'utf8')
}

const SOMEDAY_MD = [
  '# Someday',
  '',
  '- [ ] научиться играть на укулеле (from [[muzykalnye-idei]])',
  '- [ ] съездить в Лиссабон на выходные',
  '- [x] прочитать «Дюну» (from [[knigi]])',
  '',
].join('\n')

describe('someday items ride in the SAME system message as followups', () => {
  let env: TestEnv
  beforeAll(async () => {
    env = await buildEnv()
  })
  afterAll(async () => {
    await env.close()
  })

  it('one system message with both sections; [x] someday lines stay out', async () => {
    writeSomeday(env, SOMEDAY_MD)
    const messages = await turnMessages(env, 'Какие у меня дела?', 'sd-both-1')
    const system = messages.filter((m) => m.role === 'system')
    expect(system).toHaveLength(1)
    const block = system[0]?.content ?? ''
    // followups section (fixture followups.md) is still there…
    expect(block).toContain('ответить Олегу про маршрут')
    // …and the someday section follows in the same block
    expect(block).toContain('Отложенные без срока (someday.md):')
    expect(block).toContain('научиться играть на укулеле')
    expect(block).toContain('съездить в Лиссабон на выходные')
    expect(block).not.toContain('прочитать «Дюну»') // [x] done
  })

  it('no active followups → the system message still carries the someday section', async () => {
    writeSomeday(env, SOMEDAY_MD)
    rmSync(env.paths.followupsPath, { force: true })
    const messages = await turnMessages(env, 'Дела без followups', 'sd-only-1')
    const system = messages.filter((m) => m.role === 'system')
    expect(system).toHaveLength(1)
    expect(system[0]?.content).toContain('Отложенные без срока (someday.md):')
    expect(system[0]?.content).not.toContain('follow-ups')
  })

  it('fresh read each turn: a new someday line appears on the very next turn', async () => {
    writeSomeday(env, '# Someday\n\n- [ ] попробовать глину (from [[hobby]])\n')
    const messages = await turnMessages(env, 'Дела после обновления', 'sd-fresh-1')
    expect(messages[0]?.content).toContain('попробовать глину')
  })
})

describe('fail-open: no someday section, the turn goes out anyway', () => {
  let env: TestEnv
  beforeAll(async () => {
    env = await buildEnv()
  })
  afterAll(async () => {
    await env.close()
  })

  it('someday.md missing → followups section only, no someday header', async () => {
    writeSomeday(env, undefined)
    const messages = await turnMessages(env, 'Дела без someday-файла', 'sd-missing-1')
    const system = messages.filter((m) => m.role === 'system')
    expect(system).toHaveLength(1) // fixture followups.md is active
    expect(system[0]?.content).not.toContain('Отложенные без срока')
  })

  it('unreadable someday.md (a directory) → turn still done, no someday section', async () => {
    writeSomeday(env, undefined)
    mkdirSync(join(env.cfg.vaultDir, 'someday.md'))
    const messages = await turnMessages(env, 'Дела при битом someday', 'sd-broken-1')
    expect(messages.filter((m) => m.role === 'system')[0]?.content ?? '').not.toContain(
      'Отложенные без срока',
    )
  })

  it('both sources empty → no system message at all', async () => {
    rmSync(join(env.cfg.vaultDir, 'someday.md'), { recursive: true, force: true })
    rmSync(env.paths.followupsPath, { force: true })
    const messages = await turnMessages(env, 'Дела при пустых источниках', 'sd-none-1')
    expect(messages.every((m) => m.role !== 'system')).toBe(true)
  })
})

describe('CHAT_SOMEDAY_CONTEXT=false switches only the someday section off', () => {
  it('someday items exist, flag off → followups section without someday', async () => {
    const off = await buildEnv({ somedayContext: false })
    try {
      writeSomeday(off, SOMEDAY_MD)
      const messages = await turnMessages(off, 'Дела при выключенном someday', 'sd-off-1')
      const system = messages.filter((m) => m.role === 'system')
      expect(system).toHaveLength(1)
      expect(system[0]?.content).toContain('ответить Олегу про маршрут')
      expect(system[0]?.content).not.toContain('Отложенные без срока')
    } finally {
      await off.close()
    }
  })

  it('both flags off → no system message', async () => {
    const off = await buildEnv({ followupsContext: false, somedayContext: false })
    try {
      writeSomeday(off, SOMEDAY_MD)
      const messages = await turnMessages(off, 'Дела при выключенных флагах', 'sd-off-2')
      expect(messages.every((m) => m.role !== 'system')).toBe(true)
    } finally {
      await off.close()
    }
  })
})

describe('/api/chat contract is unchanged by the context sections', () => {
  it('POST /api/chat answers exactly {jobId, sessionId, status}', async () => {
    const env = await buildEnv()
    try {
      writeSomeday(env, SOMEDAY_MD)
      const r = await env.post('/api/chat', { message: 'Контракт на месте?', clientId: 'sd-contract-1' })
      expect(r.status).toBe(202)
      ChatStartResponse.parse(r.json)
      expect(Object.keys(r.json as object).sort()).toEqual(['jobId', 'sessionId', 'status'])
    } finally {
      await env.close()
    }
  })
})

describe('CHAT_SOMEDAY_CONTEXT config parsing', () => {
  const base = {
    LENS_TOKEN: 'test-token-0123456789abcdef0123456789abcdef',
  }
  const load = (value?: string) =>
    loadConfig(
      value === undefined ? base : { ...base, CHAT_SOMEDAY_CONTEXT: value },
      'nonexistent.env',
    )

  it('defaults to true', () => {
    expect(load().chatSomedayContext).toBe(true)
  })
  it('parses true/false strictly', () => {
    expect(load('true').chatSomedayContext).toBe(true)
    expect(load('false').chatSomedayContext).toBe(false)
    expect(() => load('yes')).toThrow(/CHAT_SOMEDAY_CONTEXT/)
  })
})
