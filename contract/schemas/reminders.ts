import { z } from 'zod'
import { Id, IsoDateTime } from './common'

/** A dated commitment the agent wants on the phone's calendar. */
export const Reminder = z.object({
  id: Id,
  title: z.string().min(1),
  /** When the thing happens (ISO-8601 with offset). */
  dueAt: IsoDateTime,
  /** Minutes of warning the calendar event should carry (event reminder). */
  leadTimeMinutes: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
  /** Critical reminders must never be dropped silently by the client. */
  critical: z.boolean(),
  /** Opaque pointer back to the agent-side source (note id, document id…). */
  sourceRef: z.string().optional(),
})
export type Reminder = z.infer<typeof Reminder>

export const RemindersResponse = z.object({
  items: z.array(Reminder),
  /**
   * Opaque feed revision. Unchanged revision ⇒ the client skips the
   * calendar sync entirely (no-op detection without diffing every item).
   */
  revision: z.string().min(1),
})
export type RemindersResponse = z.infer<typeof RemindersResponse>
