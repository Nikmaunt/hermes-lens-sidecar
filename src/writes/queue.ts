import { join } from 'node:path'
import { toWarsawIso } from '../lib/time.js'
import { readQueueState, type PendingQueueFile } from '../readers/queuestate.js'
import { readFollowupLines, readSomedayLines } from '../readers/vault.js'
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

/**
 * Undo primitive: delete every still-pending queue file matching the
 * predicate. Returns true if at least one file was actually removed —
 * false means there was nothing pending (the agent already consumed it,
 * or nothing was ever queued) and the caller answers "gone".
 */
function deletePendingFiles(
  deps: { paths: Paths; writer: Writer; log: Logger },
  match: (f: PendingQueueFile) => boolean,
): boolean {
  const queue = readQueueState(deps.paths.lensQueueDir, deps.log)
  let removed = false
  for (const f of queue.pendingFiles) {
    if (match(f)) removed = deps.writer.deleteQueueFile(f.path) || removed
  }
  return removed
}

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
  if (action !== 'done' && action !== 'snooze' && action !== 'someday' && action !== 'undo') {
    return { status: 400, body: { error: 'invalid action' } }
  }

  if (action === 'undo') {
    // Undo = delete the pending queue file(s) of this item. An action the
    // agent already consumed has no file left → gone (cannot be recalled).
    const removed = deletePendingFiles(deps, (f) => f.type === 'followup' && f.itemId === itemId)
    if (!removed) return { status: 200, body: { status: 'gone', itemId } }
    const undoneAt = toWarsawIso(now)
    appendJournal(writer, paths.journalPath, {
      type: 'followup-undo',
      at: undoneAt,
      title: 'Follow-up action undone',
      detail: `${itemId} → undo`,
      relatedId: itemId,
    })
    log.info('followup action undone', { itemId })
    return { status: 200, body: { status: 'ok', itemId } }
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

export function handleSomedayAction(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  itemId: string,
  body: unknown,
): HandlerResult {
  const { paths, writer, log, now } = deps
  if (!ID_RE.test(itemId)) return { status: 400, body: { error: 'invalid item id' } }
  const req = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const action = req.action
  if (action !== 'activate' && action !== 'close' && action !== 'undo') {
    return { status: 400, body: { error: 'invalid action' } }
  }

  if (action === 'undo') {
    // Mirrors followup undo: delete the still-pending someday file(s); an
    // action the agent already consumed has no file left → gone.
    const removed = deletePendingFiles(deps, (f) => f.type === 'someday' && f.itemId === itemId)
    if (!removed) return { status: 200, body: { status: 'gone', itemId } }
    appendJournal(writer, paths.journalPath, {
      type: 'someday-undo',
      at: toWarsawIso(now),
      title: 'Someday action undone',
      detail: `${itemId} → undo`,
      relatedId: itemId,
    })
    log.info('someday action undone', { itemId })
    return { status: 200, body: { status: 'ok', itemId } }
  }
  let date: string | undefined
  if (action === 'activate') {
    if (typeof req.date !== 'string' || !isValidIsoDate(req.date)) {
      return { status: 400, body: { error: 'activate requires a valid date (YYYY-MM-DD)' } }
    }
    date = req.date
  }

  // Same (itemId, action) already queued → idempotent replay, even if the
  // agent has meanwhile consumed the someday.md line.
  const queue = readQueueState(paths.lensQueueDir, log)
  const pending = queue.somedayActions.get(itemId)
  if (pending !== undefined && pending.action === action) {
    return { status: 200, body: { status: 'ok', itemId } }
  }

  const line = readSomedayLines(paths.somedayPath, log).get(itemId)
  if (line === undefined) {
    // success-by-staleness for offline replays — see handleFollowupAction
    return { status: 200, body: { status: 'gone', itemId } }
  }

  const requestedAt = toWarsawIso(now)
  writeQueueFile(writer, paths.lensQueueDir, 'someday', itemId, {
    type: 'someday',
    itemId,
    action,
    ...(date !== undefined ? { date } : {}),
    // The agent cannot recompute the content hash — it locates the target
    // by this verbatim someday.md line.
    line,
    requestedAt,
  })
  appendJournal(writer, paths.journalPath, {
    type: 'someday-action',
    at: requestedAt,
    title: 'Someday action queued',
    detail: date !== undefined ? `${itemId} → ${action} ${date}` : `${itemId} → ${action}`,
    relatedId: itemId,
  })
  log.info('someday action queued', { itemId, action })
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
  if (req.undo !== undefined && req.undo !== true) {
    return { status: 400, body: { error: 'undo must be true when present' } }
  }

  if (req.undo === true) {
    // Undo recalls only a PENDING tick (queue file still unconsumed). A date
    // already recorded in habits.md is not pending — nothing to delete, gone.
    const removed = deletePendingFiles(
      deps,
      (f) => f.type === 'habit-tick' && f.itemId === habitId && f.date === date,
    )
    if (!removed) return { status: 200, body: { status: 'gone', itemId: habitId } }
    log.info('habit tick undone', { habitId, date })
    return { status: 200, body: { status: 'ok', itemId: habitId } }
  }

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

export function handleUntriage(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  itemId: string,
): HandlerResult {
  const { log } = deps
  if (!ID_RE.test(itemId)) return { status: 400, body: { error: 'invalid item id' } }
  // Undo of a pending triage: the hide-from-inbox overlay lives only as the
  // queue file, so deleting it makes the note visible again on the next GET.
  // Repeat untriage (or one racing the agent's cron) finds no file → gone.
  const removed = deletePendingFiles(deps, (f) => f.type === 'triage' && f.itemId === itemId)
  if (!removed) return { status: 200, body: { status: 'gone', itemId } }
  log.info('triage undone', { itemId })
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
