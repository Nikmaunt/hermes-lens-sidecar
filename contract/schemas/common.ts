import { z } from 'zod'

/** ISO-8601 timestamp with timezone, e.g. "2026-07-04T09:30:00+02:00". */
export const IsoDateTime = z.iso.datetime({ offset: true })

/** Calendar date without time, e.g. "2026-07-04". */
export const IsoDate = z.iso.date()

export const Id = z.string().min(1)

/** Categories used across timeline events and filtering. */
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

/** Sensitivity levels for memory items. */
export const Sensitivity = z.enum(['normal', 'sensitive'])
export type Sensitivity = z.infer<typeof Sensitivity>

/** Money amounts are integer cents plus an ISO 4217 currency code. */
export const Money = z.object({
  cents: z.int(),
  currency: z.enum(['EUR', 'PLN', 'USD']),
})
export type Money = z.infer<typeof Money>
