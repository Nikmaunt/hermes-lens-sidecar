import { z } from 'zod'
import { Id, IsoDate, IsoDateTime } from './common'

/**
 * OPEN enum (response): display-only lifecycle label, not a protocol state —
 * an unknown status from a newer server reads as 'paused' (neutral: shown,
 * but neither active nor done) instead of failing the Projects screen.
 */
export const ProjectStatus = z.enum(['active', 'paused', 'done'])
export type ProjectStatus = z.infer<typeof ProjectStatus>

export const Project = z.object({
  id: Id,
  name: z.string(),
  status: ProjectStatus.catch('paused'),
  summary: z.string(),
  nextAction: z.string().nullable(),
  keyDates: z.array(
    z.object({
      label: z.string(),
      date: IsoDate,
    }),
  ),
  /** Linked vault notes (titles only; content lives on the VPS). */
  linkedNotes: z.array(
    z.object({
      id: Id,
      title: z.string(),
      updatedAt: IsoDateTime,
    }),
  ),
  updatedAt: IsoDateTime,
})
export type Project = z.infer<typeof Project>

export const ProjectsResponse = z.object({
  projects: z.array(Project),
})
export type ProjectsResponse = z.infer<typeof ProjectsResponse>
