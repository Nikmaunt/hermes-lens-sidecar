import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Stand-in for the Hermes agent's OpenAI-compatible server on 127.0.0.1:8642.
 * A real loopback node:http server so the sidecar exercises its actual native
 * fetch path (undici) — no fetch stubbing. The handler is swappable per test
 * (success / 5xx / slow-past-budget / torn body) and every request is
 * recorded so tests can assert the upstream bearer AND that the key never
 * escapes into the sidecar's logs or responses.
 */

export interface UpstreamReply {
  status?: number
  bodyJson?: unknown
  /** Raw body instead of JSON — for the unreadable-response case. */
  raw?: string
  /** Delay before responding — drives the budget-timeout case. */
  delayMs?: number
}

export type UpstreamHandler = (reqBody: unknown, authHeader: string | undefined) => UpstreamReply

export interface AgentCall {
  authHeader: string | undefined
  body: unknown
}

export interface FakeAgent {
  server: Server
  url: string
  key: string
  calls: AgentCall[]
  setHandler(fn: UpstreamHandler): void
  close(): Promise<void>
}

/** Distinctive so the leak assertions catch it anywhere it might surface. */
export const FAKE_AGENT_KEY = 'agent-key-SUPERSECRET-9f8e7d6c5b4a3210-never-log-me'

export function cannedCompletion(content = 'Готово, Сэм — задача учтена.'): UpstreamReply {
  return {
    status: 200,
    bodyJson: {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      model: 'deepseek/deepseek-v4-pro',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 17_000, completion_tokens: 42, total_tokens: 17_042 },
    },
  }
}

export async function startFakeAgent(key: string = FAKE_AGENT_KEY): Promise<FakeAgent> {
  let handler: UpstreamHandler = () => cannedCompletion()
  const calls: AgentCall[] = []
  const timers = new Set<NodeJS.Timeout>()

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = undefined
      }
      calls.push({ authHeader: req.headers.authorization, body })
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
        return
      }
      const reply = handler(body, req.headers.authorization)
      const send = (): void => {
        const status = reply.status ?? 200
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(reply.raw ?? JSON.stringify(reply.bodyJson ?? {}))
      }
      if (reply.delayMs !== undefined && reply.delayMs > 0) {
        const t = setTimeout(send, reply.delayMs)
        t.unref() // never keep the process alive for a delayed fake response
        timers.add(t)
      } else {
        send()
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    key,
    calls,
    setHandler(fn) {
      handler = fn
    },
    async close() {
      for (const t of timers) clearTimeout(t)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
