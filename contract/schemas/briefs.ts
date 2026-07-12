import { z } from 'zod'
import { Id, IsoDate, IsoDateTime } from './common'

/**
 * OPEN enum (response): the server may grow new brief kinds ahead of the app.
 * Fallback applied at the field sites below — an unknown kind reads as
 * 'adhoc' (neutral badge, no morning-brief special-casing).
 */
export const BriefKind = z.enum(['morning', 'adhoc'])
export type BriefKind = z.infer<typeof BriefKind>

export const BriefListItem = z.object({
  id: Id,
  date: IsoDate,
  title: z.string(),
  kind: BriefKind.catch('adhoc'),
})
export type BriefListItem = z.infer<typeof BriefListItem>

export const BriefsResponse = z.object({
  /** Newest first; briefs older than 90 days are not listed. */
  items: z.array(BriefListItem),
})
export type BriefsResponse = z.infer<typeof BriefsResponse>

export const BriefDetail = z.object({
  id: Id,
  date: IsoDate,
  title: z.string(),
  kind: BriefKind.catch('adhoc'),
  /** Body without frontmatter, ready for a Markdown renderer. */
  markdown: z.string(),
  /** File mtime — when the agent (re)generated the brief. */
  generatedAt: IsoDateTime,
})
export type BriefDetail = z.infer<typeof BriefDetail>
