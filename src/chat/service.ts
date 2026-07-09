import { randomUUID } from 'node:crypto'
import { toWarsawIso } from '../lib/time.js'
import { appendJob, readJobState, type JobRecord, type JobState } from './store.js'
import { followupsSystemContent, somedaySystemContent } from './context.js'
import type { Config, Paths } from '../config.js'
import type { Logger } from '../lib/log.js'
import type { Writer } from '../writes/fswrite.js'

/**
 * Chat proxy service (job+poll). POST /api/chat accepts a turn, dedups it by
 * clientId, and launches it in the background against the agent's
 * OpenAI-compatible server on loopback; GET /api/chat/{jobId} polls the job
 * buffer for the outcome. The upstream API_SERVER_KEY is used only as the
 * Authorization bearer to that server and is NEVER logged or returned.
 *
 * Continuity is sidecar-maintained (rolling context): the prior completed
 * turns of a session, replayed as the messages array. The agent server injects
 * its own system prompt, so we carry only the dialog. See README §Chat proxy
 * for the v1 session caveat.
 */

export interface ChatResult {
  status: number
  body: unknown
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Safe id charset for a client-supplied sessionId (no path/URL tricks). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Carries a message that is already safe to expose to the app. */
class ChatError extends Error {
  constructor(public readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'ChatError'
  }
}

export class ChatService {
  private readonly cfg: Config
  private readonly paths: Paths
  private readonly writer: Writer
  private readonly log: Logger
  private readonly now: () => Date

  constructor(deps: { cfg: Config; paths: Paths; writer: Writer; log: Logger; now: () => Date }) {
    this.cfg = deps.cfg
    this.paths = deps.paths
    this.writer = deps.writer
    this.log = deps.log
    this.now = deps.now
  }

  /**
   * POST /api/chat. Validates, dedups by clientId, appends a `running` record,
   * and launches the turn in the background — all synchronously up to the
   * append, so a racing replay always observes the running record and never
   * starts a second turn. Returns immediately.
   */
  start(body: unknown): ChatResult {
    if (this.cfg.apiServerKey === '') {
      // Additive endpoint on a deployment that has not set the upstream key
      // yet — fail clean, never crash, never hint at the missing secret.
      return { status: 503, body: { error: 'chat is not configured' } }
    }
    const req = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    if (typeof req.message !== 'string' || req.message.trim() === '') {
      return { status: 400, body: { error: 'message is required' } }
    }
    if (typeof req.clientId !== 'string' || req.clientId.trim() === '') {
      return { status: 400, body: { error: 'clientId is required' } }
    }
    if (req.sessionId !== undefined && (typeof req.sessionId !== 'string' || !SESSION_ID_RE.test(req.sessionId))) {
      return { status: 400, body: { error: 'invalid sessionId' } }
    }
    const message = req.message
    const clientId = req.clientId
    const nowMs = this.now().getTime()
    const state = readJobState(this.paths.chatJobsPath, this.cfg.chatJobTtlMs, nowMs, this.log)

    // Idempotent replay: same clientId → the same job, no second turn. POST
    // always reports "running"; the real terminal state is read via GET.
    const existing = state.byClientId.get(clientId)
    if (existing !== undefined) {
      return {
        status: 200,
        body: { jobId: existing.jobId, sessionId: existing.sessionId, status: 'running' },
      }
    }

    const sessionId = req.sessionId ?? `sess-${randomUUID()}`
    const jobId = `job-${randomUUID()}`
    // Active follow-ups and parked someday items ride along as ONE leading
    // system message (fresh read every turn, each section fail-open) — see
    // chat/context.ts. Never persisted in the job buffer: sessionHistory
    // replays only the user/assistant dialog.
    const sections: string[] = []
    if (this.cfg.chatFollowupsContext) {
      const s = followupsSystemContent(this.paths.followupsPath, this.now(), this.log)
      if (s !== undefined) sections.push(s)
    }
    if (this.cfg.chatSomedayContext) {
      const s = somedaySystemContent(this.paths.somedayPath, this.log)
      if (s !== undefined) sections.push(s)
    }
    const messages: ChatMessage[] = [
      ...(sections.length === 0 ? [] : [{ role: 'system' as const, content: sections.join('\n\n') }]),
      ...this.sessionHistory(state, sessionId),
      { role: 'user', content: message },
    ]

    appendJob(this.writer, this.paths.chatJobsPath, {
      jobId,
      clientId,
      sessionId,
      status: 'running',
      startedAtMs: nowMs,
      message,
    })
    this.log.info('chat turn started', { jobId, sessionId })

    // Fire-and-forget. runTurn owns all its error handling; its only side
    // effect is appending the terminal record. The .catch is a belt-and-braces
    // guard against an unhandled rejection ever reaching the process.
    void this.runTurn({ jobId, clientId, sessionId, startedAtMs: nowMs, message, messages }).catch((err: unknown) => {
      this.log.warn('chat turn crashed', { jobId, error: err instanceof Error ? err.name : 'unknown' })
    })

    return { status: 202, body: { jobId, sessionId, status: 'running' } }
  }

