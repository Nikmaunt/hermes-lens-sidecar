import { join } from 'node:path'
import { readTextIfExists } from '../lib/fsread.js'
import { shortHash } from '../lib/hash.js'
import { toWarsawMonth } from '../lib/time.js'
import type { Logger } from '../lib/log.js'

/**
 * vault/finance/transactions-YYYY-MM.md lines:
 *   `- YYYY-MM-DD HH:MM — <продавец> — <сумма> <PLN|EUR|USD> (<источник>)`
 * The money part also accepts both zloty spellings, mapped to PLN:
 *   `zł 23.99` (prefix) and `23,50 zł` (suffix).
 *
 * THE single transactions parser: it feeds both /api/transactions (itemized
 * month view) and spentThisMonth on /api/documents. Money is integer minor
 * units + ISO-4217, and totals stay SEPARATE per currency — the project
 * invariant forbids a single combined total.
 *
 * Returns undefined when the month's file does not exist — /api/documents
 * then omits spentThisMonth entirely (field presence == source presence),
 * /api/transactions serves an empty month (fail-open). Unparsable lines are
 * skipped with a warning; lines dated outside the file's month are junk and
 * skipped too.
 */

export interface SpendTotal {
  cents: number
  currency: 'EUR' | 'PLN' | 'USD'
}

export interface TransactionItem {
  /** txn- + shortHash(verbatim line, 10) — the fu-/sd- id pattern. */
  id: string
  date: string // YYYY-MM-DD
  amountMinor: number
  currency: SpendTotal['currency']
  merchant: string
  note?: string
}

export interface MonthTransactions {
  items: TransactionItem[]
  /** Per-currency sums of `items`, sorted by currency code. */
  totals: { currency: SpendTotal['currency']; amountMinor: number }[]
}

// money part: `<amount> <PLN|EUR|USD>` | `zł <amount>` | `<amount> zł`
const LINE_RE =
  /^- (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\s*—\s*(.+?)\s*—\s*(?:(\d+(?:[.,]\d{1,2})?)\s(PLN|EUR|USD)|zł\s*(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s*zł)\s*\((.+)\)$/

/** "23,5" → 2350 — exact integer math, no float rounding. */
function toMinor(amount: string): number {
  const [major = '0', frac = ''] = amount.split(/[.,]/)
  return Number(major) * 100 + Number((frac + '00').slice(0, 2))
}

export function readMonthTransactions(
  financeDir: string,
  month: string,
  log: Logger,
): MonthTransactions | undefined {
  const raw = readTextIfExists(join(financeDir, `transactions-${month}.md`), log)
  if (raw === undefined) return undefined
  const items: TransactionItem[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- ')) continue
    const m = LINE_RE.exec(t)
    if (m === null) {
      log.warn('transaction line skipped: unrecognized format')
      continue
    }
    const [, date = '', merchant = '', codeAmt, code, prefixAmt, suffixAmt, note = ''] = m
    if (!date.startsWith(month)) {
      log.warn('transaction line skipped: date outside file month')
      continue
    }
    const amount = codeAmt ?? prefixAmt ?? suffixAmt ?? ''
    items.push({
      id: 'txn-' + shortHash(t, 10),
      date,
      amountMinor: toMinor(amount),
      currency: (code ?? 'PLN') as SpendTotal['currency'],
      merchant,
      ...(note === '' ? {} : { note }),
    })
  }
  const sums = new Map<SpendTotal['currency'], number>()
  for (const i of items) sums.set(i.currency, (sums.get(i.currency) ?? 0) + i.amountMinor)
  const totals = [...sums.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
  return { items, totals }
}

/** Month-to-date spend per currency for /api/documents (contract Money shape). */
export function readMonthSpend(financeDir: string, now: Date, log: Logger): SpendTotal[] | undefined {
  const month = readMonthTransactions(financeDir, toWarsawMonth(now), log)
  if (month === undefined) return undefined
  return month.totals.map(({ currency, amountMinor }) => ({ currency, cents: amountMinor }))
}
