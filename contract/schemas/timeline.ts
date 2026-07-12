import { z } from 'zod'
import { EventCategory, Id, IsoDateTime } from './common'

export const TimelineEvent = z.object({
  id: Id,
  at: IsoDateTime,
  /**
   * OPEN enum fallback: a category this app version does not know renders as
   * a system event (in-place expansion, Status routing) instead of failing
   * the whole timeline parse.
   */
  category: EventCategory.catch('system'),
  title: z.string(),
  detail: z.string().nullable(),
  /** Optional id of a related entity (project, person, memory item…). */
  relatedId: Id.nullable(),
  /**
   * Machine-readable event kind (free string, deliberately NOT an enum — the
   * server is free to add kinds ahead of the app). When present it drives tap
   * routing (see lib/eventRoute.ts); absent on events from an older sidecar,
   * which fall back to the FRAGILE title-prefix match.
   */
  kind: z.string().optional(),
})
export type TimelineEvent = z.infer<typeof TimelineEvent>

export const TimelineResponse = z.object({
  events: z.array(TimelineEvent), // newest first
  /** Cursor: pass as ?before= to fetch older events; null = no more. */
  nextBefore: IsoDateTime.nullable(),
})
export type TimelineResponse = z.infer<typeof TimelineResponse>
