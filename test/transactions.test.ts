import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DocumentsResponse } from '../contract/schemas/index'
import { TransactionsResponse } from '../src/contract-local/transactions'
import { shortHash } from '../src/lib/hash.js'
import { toWarsawDate, toWarsawMonth } from '../src/lib/time.js'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * vault/finance/transactions-YYYY-MM.md → optional spentThisMonth on
 * /api/documents (field PRESENT, possibly empty, iff the current month's
 * file exists — presence mirrors the source) AND GET /api/transactions
 * (itemized month view; missing file/dir → empty response, fail-open).
 * ONE parser serves both surfaces.
 */

let env: TestEnv
const today = toWarsawDate(new Date())
const month = toWarsawMonth(new Date())

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('spentThisMonth', () => {
  it('no transactions file for the current month → field absent', async () => {
    const r = await env.get('/api/documents')
    expect(r.status).toBe(200)
    const d = DocumentsResponse.parse(r.json)
    expect(d.spentThisMonth).toBeUndefined()
  })

  it('sums the month per currency in integer cents; junk and foreign-month lines skipped', async () => {
    mkdirSync(env.paths.financeDir, { recursive: true })
    writeFileSync(
      join(env.paths.financeDir, `transactions-${month}.md`),
      [
        `# Транзакции ${month}`,
        '',
        `- ${today} 09:15 — Żabka — 23,50 PLN (blik)`,
        `- ${today} 12:00 — Biedronka — 41.99 PLN (card)`,
        `- ${today} 13:05 — Steam — 5.00 EUR (card)`,
        '- вчера — киоск — сколько-то (нал)',
        '- 2020-01-01 10:00 — Чужой месяц — 99.99 USD (card)',
        '',
      ].join('\n'),
      'utf8',
    )
    const d = DocumentsResponse.parse((await env.get('/api/documents')).json)
    expect(d.spentThisMonth).toEqual([
      { currency: 'EUR', cents: 500 },
      { currency: 'PLN', cents: 2350 + 4199 },
    ])
  })

  it('file exists but holds no parsable lines → empty array, still 200', async () => {
    writeFileSync(join(env.paths.financeDir, `transactions-${month}.md`), 'мусор\n]]]\n', 'utf8')
    const d = DocumentsResponse.parse((await env.get('/api/documents')).json)
    expect(d.spentThisMonth).toEqual([])
  })
})

describe('GET /api/transactions', () => {
  // A fixed past month so nothing here races the current-month tests above.
  const FIXED = '2026-03'
  const FIXED_LINES = [
    '- 2026-03-05 09:15 — Żabka — zł 23.99 (blik)', // prefix-zł form
    '- 2026-03-06 12:40 — Biedronka — 23,50 zł (card)', // suffix-zł form
    '- 2026-03-07 18:02 — Allegro — 129,99 PLN (blik)', // legacy code form
    '- 2026-03-08 13:05 — Steam — 5.00 EUR (card)',
  ]

  it('401 without token', async () => {
    const r = await env.get('/api/transactions', null)
    expect(r.status).toBe(401)
  })

  it('itemizes the requested month: both zł forms, note kept, ids stable, file order', async () => {
    writeFileSync(
      join(env.paths.financeDir, `transactions-${FIXED}.md`),
      [
        `# Транзакции ${FIXED}`,
        '',
        ...FIXED_LINES,
        '- вчера — киоск — сколько-то (нал)', // junk → skip + warn
        '- 2020-01-01 10:00 — Чужой месяц — 99.99 USD (card)', // foreign month → skip
        '',
      ].join('\n'),
      'utf8',
    )
    const r = await env.get(`/api/transactions?month=${FIXED}`)
    expect(r.status).toBe(200)
    const body = TransactionsResponse.parse(r.json)
    expect(body.month).toBe(FIXED)
    expect(body.items).toEqual([
      { id: `txn-${shortHash(FIXED_LINES[0] ?? '', 10)}`, date: '2026-03-05', amountMinor: 2399, currency: 'PLN', merchant: 'Żabka', note: 'blik' },
      { id: `txn-${shortHash(FIXED_LINES[1] ?? '', 10)}`, date: '2026-03-06', amountMinor: 2350, currency: 'PLN', merchant: 'Biedronka', note: 'card' },
      { id: `txn-${shortHash(FIXED_LINES[2] ?? '', 10)}`, date: '2026-03-07', amountMinor: 12999, currency: 'PLN', merchant: 'Allegro', note: 'blik' },
      { id: `txn-${shortHash(FIXED_LINES[3] ?? '', 10)}`, date: '2026-03-08', amountMinor: 500, currency: 'EUR', merchant: 'Steam', note: 'card' },
    ])
    // totals are SEPARATE per currency — never a single combined number
    expect(body.totals).toEqual([
      { currency: 'EUR', amountMinor: 500 },
      { currency: 'PLN', amountMinor: 2399 + 2350 + 12999 },
    ])
    expect(env.logs.some((l) => l.includes('transaction line skipped'))).toBe(true)
  })

  it('month omitted → current Warsaw month', async () => {
    writeFileSync(
      join(env.paths.financeDir, `transactions-${month}.md`),
      `- ${today} 09:15 — Żabka — 23,50 PLN (blik)\n`,
      'utf8',
    )
    const body = TransactionsResponse.parse((await env.get('/api/transactions')).json)
    expect(body.month).toBe(month)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({ amountMinor: 2350, currency: 'PLN', merchant: 'Żabka' })
  })

  it('malformed month → 400', async () => {
    const r = await env.get('/api/transactions?month=03-2026')
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ error: 'invalid month' })
  })

  it('no file for the month → empty items and totals, still 200 (fail-open)', async () => {
    const body = TransactionsResponse.parse((await env.get('/api/transactions?month=1999-01')).json)
    expect(body).toMatchObject({ items: [], totals: [], month: '1999-01' })
  })

  it('finance dir absent entirely (fresh vault) → empty response, still 200', async () => {
    const fresh = await buildEnv()
    try {
      const r = await fresh.get('/api/transactions')
      expect(r.status).toBe(200)
      const body = TransactionsResponse.parse(r.json)
      expect(body.items).toEqual([])
      expect(body.totals).toEqual([])
    } finally {
      await fresh.close()
    }
  })
})

describe('spentThisMonth is fed by the SAME parser', () => {
  it('zł-form lines count into /api/documents spentThisMonth', async () => {
    writeFileSync(
      join(env.paths.financeDir, `transactions-${month}.md`),
      [`- ${today} 09:15 — Żabka — zł 10.00 (blik)`, `- ${today} 09:16 — Кофейня — 5,00 zł (cash)`, ''].join('\n'),
      'utf8',
    )
    const d = DocumentsResponse.parse((await env.get('/api/documents')).json)
    expect(d.spentThisMonth).toEqual([{ currency: 'PLN', cents: 1500 }])
  })
})