  /** GET /api/chat/{jobId}. Reads the job buffer; unknown/expired → 404. */
  status(jobId: string): ChatResult {
    const nowMs = this.now().getTime()
    const state = readJobState(this.paths.chatJobsPath, this.cfg.chatJobTtlMs, nowMs, this.log)
    const record = state.byJobId.get(jobId)
    if (record === undefined) return { status: 404, body: { error: 'not found' } }
    const out: Record<string, unknown> = { jobId: record.jobId, status: record.status }
    if (record.reply !== undefined) out.reply = record.reply
    if (record.error !== undefined) out.error = record.error
    if (record.finishedAt !== undefined) out.finishedAt = record.finishedAt
    if (record.tokensUsed !== undefined) out.tokensUsed = record.tokensUsed
    return { status: 200, body: out }
  }

  /** Prior completed turns of a session, oldest first, capped — the context. */
  private sessionHistory(state: JobState, sessionId: string): ChatMessage[] {
    const done = [...state.byJobId.values()]
      .filter((r) => r.sessionId === sessionId && r.status === 'done' && typeof r.reply === 'string')
      .sort((a, b) => a.startedAtMs - b.startedAtMs)
      .slice(-this.cfg.chatHistoryMaxTurns)
    const messages: ChatMessage[] = []
    for (const r of done) {
      messages.push({ role: 'user', content: r.message })
      messages.push({ role: 'assistant', content: r.reply as string })
    }
    return messages
  }

  private async runTurn(turn: {
    jobId: string
    clientId: string
    sessionId: string
    startedAtMs: number
    message: string
    messages: ChatMessage[]
  }): Promise<void> {
    const base = {
      jobId: turn.jobId,
      clientId: turn.clientId,
      sessionId: turn.sessionId,
      startedAtMs: turn.startedAtMs,
      message: turn.message,
    }
    let record: JobRecord
    try {
      const { reply, tokensUsed } = await this.callUpstream(turn.messages)
      record = {
        ...base,
        status: 'done',
        reply,
        finishedAt: toWarsawIso(this.now()),
        ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      }
      this.log.info('chat turn done', { jobId: turn.jobId, ...(tokensUsed !== undefined ? { tokensUsed } : {}) })
    } catch (err) {
      // Only messages we minted are exposed; anything unexpected collapses to a
      // generic string so an internal error can never leak through the reply.
      const publicMessage = err instanceof ChatError ? err.publicMessage : 'agent error'
      record = { ...base, status: 'error', error: publicMessage, finishedAt: toWarsawIso(this.now()) }
      this.log.warn('chat turn failed', { jobId: turn.jobId, reason: publicMessage })
    }
    try {
      appendJob(this.writer, this.paths.chatJobsPath, record)
    } catch {
      this.log.warn('chat result persist failed', { jobId: turn.jobId })
    }
  }

  private async callUpstream(messages: ChatMessage[]): Promise<{ reply: string; tokensUsed?: number }> {
    let res: Response
    try {
      res = await fetch(`${this.cfg.agentApiUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The upstream secret lives ONLY on this header, built inline so it
          // is never held in a logged field or an error.
          authorization: `Bearer ${this.cfg.apiServerKey}`,
        },
        body: JSON.stringify({ model: this.cfg.chatModel, messages, stream: false }),
        signal: AbortSignal.timeout(this.cfg.chatTurnBudgetMs),
      })
    } catch (err) {
      const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : ''
      throw new ChatError(name === 'TimeoutError' || name === 'AbortError' ? 'agent timed out' : 'agent unavailable')
    }
    if (!res.ok) {
      // Never forward the upstream body — it is internal to the agent.
      this.log.warn('chat upstream non-2xx', { status: res.status })
      throw new ChatError('agent error')
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new ChatError('agent returned an unreadable response')
    }
    const reply = extractReply(json)
    if (reply === undefined) throw new ChatError('agent returned an empty response')
    const tokensUsed = extractTokens(json)
    return { reply, ...(tokensUsed !== undefined ? { tokensUsed } : {}) }
  }
}

/** choices[0].message.content, if the upstream returned a usable string. */
function extractReply(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const choices = (json as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return undefined
  const first: unknown = choices[0]
  if (typeof first !== 'object' || first === null) return undefined
  const message = (first as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' && content.trim() !== '' ? content : undefined
}

/** usage.total_tokens, when present as a finite number. */
function extractTokens(json: unknown): number | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const usage = (json as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const total = (usage as { total_tokens?: unknown }).total_tokens
  return typeof total === 'number' && Number.isFinite(total) ? total : undefined
}
