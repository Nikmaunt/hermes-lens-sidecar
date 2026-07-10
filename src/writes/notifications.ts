import { join } from 'node:path'
import { readTextIfExists } from '../lib/fsread.js'
import { shortHash } from '../lib/hash.js'
import { parseIsoMs, toWarsawIso } from '../lib/time.js'
import type { Logger } from '../lib/log.js'
import type { Paths } from '../config.js'
import type { Writer } from './fswrite.js'
import { appendJournal } from './journal.js'

/**
 * POST /api/notifications — the phone's notification listener posts one
 * sanitized notification per request; the sidecar files it as a NEW record
 * into vault/system/notif-inbox/ for the agent's triage (observation phase).
 * Append-only input: the sidecar never updates or deletes records there —
 * the agent consumes them. Contract: NotificationCaptureRequest/Response.
 */

export interface NotificationResult {
  status: number
  body: { status: 'ok' | 'duplicate'; itemId: string } | { error: string }
}

/** Extra cap on top of the per-field schema: one record carries ≤ 4 KiB of payload. */
const PAYLOAD_BYTES_CAP = 4096

const RATE_LIMIT_MAX = 120
const RATE_WINDOW_MS = 3_600_000

/**
 * Sliding-window admission counter (120 records/hour) for notification
 * writes. In-memory on purpose: сброс на рестарте приемлем by design —
 * защита от бомбёжки, не биллинг; клиентская очередь трактует 429 как
 * транзиент и дошлёт.
 */
export class NotificationRateLimiter {
  private admitted: number[] = []

  tryAdmit(nowMs: number): boolean {
    this.admitted = this.admitted.filter((t) => t > nowMs - RATE_WINDOW_MS)
    if (this.admitted.length >= RATE_LIMIT_MAX) return false
    this.admitted.push(nowMs)
    return true
  }
}

interface NotifReq {
  clientId: string
  package: string
  postedAt: string
  capturedAt: string
  title: string
  text: string
  bigText?: string
}

/**
 * Hand-rolled mirror of NotificationCaptureRequest (zod stays dev-only).
 * postedAt/capturedAt are additionally required to be parseable — the
 * record file name derives from postedAt.
 */
function validate(body: unknown): { ok: NotifReq } | { err: string } {
  if (typeof body !== 'object' || body === null) return { err: 'invalid body' }
  const r = body as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
  const clientId = str('clientId')
  if (clientId === undefined || clientId.length < 8) return { err: 'clientId must be a string of at least 8 characters' }
  const pkg = str('package')
  if (pkg === undefined || pkg.length < 1 || pkg.length > 100) return { err: 'package must be a string of 1..100 characters' }
  const postedAt = str('postedAt')
  if (postedAt === undefined || parseIsoMs(postedAt) === null) return { err: 'postedAt must be an ISO-8601 datetime' }
  const capturedAt = str('capturedAt')
  if (capturedAt === undefined || parseIsoMs(capturedAt) === null) return { err: 'capturedAt must be an ISO-8601 datetime' }
  const title = str('title')
  if (title === undefined || title.length > 300) return { err: 'title must be a string of at most 300 characters' }
  const text = str('text')
  if (text === undefined || text.length > 4096) return { err: 'text must be a string of at most 4096 characters' }
  if ('bigText' in r && r.bigText !== undefined && typeof r.bigText !== 'string') return { err: 'bigText must be a string' }
  const bigText = str('bigText')
  if (bigText !== undefined && bigText.length > 4096) return { err: 'bigText must be at most 4096 characters' }
  return {
    ok: { clientId, package: pkg, postedAt, capturedAt, title, text, ...(bigText !== undefined ? { bigText } : {}) },
  }
}

/** clientId → itemId of the first accepted record (offline-replay dedup). */
function readLedger(path: string, log: Logger): Map<string, string> {
  const map = new Map<string, string>()
  const raw = readTextIfExists(path)
  if (raw === undefined) return map
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as { clientId?: unknown; itemId?: unknown }
      if (typeof e.clientId === 'string' && typeof e.itemId === 'string') map.set(e.clientId, e.itemId)
    } catch {
      log.warn('malformed ledger line skipped')
    }
  }
  return map
}

/** Last package segment, reduced to filename-safe chars (Writer refuses separators). */
function pkgShort(pkg: string): string {
  const last = pkg.split('.').at(-1) ?? ''
  const safe = last.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return safe === '' ? 'app' : safe.slice(0, 40)
}

/** One-line YAML scalar: frontmatter must survive any client-sent string. */
function fmScalar(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}

function recordContent(req: NotifReq): string {
  const title = fmScalar(req.title).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const lines = [
    '---',
    'source: notification',
    `package: ${fmScalar(req.package)}`,
    `postedAt: ${fmScalar(req.postedAt)}`,
    `title: "${title}"`,
    `clientId: ${fmScalar(req.clientId)}`,
    '---',
    '',
    req.text.trim(),
  ]
  const big = req.bigText?.trim() ?? ''
  if (big !== '' && big !== req.text.trim()) lines.push('', big)
  lines.push('')
  return lines.join('\n')
}

export function handleNotification(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  limiter: NotificationRateLimiter,
  body: unknown,
): NotificationResult {
  const { paths, writer, log, now } = deps
  const v = validate(body)
  if ('err' in v) return { status: 400, body: { error: v.err } }
  const req = v.ok

  const payloadBytes =
    Buffer.byteLength(req.text, 'utf8') +
    (req.bigText === undefined ? 0 : Buffer.byteLength(req.bigText, 'utf8'))
  if (payloadBytes > PAYLOAD_BYTES_CAP) return { status: 413, body: { error: 'record too large' } }

  // Dedup BEFORE the rate limit: offline-queue replays never eat the budget.
  const previous = readLedger(paths.notificationsLedgerPath, log).get(req.clientId)
  if (previous !== undefined) return { status: 200, body: { status: 'duplicate', itemId: previous } }

  if (!limiter.tryAdmit(now.getTime())) return { status: 429, body: { error: 'rate limited' } }

  const postTimeMs = parseIsoMs(req.postedAt) ?? now.getTime() // validated → never falls back
  const itemId = `${postTimeMs}-${pkgShort(req.package)}-${shortHash(req.clientId, 8)}`
  let created = true
  try {
    writer.writeNewFileExclusive(join(paths.notifInboxDir, `${itemId}.md`), recordContent(req))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Same postedAt+package+clientId already on disk (ledger lost, e.g. a
    // data-dir move) — append-only input, so answer duplicate, never rewrite.
    created = false
  }
  writer.appendLine(paths.notificationsLedgerPath, JSON.stringify({ clientId: req.clientId, itemId }))
  if (!created) return { status: 200, body: { status: 'duplicate', itemId } }

  // ids only — notification titles/bodies never reach journal or logs
  appendJournal(writer, paths.journalPath, {
    type: 'notification',
    at: toWarsawIso(now),
    title: 'Notification captured',
    detail: itemId,
    relatedId: itemId,
  })
  log.info('notification accepted', { id: itemId })
  return { status: 201, body: { status: 'ok', itemId } }
}
