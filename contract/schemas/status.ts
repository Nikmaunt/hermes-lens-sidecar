import { z } from 'zod'
import { IsoDateTime } from './common'

export const CronJob = z.object({
  id: z.string(),
  name: z.string(),
  schedule: z.string(), // human-readable, e.g. "daily 06:00"
  lastRun: IsoDateTime,
  lastResult: z.enum(['ok', 'error', 'skipped']),
})
export type CronJob = z.infer<typeof CronJob>

export const AgentStatus = z.object({
  gateway: z.object({
    alive: z.boolean(),
    lastHeartbeat: IsoDateTime,
  }),
  cronJobs: z.array(CronJob),
  lastBackup: z
    .object({
      at: IsoDateTime,
      sizeBytes: z.int().nonnegative(),
      target: z.string(),
    })
    .nullable(),
  system: z.object({
    diskUsedBytes: z.int().nonnegative(),
    diskTotalBytes: z.int().positive(),
    ramUsedBytes: z.int().nonnegative(),
    ramTotalBytes: z.int().positive(),
    uptimeSeconds: z.int().nonnegative(),
  }),
  tokenSpend: z.object({
    todayUsd: z.number().nonnegative(),
    monthUsd: z.number().nonnegative(),
  }),
  generatedAt: IsoDateTime,
})
export type AgentStatus = z.infer<typeof AgentStatus>
