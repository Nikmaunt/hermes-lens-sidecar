import { join } from 'node:path'
import { toWarsawIso } from '../lib/time.js'
import { readQueueState } from '../readers/queuestate.js'
import { readFollowupLines } from '../readers/vault.js'
import { readHabits } from '../readers/habits.js'
import type { Logger } from '../lib/log.js'
import type { Paths } from '../config.js'
import type { Writer } from './fswrite.js'
import { appendJournal } from './journal.js'

/**
 * POST /api/inbox/{id}/triage, /api/memory/{id}/flag and
 * /api/followups/{id}/action.
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

/** Strict calendar date: matches the shape AND survives a UTC round-trip. */
function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const ms = Date.parse(`${s}T00:00:00Z`)
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s
}

export function handleFollowupAction(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  itemId: string,
  body: unknown,
): HandlerResult {
  const { paths, writer, log, now } = deps
  if (!ID_RE.test(itemId)) return { status: 400, body: { error: 'invalid item id' } }
  const req = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const action = req.action
  if (action !== 'done' && action !== 'snooze') {
    return { status: 400, body: { error: 'invalid action' } }
  }
  let until: string | undefined
  if (action === 'snooze') {
    if (typeof req.until !== 'string' || !isValidIsoDate(req.until)) {
      return { status: 400, body: { error: 'snooze requires a valid until date (YYYY-MM-DD)' } }
    }
    until = req.until
  }

  // Same (itemId, action) already queued → idempotent replay, even if the
  // agent has meanwhile consumed the followups.md line.
  const queue = readQueueState(paths.lensQueueDir, log)
  const pending = queue.followupActions.get(itemId)
  if (pending !== undefined && pending.action === action) {
    return { status: 200, body: { status: 'ok', itemId } }
  }

  const line = readFollowupLines(paths.followupsPath, log).get(itemId)
  if (line === undefined) {
    // Offline replay against an item the agent already resolved:
    // success-by-staleness. NOT 404 — that would dead-letter the app's
    // mutation queue for what is actually a success.
    return { status: 200, body: { status: 'gone', itemId } }
  }

  const requestedAt = toWarsawIso(now)
  writeQueueFile(writer, paths.lensQueueDir, 'followup', itemId, {
    type: 'followup',
    itemId,
    action,
    ...(until !== undefined ? { until } : {}),
    // The agent cannot recompute the content hash — it locates the target
    // by this verbatim followups.md line.
    line,
    requestedAt,
  })
  appendJournal(writer, paths.journalPath, {
    type: 'followup-action',
    at: requestedAt,
    title: 'Follow-up action queued',
    detail: until !== undefined ? `${itemId} → ${action} until ${until}` : `${itemId} → ${action}`,
    relatedId: itemId,
  })
  log.info('followup action queued', { itemId, action })
  return { status: 200, body: { status: 'ok', itemId } }
}

export function handleHabitTick(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  habitId: string,
  body: unknown,
): HandlerResult {
  const { paths, writer, log, now } = deps
  if (!ID_RE.test(habitId)) return { status: 400, body: { error: 'invalid habit id' } }
  const req = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  if (typeof req.date !== 'string' || !isValidIsoDate(req.date)) {
    return { status: 400, body: { error: 'date must be a valid YYYY-MM-DD' } }
  }
  const date = req.date

  // Completed dates are a union, so a tick is naturally idempotent: already
  // pending or already recorded in habits.md → same success, no new file.
  const queue = readQueueState(paths.lensQueueDir, log)
  if (queue.habitTicks.get(habitId)?.has(date) === true) {
    return { status: 200, body: { status: 'ok', itemId: habitId } }
  }
  const habit = readHabits(paths.habitsPath, log).find((h) => h.id === habitId)
  if (habit === undefined) {
    // success-by-staleness for offline replays — see handleFollowupAction
    return { status: 200, body: { status: 'gone', itemId: habitId } }
  }
  if (habit.completedDates.includes(date)) {
    return { status: 200, body: { status: 'ok', itemId: habitId } }
  }

  const requestedAt = toWarsawIso(now)
  writeQueueFile(writer, paths.lensQueueDir, 'habit-tick', habitId, {
    type: 'habit-tick',
    habitId,
    // Verbatim name from habits.md — the agent matches the block by name,
    // it cannot recompute the translit slug.
    habitName: habit.name,
    date,
    requestedAt,
  })
  appendJournal(writer, paths.journalPath, {
    type: 'habit-tick',
    at: requestedAt,
    title: 'Habit tick queued',
    detail: `${habitId} → ${date}`,
    relatedId: habitId,
  })
  log.info('habit tick queued', { habitId, date })
  return { status: 200, body: { status: 'ok', itemId: habitId } }
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
