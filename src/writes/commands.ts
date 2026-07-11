import { readTextIfExists } from '../lib/fsread.js'
import { shortHash } from '../lib/hash.js'
import { parseIsoMs, toWarsawIso } from '../lib/time.js'
import { readQueueState } from '../readers/queuestate.js'
import { readCommandResults } from '../readers/commandresults.js'
import type { Logger } from '../lib/log.js'
import type { Paths } from '../config.js'
import type { Writer } from './fswrite.js'
import { appendJournal } from './journal.js'
import { writeQueueFile } from './queue.js'

/**
 * POST /api/commands + GET /api/commands — the app enqueues fire-and-forget
 * commands for the agent's VPS runner. The sidecar never executes a command
 * itself: it drops a queue file into vault/system/lens-queue/ and later
 * reports progress by joining its ledger (accepted) with the queue dir
 * (still pending) and vault/system/command-results/ (done/error; neither
 * file left → running). Contract: CommandRequest/CommandAccepted/
 * CommandsResponse.
 *
 * No idempotency or undo beyond the clientId ledger dedup: a command is
 * fire-and-forget and v1 has no recall — once the queue file exists, only
 * the runner consumes it.
 */

export interface CommandResult {
  status: number
  body: unknown
}

/** Extra cap on top of the per-field schema: one command carries ≤ 4 KiB of payload bytes. */
const PAYLOAD_BYTES_CAP = 4096

const RATE_LIMIT_MAX = 20
const RATE_WINDOW_MS = 3_600_000

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Sliding-window admission counter (20 commands/hour). In-memory on
 * purpose: сброс на рестарте приемлем by design — защита от бомбёжки, не
 * биллинг; клиентская очередь трактует 429 как транзиент и дошлёт.
 */
export class CommandRateLimiter {
  private admitted: number[] = []

  tryAdmit(nowMs: number): boolean {
    this.admitted = this.admitted.filter((t) => t > nowMs - RATE_WINDOW_MS)
    if (this.admitted.length >= RATE_LIMIT_MAX) return false
    this.admitted.push(nowMs)
    return true
  }
}

type CommandType = 'adhoc-digest' | 'create-note'

interface CommandReq {
  clientId: string
  type: CommandType
  payload: Record<string, unknown>
}

/**
 * Hand-rolled mirror of CommandRequest (zod stays dev-only). A discriminated
 * union: an unknown `type` is a hard 400, never coerced to a fallback.
 */
function validate(body: unknown): { ok: CommandReq } | { err: string } {
  if (typeof body !== 'object' || body === null) return { err: 'invalid body' }
  const r = body as Record<string, unknown>
  if (typeof r.clientId !== 'string' || r.clientId.length < 8) {
    return { err: 'clientId must be a string of at least 8 characters' }
  }
  if (r.type !== 'adhoc-digest' && r.type !== 'create-note') {
    return { err: 'type must be one of: adhoc-digest, create-note' }
  }
  if (typeof r.payload !== 'object' || r.payload === null) return { err: 'payload must be an object' }
  const p = r.payload as Record<string, unknown>

  if (r.type === 'adhoc-digest') {
    if (typeof p.topic !== 'string' || p.topic.length < 1 || p.topic.length > 500) {
      return { err: 'payload.topic must be a string of 1..500 characters' }
    }
    return { ok: { clientId: r.clientId, type: r.type, payload: { topic: p.topic } } }
  }

  if (p.target !== 'people') return { err: "payload.target must be 'people'" }
  if (typeof p.person !== 'string' || p.person.length < 1 || p.person.length > 120) {
    return { err: 'payload.person must be a string of 1..120 characters' }
  }
  if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length > 120)) {
    return { err: 'payload.title must be a string of at most 120 characters' }
  }
  if (typeof p.text !== 'string' || p.text.length < 1 || p.text.length > 4096) {
    return { err: 'payload.text must be a string of 1..4096 characters' }
  }
  return {
    ok: {
      clientId: r.clientId,
      type: r.type,
      payload: {
        target: p.target,
        person: p.person,
        ...(p.title !== undefined ? { title: p.title } : {}),
        text: p.text,
      },
    },
  }
}

