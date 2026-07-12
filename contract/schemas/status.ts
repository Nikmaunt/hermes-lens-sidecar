import { z } from 'zod'
import { IsoDateTime } from './common'

export const CronJob = z.object({
  id: z.string(),
  name: z.string(),
  schedule: z.string(), // human-readable, e.g. "daily 06:00"
  lastRun: IsoDateTime,
  /**
   * OPEN enum fallback, fail-alarming: this is a display-only run outcome,
   * not a protocol state. An unknown result from a newer server (say
   * 'timeout') renders in the danger tone — drawing attention is safer than
   * hiding a problem or failing the Status screen.
   */
  lastResult: z.enum(['ok', 'error', 'skipped']).catch('error'),
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
    /**
     * When the sidecar started counting (additive, optional — absent on an
     * older sidecar). Free-form date string; shown verbatim in the caption.
     */
    since: z.string().optional(),
  }),
  generatedAt: IsoDateTime,
})
export type AgentStatus = z.infer<typeof AgentStatus>
