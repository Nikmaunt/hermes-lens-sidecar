import { z } from 'zod'

/** ISO-8601 timestamp with timezone, e.g. "2026-07-04T09:30:00+02:00". */
export const IsoDateTime = z.iso.datetime({ offset: true })

/** Calendar date without time, e.g. "2026-07-04". */
export const IsoDate = z.iso.date()

export const Id = z.string().min(1)

/**
 * Categories used across timeline events and filtering.
 *
 * OPEN enum (response): the server may grow new categories ahead of the app.
 * The fallback lives at the response-field sites (timeline.ts, today.ts) as
 * `.catch('system')` — not here, because `.options` powers the filter chips
 * and `.catch` would hide it.
 */
export const EventCategory = z.enum([
  'agent',
  'memory',
  'capture',
  'habit',
  'document',
  'project',
  'people',
  'system',
])
export type EventCategory = z.infer<typeof EventCategory>

/**
 * Sensitivity levels for memory items.
 *
 * OPEN enum (response), fail-closed: an unknown level from a newer server
 * masks the item (`.catch('sensitive')` at the field site in memory.ts) —
 * degrading to 'normal' could leak content the server meant to protect.
 */
export const Sensitivity = z.enum(['normal', 'sensitive'])
export type Sensitivity = z.infer<typeof Sensitivity>

/**
 * Money amounts are integer cents plus an ISO 4217 currency code.
 *
 * CLOSED enum: money must never be silently relabeled into another currency —
 * a loud parse failure beats showing PLN amounts as EUR. Adding a currency is
 * a coordinated change (server sends it AND the client can format it).
 */
export const Money = z.object({
  cents: z.int(),
  currency: z.enum(['EUR', 'PLN', 'USD']),
})
export type Money = z.infer<typeof Money>
