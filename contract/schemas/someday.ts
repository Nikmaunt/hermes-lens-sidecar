import { z } from 'zod'
import { Id, IsoDate, IsoDateTime } from './common'

/*
 * The someday list (deferred follow-ups).
 *
 * Sidecar-first, like chat: the server grows the someday overlay and its
 * action endpoint before any Someday screen ships in the app, so the LIVE
 * prod contract is the source of truth for these shapes — this release adds
 * only the schemas (plus "someday" tolerance in the today/followups enums);
 * the screen and DataSource methods come next release. Evolve additively only.
 *
 * Flow mirrors follow-ups: GET /api/someday lists parked items; POST an
 * action to activate one back onto the follow-up list (with a due date),
 * close it for good, or undo a still-unprocessed pending action.
 */

/** An activate/close request queued for the agent (not yet executed). */
export const SomedayPendingAction = z.object({
  action: z.enum(['activate', 'close']),
  /** Present when action is "activate": the due date the item returns with. */
  date: IsoDate.optional(),
  requestedAt: IsoDateTime,
})
export type SomedayPendingAction = z.infer<typeof SomedayPendingAction>

export const SomedayItem = z.object({
  id: Id,
  title: z.string(),
  /** Where the item came from, e.g. "telegram 14 Jun". */
  source: z.string().optional(),
  pendingAction: SomedayPendingAction.optional(),
})
export type SomedayItem = z.infer<typeof SomedayItem>

/** GET /api/someday response — the parked list. */
export const SomedayResponse = z.object({
  items: z.array(SomedayItem),
  generatedAt: IsoDateTime,
})
export type SomedayResponse = z.infer<typeof SomedayResponse>

/**
 * Someday item action request. "activate" returns the item to the follow-up
 * list on the given due date; "close" retires it; "undo" cancels a
 * still-unprocessed pending activate/close (the server deletes the queue
 * file), mirroring FollowupUndoRequest.
 */
export const SomedayActionRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('activate'), date: IsoDate }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('undo') }),
])
export type SomedayActionRequest = z.infer<typeof SomedayActionRequest>

export const SomedayActionResponse = z.object({
  /**
   * "ok" = queued for the agent; "gone" = the item no longer exists
   * server-side (offline replay after the agent resolved it) — the client
   * treats it as success and drops the mutation.
   */
  status: z.enum(['ok', 'gone']),
  itemId: Id,
})
export type SomedayActionResponse = z.infer<typeof SomedayActionResponse>
