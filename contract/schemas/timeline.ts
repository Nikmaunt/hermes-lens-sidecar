import { z } from 'zod'
import { EventCategory, Id, IsoDateTime } from './common'

export const TimelineEvent = z.object({
  id: Id,
  at: IsoDateTime,
  category: EventCategory,
  title: z.string(),
  detail: z.string().nullable(),
  /** Optional id of a related entity (project, person, memory item…). */
  relatedId: Id.nullable(),
})
export type TimelineEvent = z.infer<typeof TimelineEvent>

export const TimelineResponse = z.object({
  events: z.array(TimelineEvent), // newest first
  /** Cursor: pass as ?before= to fetch older events; null = no more. */
  nextBefore: IsoDateTime.nullable(),
})
export type TimelineResponse = z.infer<typeof TimelineResponse>
