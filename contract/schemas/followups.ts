import { z } from 'zod'
import { Id, IsoDate } from './common'

export const FollowupActionRequest = z.object({
  /** "someday" parks the follow-up on the sidecar's someday list (sidecar-first). */
  action: z.enum(['done', 'snooze', 'someday']),
  /** Required when action is "snooze": the new due date. */
  until: IsoDate.optional(),
})
export type FollowupActionRequest = z.infer<typeof FollowupActionRequest>

/**
 * Cancels a still-unprocessed pending done/snooze (the server deletes the
 * queue file). Same endpoint as FollowupActionRequest; kept as a separate
 * schema so the done/snooze enum stays untouched.
 */
export const FollowupUndoRequest = z.object({
  action: z.literal('undo'),
})
export type FollowupUndoRequest = z.infer<typeof FollowupUndoRequest>

export const FollowupActionResponse = z.object({
  /**
   * "ok" = queued for the agent; "gone" = the follow-up no longer exists
   * server-side (offline replay after the agent resolved it) — the client
   * treats it as success and drops the mutation.
   */
  status: z.enum(['ok', 'gone']),
  itemId: Id,
})
export type FollowupActionResponse = z.infer<typeof FollowupActionResponse>
