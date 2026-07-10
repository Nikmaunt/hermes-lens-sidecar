import { z } from 'zod'

/**
 * TODO(enum-first/re-copy): LOCAL schema for /api/transactions — the app
 * repo's contract mirror (contract/schemas/) does not know this endpoint
 * yet. When hermes-lens ships its schema, re-copy the mirror verbatim, add
 * the endpoint to the contract walk, and delete this file.
 *
 * This module is imported ONLY by tests and is excluded from the runtime
 * build (tsconfig.json "exclude") — zod stays a dev-only dependency and
 * dist/ keeps zero runtime deps, same rule as contract/ (see its README).
 *
 * Money follows the project invariant: integer minor units + ISO-4217,
 * totals are SEPARATE per currency — there is no single combined total.
 */

export const TransactionCurrency = z.enum(['EUR', 'PLN', 'USD'])
export type TransactionCurrency = z.infer<typeof TransactionCurrency>

export const TransactionItem = z.object({
  /** txn- + shortHash(verbatim line, 10) — the fu-/sd- id pattern. */
  id: z.string().regex(/^txn-[0-9a-f]{10}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountMinor: z.number().int().nonnegative(),
  currency: TransactionCurrency,
  merchant: z.string().min(1),
  note: z.string().optional(),
})
export type TransactionItem = z.infer<typeof TransactionItem>

export const TransactionsTotal = z.object({
  currency: TransactionCurrency,
  amountMinor: z.number().int().nonnegative(),
})
export type TransactionsTotal = z.infer<typeof TransactionsTotal>

export const TransactionsResponse = z.object({
  items: z.array(TransactionItem),
  totals: z.array(TransactionsTotal),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  generatedAt: z.string(),
})
export type TransactionsResponse = z.infer<typeof TransactionsResponse>
