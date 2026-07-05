import { z } from 'zod'
import { IsoDateTime } from './common'

/**
 * Tells the agent the phone has applied a reminders feed revision to the
 * device calendar. Idempotent: replaying the same ack (offline queue) is
 * always safe.
 */
export const SyncAckRequest = z.object({
  syncedAt: IsoDateTime,
  lastSeenRevision: z.string().min(1),
})
export type SyncAckRequest = z.infer<typeof SyncAckRequest>

export const SyncAckResponse = z.object({
  status: z.literal('ok'),
})
export type SyncAckResponse = z.infer<typeof SyncAckResponse>
