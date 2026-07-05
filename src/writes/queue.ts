import { join } from 'node:path'
import { toWarsawIso } from '../lib/time.js'
import { readQueueState } from '../readers/queuestate.js'
import type { Logger } from '../lib/log.js'
import type { Paths } from '../config.js'
import type { Writer } from './fswrite.js'
import { appendJournal } from './journal.js'

/**
 * POST /api/inbox/{id}/triage and /api/memory/{id}/flag.
 * The sidecar never executes these actions itself — it queues request files
 * under vault/system/lens-queue/ for the agent's triage cron to consume,
 * and answers idempotently for items already queued or already processed.
 */

export interface HandlerResult {
  status: number
  body: unknown
}

/** ids are filename slugs / mem-<hash> — same charset, no path tricks. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

const TRIAGE_DESTINATIONS = new Set(['note', 'task', 'memory', 'archive', 'trash'])

function writeQueueFile(writer: Writer, dir: string, kind: string, itemId: string, payload: object): void {
  for (let bump = 0; bump < 5; bump++) {
    const name = `${Date.now() + bump}-${kind}-${itemId}.json`
    try {
      writer.writeNewFileExclusive(join(dir, name), JSON.stringify(payload, null, 2) + '\n')
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('could not allocate queue filename')
}

export function handleTriage(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  itemId: string,
  body: unknown,
): HandlerResult {
  const { paths, writer, log, now } = deps
  if (!ID_RE.test(itemId)) return { status: 400, body: { error: 'invalid item id' } }
  const destination =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).destination : undefined
  if (typeof destination !== 'string' || !TRIAGE_DESTINATIONS.has(destination)) {
    return { status: 400, body: { error: 'invalid destination' } }
  }

  // Already queued (or a replay racing the agent): same success shape,
  // no second queue file.
  const queue = readQueueState(paths.lensQueueDir, log)
  if (!queue.triagedItemIds.has(itemId)) {
    const requestedAt = toWarsawIso(now)
    writeQueueFile(writer, paths.lensQueueDir, 'triage', itemId, {
      type: 'triage',
      itemId,
      destination,
      requestedAt,
    })
    appendJournal(writer, paths.journalPath, {
      type: 'triage',
      at: requestedAt,
      title: 'Inbox triage queued',
      detail: `${itemId} → ${destination}`,
      relatedId: itemId,
    })
    log.info('triage queued', { itemId, destination })
  }
  return { status: 200, body: { status: 'ok', itemId } }
}

export function handleFlag(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  itemId: string,
  body: unknown,
): HandlerResult {
  const { paths, writer, log, now } = deps
  if (!ID_RE.test(itemId)) return { status: 400, body: { error: 'invalid item id' } }
  const req = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const action = req.action
  if (action !== 'forget' && action !== 'mark-sensitive') {
    return { status: 400, body: { error: 'invalid action' } }
  }
  const reason = typeof req.reason === 'string' && req.reason !== '' ? req.reason : undefined

  const queue = readQueueState(paths.lensQueueDir, log)
  const existing = queue.flags.get(itemId)
  if (existing === undefined || existing.action !== action) {
    const requestedAt = toWarsawIso(now)
    writeQueueFile(writer, paths.lensQueueDir, 'flag', itemId, {
      type: 'flag',
      itemId,
      action,
      ...(reason !== undefined ? { reason } : {}),
      requestedAt,
    })
    appendJournal(writer, paths.journalPath, {
      type: 'flag',
      at: requestedAt,
      title: 'Memory flag queued',
      detail: action,
      relatedId: itemId,
    })
    log.info('flag queued', { itemId, action })
  }
  return { status: 200, body: { status: 'pending', itemId } }
}
