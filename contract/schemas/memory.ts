import { z } from 'zod'
import { Id, IsoDateTime, Sensitivity } from './common'

/**
 * OPEN enum (response): the agent may invent new memory categories ahead of
 * the app. The fallback lives at the MemoryItem.category site as
 * `.catch('misc')` — not here, because `.options` powers the category chips.
 */
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

/**
 * CLOSED enum: request mutation — a 400 from an older sidecar that does not
 * know a new action is the correct outcome; new actions deploy client-first.
 */
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
  /** OPEN enum fallback: an unknown category lands in 'misc' (neutral). */
  category: MemoryCategory.catch('misc'),
  /** Short topic used for grouping and the Memory Map, e.g. "coffee". */
  topic: z.string(),
  fact: z.string(),
  /** OPEN enum fallback, fail-closed: unknown level masks, never leaks. */
  sensitivity: Sensitivity.catch('sensitive'),
  /**
   * OPEN enum fallback: source is display-only; an unknown ingestion channel
   * reads as 'inferred' instead of failing the memory list parse.
   */
  source: z.enum(['telegram', 'vault', 'inferred', 'capture']).catch('inferred'),
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
