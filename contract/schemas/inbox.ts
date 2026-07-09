import { z } from 'zod'
import { Id, IsoDateTime } from './common'

export const InboxItem = z.object({
  id: Id,
  text: z.string(),
  capturedAt: IsoDateTime,
  source: z.enum(['telegram', 'capture', 'agent']),
  tags: z.array(z.string()),
})
export type InboxItem = z.infer<typeof InboxItem>

export const InboxResponse = z.object({
  items: z.array(InboxItem), // oldest first (triage order)
})
export type InboxResponse = z.infer<typeof InboxResponse>

/** Where a triaged inbox item goes in the agent's vault. */
export const TriageDestination = z.enum(['note', 'task', 'memory', 'archive', 'trash'])
export type TriageDestination = z.infer<typeof TriageDestination>

export const TriageRequest = z.object({
  destination: TriageDestination,
})
export type TriageRequest = z.infer<typeof TriageRequest>

export const TriageResponse = z.object({
  status: z.literal('ok'),
  itemId: Id,
})
export type TriageResponse = z.infer<typeof TriageResponse>

export const UntriageResponse = z.object({
  /**
   * "ok" = the triage was cancelled and the note is back in the inbox;
   * "gone" = the agent already processed it, nothing left to cancel.
   */
  status: z.enum(['ok', 'gone']),
  itemId: Id,
})
export type UntriageResponse = z.infer<typeof UntriageResponse>