interface LedgerEntry {
  clientId: string
  commandId: string
  type: CommandType
  requestedAt: string
}

/** Accepted commands, in append order; malformed lines are skipped. */
function readLedger(path: string, log: Logger): LedgerEntry[] {
  const out: LedgerEntry[] = []
  const raw = readTextIfExists(path)
  if (raw === undefined) return out
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as Record<string, unknown>
      if (
        typeof e.clientId === 'string' &&
        typeof e.commandId === 'string' &&
        (e.type === 'adhoc-digest' || e.type === 'create-note') &&
        typeof e.requestedAt === 'string'
      ) {
        out.push({ clientId: e.clientId, commandId: e.commandId, type: e.type, requestedAt: e.requestedAt })
      }
    } catch {
      log.warn('malformed commands ledger line skipped')
    }
  }
  return out
}

export function handleCommand(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  limiter: CommandRateLimiter,
  body: unknown,
): CommandResult {
  const { paths, writer, log, now } = deps
  const v = validate(body)
  if ('err' in v) return { status: 400, body: { error: v.err } }
  const req = v.ok

  if (Buffer.byteLength(JSON.stringify(req.payload), 'utf8') > PAYLOAD_BYTES_CAP) {
    return { status: 413, body: { error: 'payload too large' } }
  }

  // Dedup BEFORE the rate limit: offline-queue replays never eat the budget.
  const previous = readLedger(paths.commandsLedgerPath, log).find((e) => e.clientId === req.clientId)
  if (previous !== undefined) {
    return { status: 200, body: { status: 'duplicate', commandId: previous.commandId } }
  }

  if (!limiter.tryAdmit(now.getTime())) return { status: 429, body: { error: 'rate limited' } }

  const commandId = `cmd-${shortHash(req.clientId, 8)}`
  const requestedAt = toWarsawIso(now)
  writeQueueFile(writer, paths.lensQueueDir, 'command', commandId, {
    type: 'command',
    commandId,
    command: req.type,
    payload: req.payload,
    requestedAt,
  })
  writer.appendLine(
    paths.commandsLedgerPath,
    JSON.stringify({ clientId: req.clientId, commandId, type: req.type, requestedAt }),
  )
  // ids only — command payloads (topics, note text) never reach journal or logs
  appendJournal(writer, paths.journalPath, {
    type: 'command',
    at: requestedAt,
    title: 'Command queued',
    detail: `${commandId} → ${req.type}`,
    relatedId: commandId,
  })
  log.info('command accepted', { id: commandId, type: req.type })
  return { status: 201, body: { status: 'ok', commandId } }
}

export function listCommands(
  deps: { paths: Paths; log: Logger; now: Date },
  limitParam: string | null,
): CommandResult {
  const { paths, log, now } = deps
  let limit = DEFAULT_LIMIT
  if (limitParam !== null) {
    if (!/^[1-9]\d*$/.test(limitParam) || Number(limitParam) > MAX_LIMIT) {
      return { status: 400, body: { error: 'invalid limit' } }
    }
    limit = Number(limitParam)
  }

  const queued = readQueueState(paths.lensQueueDir, log).commands
  const results = readCommandResults(paths.commandResultsDir, log)

  const seen = new Set<string>()
  const items = readLedger(paths.commandsLedgerPath, log)
    .filter((e) => {
      if (seen.has(e.commandId)) return false
      seen.add(e.commandId)
      return true
    })
    .map((e) => {
      const result = results.get(e.commandId)
      // A written result outranks a not-yet-deleted queue file: the runner
      // finishes the command before it removes the file.
      const state = result !== undefined ? result.state : queued.has(e.commandId) ? 'pending' : 'running'
      return {
        commandId: e.commandId,
        type: e.type,
        requestedAt: e.requestedAt,
        state,
        ...(result?.summary !== undefined ? { summary: result.summary } : {}),
        ...(result?.result !== undefined ? { result: result.result } : {}),
      }
    })
    .sort((a, b) => (parseIsoMs(b.requestedAt) ?? 0) - (parseIsoMs(a.requestedAt) ?? 0))
    .slice(0, limit)

  return { status: 200, body: { items, generatedAt: toWarsawIso(now) } }
}
