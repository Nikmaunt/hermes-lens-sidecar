import { daysUntil, parseIsoMs, toWarsawDate, toWarsawIso } from '../lib/time.js'
import type { FollowUpOut, DocumentItemOut } from '../readers/vault.js'
import type { TimelineEventOut, EventCategoryOut } from './timeline.js'

/**
 * /api/today — mirrors MockDataSource.getToday (the contract's reference
 * algorithm): deadlines are documents within the next 30 days (a still-open
 * cancelBy window wins over renewsOn), sorted soonest-first; agentActivity
 * is the last 24 h of the timeline, newest first; inboxCount equals the
 * current /api/inbox length.
 */

export interface UpcomingDeadlineOut {
  id: string
  title: string
  date: string
  kind: 'document' | 'subscription'
  daysLeft: number
}

export interface TodayOut {
  date: string
  followUps: FollowUpOut[]
  deadlines: UpcomingDeadlineOut[]
  agentActivity: { id: string; at: string; summary: string; category: EventCategoryOut }[]
  inboxCount: number
  generatedAt: string
  /** Today's freshest morning brief, when one exists (additive, optional). */
  brief?: { id: string; title: string }
}

export function buildToday(input: {
  followUps: FollowUpOut[]
  documents: DocumentItemOut[]
  timelineEvents: TimelineEventOut[]
  inboxCount: number
  now: Date
  brief?: { id: string; title: string }
}): TodayOut {
  const { now } = input
  const deadlines: UpcomingDeadlineOut[] = []
  for (const doc of input.documents) {
    const kind = doc.kind === 'subscription' ? ('subscription' as const) : ('document' as const)
    if (doc.cancelBy !== null && daysUntil(doc.cancelBy, now) >= 0 && daysUntil(doc.cancelBy, now) <= 30) {
      deadlines.push({
        id: `${doc.id}-cancel`,
        title: `Cancel window: ${doc.title}`,
        date: doc.cancelBy,
        kind,
        daysLeft: daysUntil(doc.cancelBy, now),
      })
    } else if (
      doc.renewsOn !== null &&
      daysUntil(doc.renewsOn, now) >= 0 &&
      daysUntil(doc.renewsOn, now) <= 30
    ) {
      deadlines.push({
        id: `${doc.id}-renew`,
        title: `Renews: ${doc.title}`,
        date: doc.renewsOn,
        kind,
        daysLeft: daysUntil(doc.renewsOn, now),
      })
    }
  }
  deadlines.sort((a, b) => a.daysLeft - b.daysLeft)

  const dayAgoMs = now.getTime() - 86_400_000
  const agentActivity = input.timelineEvents
    .filter((e) => (parseIsoMs(e.at) ?? 0) >= dayAgoMs)
    .map((e) => ({ id: e.id, at: e.at, summary: e.title, category: e.category }))

  return {
    date: toWarsawDate(now),
    followUps: input.followUps,
    deadlines,
    agentActivity,
    inboxCount: input.inboxCount,
    generatedAt: toWarsawIso(now),
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
  }
}
