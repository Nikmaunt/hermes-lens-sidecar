import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/lib/log.js'
import { daysUntil, toWarsawDate, toWarsawIso, warsawHhmm } from '../src/lib/time.js'
import { translitSlug } from '../src/lib/translit.js'
import { parseNote, stripTriageMarkers } from '../src/lib/markdown.js'
import { readFollowups, readSubscriptions } from '../src/readers/vault.js'
import { fixturePath } from './helpers/env'
import { readFileSync } from 'node:fs'

const NOW = new Date('2026-07-05T12:00:00+02:00')

function collectingLogger(): { log: ReturnType<typeof createLogger>; lines: string[] } {
  const lines: string[] = []
  return { log: createLogger((l) => lines.push(l)), lines }
}

describe('Warsaw time', () => {
  it('formats with the correct seasonal offset', () => {
    expect(toWarsawIso(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01-15T13:00:00+01:00')
    expect(toWarsawIso(new Date('2026-07-05T12:00:00Z'))).toBe('2026-07-05T14:00:00+02:00')
  })
  it('computes Warsaw calendar dates across UTC midnight', () => {
    // 23:30 UTC on the 4th is already the 5th in Warsaw (summer, +02:00)
    expect(toWarsawDate(new Date('2026-07-04T23:30:00Z'))).toBe('2026-07-05')
    expect(warsawHhmm(new Date('2026-07-04T23:30:00Z'))).toBe('0130')
  })
  it('daysUntil is calendar-day based', () => {
    expect(daysUntil('2026-07-05', NOW)).toBe(0)
    expect(daysUntil('2026-07-06', NOW)).toBe(1)
    expect(daysUntil('2026-07-04', NOW)).toBe(-1)
  })
})

describe('transliterated slugs', () => {
  it('handles Cyrillic, ё, and Polish diacritics', () => {
    expect(translitSlug('Позвонить в банк насчёт лимита')).toBe('pozvonit-v-bank-naschyot-limita')
    expect(translitSlug('zniżka — скидка!')).toBe('znizka-skidka')
    expect(translitSlug('!!!')).toBe('note')
  })
})

describe('note parsing (agent format)', () => {
  it('parses frontmatter and strips triage markers from the fixture note', () => {
    const raw = readFileSync(fixturePath('vault', 'inbox', 'pozvonit-v-bank-0930.md'), 'utf8')
    const note = parseNote(raw)
    expect(note.ok).toBe(true)
    expect(note.frontmatter.category).toBe('finance')
    expect(note.frontmatter.person).toBe('Олег')
    expect(note.frontmatter.criticality).toBe('high')
    const text = stripTriageMarkers(note.body)
    expect(text).toContain('Позвонить в банк')
    expect(text).not.toContain('needs-review')
    expect(text).not.toContain('Не уверен')
  })
  it('flags unterminated frontmatter as not-ok (torn write)', () => {
    const raw = readFileSync(fixturePath('broken', 'inbox-torn-frontmatter.md'), 'utf8')
    expect(parseNote(raw).ok).toBe(false)
  })
})

describe('followups.md parser', () => {
  it('parses urgency/source per SKILL.md format, skips checked and broken lines', () => {
    const { log, lines } = collectingLogger()
    const items = readFollowups(fixturePath('vault', 'followups.md'), NOW, log)
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.urgency)).toEqual(['overdue', 'today', 'soon'])
    expect(items[0]).toMatchObject({
      title: 'ответить Олегу про маршрут, критично',
      dueDate: '2026-07-01',
      source: 'vstrecha-s-olegom',
    })
    expect(items[2]?.source).toBe('')
    expect(lines.filter((l) => l.includes('followup line skipped'))).toHaveLength(1)
  })
})

describe('subscriptions.md parser', () => {
  it('parses amount/period/notes per SKILL.md format, skips broken lines', () => {
    const { log, lines } = collectingLogger()
    const items = readSubscriptions(fixturePath('vault', 'subscriptions.md'), log)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: 'Spotify Family',
      kind: 'subscription',
      amount: { cents: 1799, currency: 'USD' },
      billingPeriod: 'monthly',
      renewsOn: '2026-07-15',
      notes: 'from podpiski',
    })
    expect(items[1]).toMatchObject({
      amount: { cents: 7999, currency: 'USD' },
      billingPeriod: 'yearly',
    })
    expect(lines.filter((l) => l.includes('subscription line skipped'))).toHaveLength(1)
  })
})
