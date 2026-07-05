import { hasUtcOffset, parseIsoMs, toWarsawIso } from '../lib/time.js'
import type { Logger } from '../lib/log.js'
import type { Paths } from '../config.js'
import type { Writer } from './fswrite.js'
import { appendJournal } from './journal.js'

/**
 * POST /api/sync/ack — the phone confirms it applied a reminders revision.
 * Overwrites vault/system/last-sync.json (atomic tmp+rename); acknowledging
 * any revision, current or stale, always succeeds (contract Idempotency —
 * the server just records the latest).
 */
export function handleSyncAck(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  body: unknown,
): { status: number; body: unknown } {
  const { paths, writer, log, now } = deps
  const req = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  if (typeof req.syncedAt !== 'string' || parseIsoMs(req.syncedAt) === null || !hasUtcOffset(req.syncedAt)) {
    return { status: 400, body: { error: 'syncedAt must be ISO-8601 with offset' } }
  }
  if (typeof req.lastSeenRevision !== 'string' || req.lastSeenRevision === '') {
    return { status: 400, body: { error: 'lastSeenRevision is required' } }
  }
  const receivedAt = toWarsawIso(now)
  writer.writeFileAtomic(
    paths.lastSyncPath,
    JSON.stringify({ syncedAt: req.syncedAt, lastSeenRevision: req.lastSeenRevision, receivedAt }, null, 2) +
      '\n',
  )
  appendJournal(writer, paths.journalPath, {
    type: 'ack',
    at: receivedAt,
    title: 'Reminders sync acknowledged',
    detail: req.lastSeenRevision,
    relatedId: null,
  })
  log.info('sync ack recorded')
  return { status: 200, body: { status: 'ok' } }
}
