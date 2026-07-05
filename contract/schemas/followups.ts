import { z } from 'zod'
import { Id, IsoDate } from './common'

export const FollowupActionRequest = z.object({
  action: z.enum(['done', 'snooze']),
  /** Required when action is "snooze": the new due date. */
  until: IsoDate.optional(),
})
export type FollowupActionRequest = z.infer<typeof FollowupActionRequest>

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
