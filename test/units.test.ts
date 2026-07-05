import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/lib/log.js'
import { daysUntil, toWarsawDate, toWarsawIso, warsawHhmm } from '../src/lib/time.js'
import { translitSlug } from '../src/lib/translit.js'
import { flattenInlineMarkdown, parseNote, stripTriageMarkers } from '../src/lib/markdown.js'
import { readFollowups, readSubscriptions } from '../src/readers/vault.js'
import { collectEvents } from '../src/domain/timeline.js'
import type { SessionRow } from '../src/readers/statedb.js'
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
  it('finds the frontmatter fence behind a leading triage comment (real agent layout)', () => {
    const raw = readFileSync(fixturePath('vault', 'inbox', 'osmotr-kotla-1900.md'), 'utf8')
    const note = parseNote(raw)
    expect(note.ok).toBe(true)
    expect(note.frontmatter.criticality).toBe('high')
    expect(note.frontmatter.category).toBe('appointment')
    expect(note.frontmatter.time).toBe('19:00')
    expect(note.body).not.toContain('---')
    expect(note.body).not.toContain('criticality')

    const text = flattenInlineMarkdown(stripTriageMarkers(note.body))
    expect(text.startsWith('Осмотр котла')).toBe(true)
    expect(text).toContain('Дата: вторник, 7 июля 2026 г., 19:00')
    expect(text).toContain('котельная в подвале') // wikilink alias kept as words
    expect(text).not.toMatch(/[#*[\]]/)
  })
})

describe('markdown flattening', () => {
  it('drops ATX marks and emphasis, keeps line breaks and list markers', () => {
    expect(flattenInlineMarkdown('## Заголовок\n**жирный** и *курсив*\n* пункт списка\n[[note|слово]]')).toBe(
      'Заголовок\nжирный и курсив\n* пункт списка\nслово',
    )
  })
})

describe('timeline session presentation', () => {
  const session = (over: Partial<SessionRow>): SessionRow => ({
    id: 'x',
    source: 'cron',
    title: null,
    startedAtMs: Date.UTC(2026, 6, 5, 5, 1),
    endedAtMs: Date.UTC(2026, 6, 5, 5, 2),
    messageCount: 25,
    toolCallCount: 15,
    costUsd: 0,
    ...over,
  })
  const only = (s: SessionRow) =>
    collectEvents({ sessions: [s], inboxFiles: [], backupFiles: [], journal: [] })[0]

  it('strips the trailing date and humanizes known cron names', () => {
    expect(only(session({ title: 'reminders-recompute · Jul 05 07:01' }))?.title).toBe(
      'Пересчёт напоминаний',
    )
    expect(only(session({ title: 'inbox-triage · Jul 05' }))?.title).toBe('Разбор инбокса')
    expect(only(session({ title: 'reminders-escalate' }))?.title).toBe('Проверка критичных напоминаний')
    expect(only(session({ title: 'nightly-backup · 2026-07-05 03:00' }))?.title).toBe('Ночной бэкап')
    expect(only(session({ title: 'weekly-review · Jul 05 06:00' }))?.title).toBe('weekly-review') // fallback: raw name
  })
  it('leaves human titles untouched and calms the meta line', () => {
    const chat = only(session({ source: 'telegram', title: 'Обсуждение бюджета поездки', messageCount: 21 }))
    expect(chat?.title).toBe('Обсуждение бюджета поездки')
    expect(chat?.detail).toBe('telegram · 21 сообщение')
    expect(only(session({}))?.detail).toBe('автозадача · 15 шагов')
    expect(only(session({ toolCallCount: 3 }))?.detail).toBe('автозадача · 3 шага')
    expect(only(session({}))?.title).toBe('Cron run') // null title fallback survives
  })
})

describe('followups.md parser', () => {
  it('parses urgency/source per SKILL.md format, skips checked and broken lines', () => {
    const { log, lines } = collectingLogger()
    const items = readFollowups(fixturePath('vault', 'followups.md'), NOW, log)
    expect(items).toHaveLength(4)
    expect(items.map((i) => i.urgency)).toEqual(['overdue', 'today', 'soon', 'soon'])
    expect(items[0]).toMatchObject({
      title: 'ответить Олегу про маршрут', // trailing «, критично» stripped
      dueDate: '2026-07-01',
      source: 'vstrecha-s-olegom',
    })
    expect(items[2]).toMatchObject({
      title: 'Осмотр котла, 19:00', // criticality gone, the time kept
      source: 'osmotr-kotla',
    })
    expect(items[3]?.source).toBe('')
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
