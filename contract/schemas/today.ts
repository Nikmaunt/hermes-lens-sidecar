import { z } from 'zod'
import { EventCategory, Id, IsoDate, IsoDateTime } from './common'

/**
 * A done/snooze/someday request queued for the agent (not yet executed).
 * "someday" is sidecar-first: the live /api/today overlay reports it before
 * any Someday screen exists in the app, so the schema must tolerate it.
 */
export const FollowUpPendingAction = z.object({
  /**
   * CLOSED enum: this echoes back actions the client itself queued, and new
   * queue actions deploy client-first (enum-first-in-app) — so the app always
   * knows every value the server can legally send here.
   */
  action: z.enum(['done', 'snooze', 'someday']),
  until: IsoDate.optional(),
  requestedAt: IsoDateTime,
})
export type FollowUpPendingAction = z.infer<typeof FollowUpPendingAction>

export const FollowUp = z.object({
  id: Id,
  title: z.string(),
  dueDate: IsoDate.nullable(),
  source: z.string(), // where the follow-up came from, e.g. "telegram 12 Jun"
  /**
   * OPEN enum fallback: urgency only picks a badge tone; an unknown level
   * from a newer server degrades to the middle tone instead of killing Today.
   */
  urgency: z.enum(['overdue', 'today', 'soon']).catch('today'),
  pendingAction: FollowUpPendingAction.optional(),
})
export type FollowUp = z.infer<typeof FollowUp>

export const UpcomingDeadline = z.object({
  id: Id,
  title: z.string(),
  date: IsoDate,
  /**
   * OPEN enum fallback: kind only picks an icon; an unknown deadline kind
   * renders with the generic document icon instead of killing Today.
   */
  kind: z.enum(['document', 'subscription']).catch('document'),
  daysLeft: z.int(),
})
export type UpcomingDeadline = z.infer<typeof UpcomingDeadline>

export const AgentActivityItem = z.object({
  id: Id,
  at: IsoDateTime,
  summary: z.string(),
  /** OPEN enum fallback — same decision as TimelineEvent.category. */
  category: EventCategory.catch('system'),
})
export type AgentActivityItem = z.infer<typeof AgentActivityItem>

export const TodaySummary = z.object({
  date: IsoDate,
  followUps: z.array(FollowUp),
  deadlines: z.array(UpcomingDeadline), // next 30 days, sorted ascending
  agentActivity: z.array(AgentActivityItem), // last 24 h, newest first
  inboxCount: z.int().nonnegative(),
  generatedAt: IsoDateTime,
  /** Today's freshest morning brief, when one exists (additive, optional). */
  brief: z.object({ id: Id, title: z.string() }).optional(),
})
export type TodaySummary = z.infer<typeof TodaySummary>
