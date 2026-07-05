import { z } from 'zod'
import { Id, IsoDate, Money } from './common'

export const DocumentKind = z.enum(['contract', 'subscription', 'insurance', 'id-document'])
export type DocumentKind = z.infer<typeof DocumentKind>

export const DocumentItem = z.object({
  id: Id,
  title: z.string(),
  kind: DocumentKind,
  provider: z.string(),
  amount: Money.nullable(),
  billingPeriod: z.enum(['monthly', 'yearly']).nullable(),
  /** Next renewal / expiry date. */
  renewsOn: IsoDate.nullable(),
  /** Last day to cancel before auto-renewal. */
  cancelBy: IsoDate.nullable(),
  notes: z.string().nullable(),
})
export type DocumentItem = z.infer<typeof DocumentItem>

export const DocumentsResponse = z.object({
  items: z.array(DocumentItem),
  /** Total recurring spend normalized to per-month, one entry per currency. */
  monthlyTotal: z.array(Money),
  /**
   * Month-to-date actual spend per currency (additive, optional). Present
   * iff the agent has a transactions file for the current month.
   */
  spentThisMonth: z.array(Money).optional(),
})
export type DocumentsResponse = z.infer<typeof DocumentsResponse>
