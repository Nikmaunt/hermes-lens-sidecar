import { readTextIfExists, listFiles } from '../lib/fsread.js'
import type { Logger } from '../lib/log.js'

/**
 * Read-side view of vault/system/lens-queue/. Queue files are written by
 * this sidecar and consumed (deleted) by the agent's triage cron; while one
 * exists, its request is "pending" and shapes what we serve:
 *   - pending triage hides the inbox item,
 *   - pending flag decorates the memory item (and masks it immediately for
 *     mark-sensitive).
 */

export interface PendingFlagEntry {
  action: 'forget' | 'mark-sensitive'
  requestedAt: string
}

export interface PendingFollowupAction {
  action: 'done' | 'snooze' | 'someday'
  until?: string
  requestedAt: string
}

export interface PendingSomedayAction {
  action: 'activate' | 'close'
  date?: string
  requestedAt: string
}

/** One well-formed queue file, addressable for undo (delete-by-match). */
export interface PendingQueueFile {
  path: string
  type: 'triage' | 'followup' | 'someday' | 'habit-tick' | 'flag'
  itemId: string
  /** habit-tick only: the date the pending tick is for. */
  date?: string
}

export interface QueueState {
  triagedItemIds: Set<string>
  /** itemId → latest pending flag. */
  flags: Map<string, PendingFlagEntry>
  /** followup itemId → latest pending done/snooze/someday request. */
  followupActions: Map<string, PendingFollowupAction>
  /** someday itemId → latest pending activate/close request. */
  somedayActions: Map<string, PendingSomedayAction>
  /** habitId → dates with a pending tick (unioned into completedDates). */
  habitTicks: Map<string, Set<string>>
  /**
   * commandId → still-queued command request. NOT in pendingFiles: commands
   * are fire-and-forget with no undo in v1, so they must never become
   * addressable by the delete-by-match undo primitive.
   */
  commands: Map<string, PendingCommand>
  /** Every well-formed queue file — undo deletes matching entries. */
  pendingFiles: PendingQueueFile[]
}

export interface PendingCommand {
  command: string
  requestedAt: string
}

export function readQueueState(lensQueueDir: string, log: Logger): QueueState {
  const state: QueueState = {
    triagedItemIds: new Set(),
    flags: new Map(),
    followupActions: new Map(),
    somedayActions: new Map(),
    habitTicks: new Map(),
    commands: new Map(),
    pendingFiles: [],
  }
  const files = listFiles(lensQueueDir, log)
  files.sort((a, b) => a.name.localeCompare(b.name)) // ts-prefixed → chronological
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue
    const raw = readTextIfExists(f.path, log)
    if (raw === undefined) continue
    try {
      const q = JSON.parse(raw) as Record<string, unknown>
      if (q.type === 'triage' && typeof q.itemId === 'string') {
        state.triagedItemIds.add(q.itemId)
        state.pendingFiles.push({ path: f.path, type: 'triage', itemId: q.itemId })
      } else if (
        q.type === 'followup' &&
        typeof q.itemId === 'string' &&
        (q.action === 'done' || q.action === 'snooze' || q.action === 'someday')
      ) {
        state.followupActions.set(q.itemId, {
          action: q.action,
          ...(typeof q.until === 'string' ? { until: q.until } : {}),
          requestedAt: typeof q.requestedAt === 'string' ? q.requestedAt : '1970-01-01T01:00:00+01:00',
        })
        state.pendingFiles.push({ path: f.path, type: 'followup', itemId: q.itemId })
      } else if (
        q.type === 'someday' &&
        typeof q.itemId === 'string' &&
        (q.action === 'activate' || q.action === 'close')
      ) {
        state.somedayActions.set(q.itemId, {
          action: q.action,
          ...(typeof q.date === 'string' ? { date: q.date } : {}),
          requestedAt: typeof q.requestedAt === 'string' ? q.requestedAt : '1970-01-01T01:00:00+01:00',
        })
        state.pendingFiles.push({ path: f.path, type: 'someday', itemId: q.itemId })
      } else if (
        q.type === 'habit-tick' &&
        typeof q.habitId === 'string' &&
        typeof q.date === 'string'
      ) {
        const dates = state.habitTicks.get(q.habitId) ?? new Set<string>()
        dates.add(q.date)
        state.habitTicks.set(q.habitId, dates)
        state.pendingFiles.push({ path: f.path, type: 'habit-tick', itemId: q.habitId, date: q.date })
      } else if (q.type === 'command' && typeof q.commandId === 'string') {
        state.commands.set(q.commandId, {
          command: typeof q.command === 'string' ? q.command : '',
          requestedAt: typeof q.requestedAt === 'string' ? q.requestedAt : '1970-01-01T01:00:00+01:00',
        })
      } else if (
        q.type === 'flag' &&
        typeof q.itemId === 'string' &&
        (q.action === 'forget' || q.action === 'mark-sensitive')
      ) {
        state.flags.set(q.itemId, {
          action: q.action,
          requestedAt: typeof q.requestedAt === 'string' ? q.requestedAt : '1970-01-01T01:00:00+01:00',
        })
        state.pendingFiles.push({ path: f.path, type: 'flag', itemId: q.itemId })
      }
    } catch {
      log.warn('malformed queue file skipped', { file: f.name })
    }
  }
  return state
}
