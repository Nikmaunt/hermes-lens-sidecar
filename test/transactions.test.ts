import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DocumentsResponse } from '../contract/schemas/index'
import { toWarsawDate, toWarsawMonth } from '../src/lib/time.js'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * vault/finance/transactions-YYYY-MM.md → optional spentThisMonth on
 * /api/documents. Field PRESENT (possibly empty) iff the current month's
 * file exists — presence mirrors the source, absence means "no data yet".
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
