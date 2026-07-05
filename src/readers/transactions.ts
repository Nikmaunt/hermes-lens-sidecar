import { join } from 'node:path'
import { readTextIfExists } from '../lib/fsread.js'
import { toWarsawMonth } from '../lib/time.js'
import type { Logger } from '../lib/log.js'

/**
 * vault/finance/transactions-YYYY-MM.md lines:
 *   `- YYYY-MM-DD HH:MM — <продавец> — <сумма> <PLN|EUR|USD> (<источник>)`
 * Month-to-date spend per currency, in integer cents (contract Money).
 * Returns undefined when the current month's file does not exist — the
 * caller then omits spentThisMonth entirely (field presence == source
 * presence). Lines dated outside the file's month are junk and skipped.
 */

export interface SpendTotal {
  cents: number
  currency: 'EUR' | 'PLN' | 'USD'
}

const LINE_RE =
  /^- (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\s*—\s*.+?\s*—\s*(\d+(?:[.,]\d{1,2})?)\s(PLN|EUR|USD)\s*\(.+\)$/

export function readMonthSpend(financeDir: string, now: Date, log: Logger): SpendTotal[] | undefined {
  const month = toWarsawMonth(now)
  const raw = readTextIfExists(join(financeDir, `transactions-${month}.md`), log)
  if (raw === undefined) return undefined
  const totals = new Map<SpendTotal['currency'], number>()
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- ')) continue
    const m = LINE_RE.exec(t)
    if (m === null) {
      log.warn('transaction line skipped: unrecognized format')
      continue
    }
    if (!(m[1] ?? '').startsWith(month)) {
      log.warn('transaction line skipped: date outside file month')
      continue
    }
    const amount = Number((m[2] ?? '').replace(',', '.'))
    const currency = m[3] as SpendTotal['currency']
    if (!Number.isFinite(amount)) continue
    totals.set(currency, (totals.get(currency) ?? 0) + Math.round(amount * 100))
  }
  return [...totals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, cents]) => ({ currency, cents }))
}
