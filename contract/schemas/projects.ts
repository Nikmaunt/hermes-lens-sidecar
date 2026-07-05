import { z } from 'zod'
import { Id, IsoDate, IsoDateTime } from './common'

export const ProjectStatus = z.enum(['active', 'paused', 'done'])
export type ProjectStatus = z.infer<typeof ProjectStatus>

export const Project = z.object({
  id: Id,
  name: z.string(),
  status: ProjectStatus,
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
