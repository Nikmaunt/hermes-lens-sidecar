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

/** Body of POST /api/inbox/{id}/untriage — intentionally empty. */
export const UntriageRequest = z.object({})
export type UntriageRequest = z.infer<typeof UntriageRequest>

export const UntriageResponse = z.object({
  /**
   * "ok" = the pending triage was cancelled and the item is visible in the
   * inbox again; "gone" = nothing was pending (already processed by the
   * agent, or never triaged) — the client treats both as success.
   */
  status: z.enum(['ok', 'gone']),
  itemId: Id,
})
export type UntriageResponse = z.infer<typeof UntriageResponse>
