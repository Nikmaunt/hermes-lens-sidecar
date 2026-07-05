import { z } from 'zod'
import { Id, IsoDateTime, Sensitivity } from './common'

export const MemoryCategory = z.enum([
  'identity',
  'preferences',
  'health',
  'routines',
  'plans',
  'relationships',
  'finance',
  'misc',
])
export type MemoryCategory = z.infer<typeof MemoryCategory>

export const FlagAction = z.enum(['forget', 'mark-sensitive'])
export type FlagAction = z.infer<typeof FlagAction>

/** A pending flag request queued for the agent (not yet executed). */
export const PendingFlag = z.object({
  action: FlagAction,
  requestedAt: IsoDateTime,
  status: z.literal('pending'),
})
export type PendingFlag = z.infer<typeof PendingFlag>

export const MemoryItem = z.object({
  id: Id,
  category: MemoryCategory,
  /** Short topic used for grouping and the Memory Map, e.g. "coffee". */
  topic: z.string(),
  fact: z.string(),
  sensitivity: Sensitivity,
  source: z.enum(['telegram', 'vault', 'inferred', 'capture']),
  learnedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  pendingFlag: PendingFlag.nullable(),
})
export type MemoryItem = z.infer<typeof MemoryItem>

export const MemoryResponse = z.object({
  items: z.array(MemoryItem),
})
export type MemoryResponse = z.infer<typeof MemoryResponse>

export const FlagRequest = z.object({
  action: FlagAction,
  reason: z.string().optional(),
})
export type FlagRequest = z.infer<typeof FlagRequest>

export const FlagResponse = z.object({
  status: z.literal('pending'),
  itemId: Id,
})
export type FlagResponse = z.infer<typeof FlagResponse>
