import { z } from 'zod'
import { EventCategory, Id, IsoDate, IsoDateTime } from './common'

export const FollowUp = z.object({
  id: Id,
  title: z.string(),
  dueDate: IsoDate.nullable(),
  source: z.string(), // where the follow-up came from, e.g. "telegram 12 Jun"
  urgency: z.enum(['overdue', 'today', 'soon']),
})
export type FollowUp = z.infer<typeof FollowUp>

export const UpcomingDeadline = z.object({
  id: Id,
  title: z.string(),
  date: IsoDate,
  kind: z.enum(['document', 'subscription']),
  daysLeft: z.int(),
})
export type UpcomingDeadline = z.infer<typeof UpcomingDeadline>

export const AgentActivityItem = z.object({
  id: Id,
  at: IsoDateTime,
  summary: z.string(),
  category: EventCategory,
})
export type AgentActivityItem = z.infer<typeof AgentActivityItem>

export const TodaySummary = z.object({
  date: IsoDate,
  followUps: z.array(FollowUp),
  deadlines: z.array(UpcomingDeadline), // next 30 days, sorted ascending
  agentActivity: z.array(AgentActivityItem), // last 24 h, newest first
  inboxCount: z.int().nonnegative(),
  generatedAt: IsoDateTime,
})
export type TodaySummary = z.infer<typeof TodaySummary>
