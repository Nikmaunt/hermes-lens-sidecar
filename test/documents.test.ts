import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DocumentsResponse, TodaySummary } from '../contract/schemas/index'
import { createLogger } from '../src/lib/log.js'
import { readSubscriptions } from '../src/readers/vault.js'
import { readDocs } from '../src/readers/docs.js'
import { toWarsawDate } from '../src/lib/time.js'
import { buildEnv, fixturePath, type TestEnv } from './helpers/env'

let env: TestEnv

const silentLog = createLogger(() => {})

function warsawDatePlus(days: number): string {
  return toWarsawDate(new Date(Date.now() + days * 86_400_000))
}

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('subscriptions.md — live-data forms, byte-exact fixture', () => {
  // fixtures/live/subscriptions.md mirrors real-world formats byte for byte: currency
  // code as prefix, zł in both spellings, comma decimal separator, and NO
  // trailing newline on the last line.
  it('cloudbox line: EUR code prefix, no trailing newline', () => {
    const items = readSubscriptions(fixturePath('live', 'subscriptions.md'), silentLog)
    const cloudbox = items.find((i) => i.title === 'CloudBox VPS')
    expect(cloudbox).toMatchObject({
      amount: { cents: 500, currency: 'EUR' },
      billingPeriod: 'monthly',
      renewsOn: '2026-12-01',
      cancelBy: null,
      notes: null,
    })
  })

  it('zł prefix form: "zł 23.99/month"', () => {
    const items = readSubscriptions(fixturePath('live', 'subscriptions.md'), silentLog)
    expect(items.find((i) => i.title === 'Bookworm Plus')?.amount).toEqual({ cents: 2399, currency: 'PLN' })
  })

  it('zł suffix form with comma decimal: "23,50 zł/month"', () => {
    const items = readSubscriptions(fixturePath('live', 'subscriptions.md'), silentLog)
    expect(items.find((i) => i.title === 'Nimbus Mobile')?.amount).toEqual({ cents: 2350, currency: 'PLN' })
  })

  it('optional ", cancel by: YYYY-MM-DD" fills cancelBy (was hardcoded null)', () => {
    const items = readSubscriptions(fixturePath('live', 'subscriptions.md'), silentLog)
    expect(items.find((i) => i.title === 'Nimbus Mobile')?.cancelBy).toBe('2026-07-25')
    expect(items.find((i) => i.title === 'Bookworm Plus')?.cancelBy).toBeNull()
  })
})

describe('vault/docs/*.md → DocumentItems', () => {
  beforeAll(() => {
    mkdirSync(env.paths.docsDir, { recursive: true })
    writeFileSync(
      join(env.paths.docsDir, 'umowa-najmu.md'),
      `---\ntitle: Umowa najmu\nkind: contract\nprovider: Landlord sp. z o.o.\ncancel_by: ${warsawDatePlus(7)}\namount: "2400 PLN/month"\n---\n\nДоговор аренды квартиры.\n`,
      'utf8',
    )
    writeFileSync(
      join(env.paths.docsDir, 'oc-samochod.md'),
      `---\ntitle: OC на машину\nkind: insurance\nprovider: PZU\nvalid_until: ${warsawDatePlus(20)}\n---\n`,
      'utf8',
    )
    writeFileSync(
      join(env.paths.docsDir, 'passport.md'),
      '---\ntitle: Passport\nkind: id-document\nvalid_until: 2031-03-09\n---\n',
      'utf8',
    )
    // torn frontmatter → skipped; junk kind → falls back to contract
    writeFileSync(join(env.paths.docsDir, 'torn.md'), '---\ntitle: Torn\nkind: contract\n', 'utf8')
    writeFileSync(
      join(env.paths.docsDir, 'strannyy.md'),
      '---\ntitle: Странный\nkind: чушь\n---\n',
      'utf8',
    )
  })

  it('parses kinds, provider, dates; valid_until maps to renewsOn', () => {
    const docs = readDocs(env.paths.docsDir, silentLog)
    expect(docs.find((d) => d.id === 'doc-umowa-najmu')).toMatchObject({
      title: 'Umowa najmu',
      kind: 'contract',
      provider: 'Landlord sp. z o.o.',
      cancelBy: warsawDatePlus(7),
      renewsOn: null,
      amount: { cents: 240000, currency: 'PLN' },
      billingPeriod: 'monthly',
    })
    expect(docs.find((d) => d.id === 'doc-oc-samochod')).toMatchObject({
      kind: 'insurance',
      provider: 'PZU',
      renewsOn: warsawDatePlus(20),
      cancelBy: null,
      amount: null,
    })
    expect(docs.find((d) => d.id === 'doc-passport')?.kind).toBe('id-document')
  })

  it('torn file skipped; unknown kind degrades to contract', () => {
    const docs = readDocs(env.paths.docsDir, silentLog)
    expect(docs.find((d) => d.id === 'doc-torn')).toBeUndefined()
    expect(docs.find((d) => d.id === 'doc-strannyy')?.kind).toBe('contract')
  })

  it('/api/documents merges docs with subscriptions; monthlyTotal spans currencies', async () => {
    const d = DocumentsResponse.parse((await env.get('/api/documents')).json)
    const ids = d.items.map((i) => i.id)
    expect(ids).toContain('doc-umowa-najmu')
    expect(ids.some((i) => i.startsWith('sub-'))).toBe(true)
    // Spotify 17.99$/mo + Proton 79.99$/yr (existing) + rent 2400 PLN/mo
    expect(d.monthlyTotal).toContainEqual({ currency: 'PLN', cents: 240000 })
    expect(d.monthlyTotal).toContainEqual({ currency: 'USD', cents: 1799 + Math.round(7999 / 12) })
  })

  it('cancel_by / valid_until feed /api/today deadlines with existing kind "document"', async () => {
    const t = TodaySummary.parse((await env.get('/api/today')).json)
    const cancel = t.deadlines.find((x) => x.id === 'doc-umowa-najmu-cancel')
    expect(cancel).toMatchObject({ kind: 'document', date: warsawDatePlus(7) })
    expect(cancel?.title).toContain('Umowa najmu')
    const renew = t.deadlines.find((x) => x.id === 'doc-oc-samochod-renew')
    expect(renew).toMatchObject({ kind: 'document', date: warsawDatePlus(20) })
    // the passport expires in 2031 — outside the 30-day window
    expect(t.deadlines.find((x) => x.id.startsWith('doc-passport'))).toBeUndefined()
    // deadlines remain sorted soonest-first
    const days = t.deadlines.map((x) => x.daysLeft)
    expect([...days].sort((a, b) => a - b)).toEqual(days)
  })
})
