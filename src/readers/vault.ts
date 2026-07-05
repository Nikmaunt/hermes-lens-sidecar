import { listFiles, readTextIfExists } from '../lib/fsread.js'
import { shortHash } from '../lib/hash.js'
import { firstString, parseNote, stripTriageMarkers } from '../lib/markdown.js'
import { translitSlug } from '../lib/translit.js'
import { daysUntil, toWarsawIso } from '../lib/time.js'
import type { Logger } from '../lib/log.js'

/* ------------------------------- follow-ups ------------------------------ */

export interface FollowUpOut {
  id: string
  title: string
  dueDate: string | null
  source: string
  urgency: 'overdue' | 'today' | 'soon'
}

/**
 * followups.md lines, per the agent's vault-automation SKILL.md:
 *   `- [ ] [[YYYY-MM-DD]] — <description> (from [[NoteName]])`
 * Checked boxes are done and skipped; lines that open a checkbox but don't
 * match the format are skipped with a warning (tolerant parser).
 */
export function readFollowups(path: string, now: Date, log: Logger): FollowUpOut[] {
  const raw = readTextIfExists(path, log)
  if (raw === undefined) return []
  const out: FollowUpOut[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- [')) continue
    if (/^- \[[xX]\]/.test(t)) continue // done
    const m = /^- \[ \] \[\[(\d{4}-\d{2}-\d{2})\]\]\s*[—-]\s*(.+)$/.exec(t)
    if (m === null) {
      log.warn('followup line skipped: unrecognized format')
      continue
    }
    const dueDate = m[1] ?? ''
    let title = (m[2] ?? '').trim()
    let source = ''
    const from = /\(from \[\[(.+?)\]\]\)\s*$/.exec(title)
    if (from !== null) {
      source = from[1] ?? ''
      title = title.slice(0, from.index).trim()
    }
    const days = daysUntil(dueDate, now)
    out.push({
      id: 'fu-' + shortHash(t, 10),
      title,
      dueDate,
      source,
      urgency: days < 0 ? 'overdue' : days === 0 ? 'today' : 'soon',
    })
  }
  return out
}

/* ----------------------------- subscriptions ----------------------------- */

export interface DocumentItemOut {
  id: string
  title: string
  kind: 'contract' | 'subscription' | 'insurance' | 'id-document'
  provider: string
  amount: { cents: number; currency: 'EUR' | 'PLN' | 'USD' } | null
  billingPeriod: 'monthly' | 'yearly' | null
  renewsOn: string | null
  cancelBy: string | null
  notes: string | null
}

const CURRENCY: Record<string, 'EUR' | 'PLN' | 'USD'> = {
  $: 'USD',
  USD: 'USD',
  '€': 'EUR',
  EUR: 'EUR',
  zł: 'PLN',
  PLN: 'PLN',
}

/**
 * subscriptions.md lines, per SKILL.md:
 *   `- **Service Name** — renews: YYYY-MM-DD, $amount/period (from [[NoteName]])`
 * The file is empty today (EMPTY-VALID endpoint) but the parser is live from
 * day one so entries appear the moment the agent writes the first line.
 */
export function readSubscriptions(path: string, log: Logger): DocumentItemOut[] {
  const raw = readTextIfExists(path, log)
  if (raw === undefined) return []
  const out: DocumentItemOut[] = []
  const re =
    /^- \*\*(.+?)\*\*\s*[—-]\s*renews:\s*(\d{4}-\d{2}-\d{2}),\s*(\$|€|zł|PLN|USD|EUR)\s?([\d]+(?:[.,]\d{1,2})?)\/(\w+)(?:\s*\(from \[\[(.+?)\]\]\))?\s*$/
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- ')) continue
    const m = re.exec(t)
    if (m === null) {
      log.warn('subscription line skipped: unrecognized format')
      continue
    }
    const name = m[1] ?? ''
    const currency = CURRENCY[m[3] ?? '']
    const amountNum = Number((m[4] ?? '').replace(',', '.'))
    const periodWord = (m[5] ?? '').toLowerCase()
    const billingPeriod = /^(month|mo|monthly|месяц)/.test(periodWord)
      ? ('monthly' as const)
      : /^(year|yr|annual|год)/.test(periodWord)
        ? ('yearly' as const)
        : null
    out.push({
      id: 'sub-' + translitSlug(name, 40),
      title: name,
      kind: 'subscription',
      provider: name,
      amount:
        currency !== undefined && Number.isFinite(amountNum)
          ? { cents: Math.round(amountNum * 100), currency }
          : null,
      billingPeriod,
      renewsOn: m[2] ?? null,
      cancelBy: null,
      notes: m[6] !== undefined ? `from ${m[6]}` : null,
    })
  }
  return out
}

/* -------------------------------- people --------------------------------- */

export interface PersonOut {
  id: string
  name: string
  relation: string
  context: string
  preferredLanguage: string
  agreements: never[]
  lastInteraction: null
}

/**
 * vault/people/*.md notes grouped by frontmatter `person`. The vault carries
 * no relation/agreements/interaction structure yet, so those fields are
 * served empty (PARTIAL endpoint — additive evolution fills them in later).
 * Context = first paragraph of the newest note about that person.
 */
export function readPeople(peopleDir: string, log: Logger): PersonOut[] {
  const byPerson = new Map<string, { mtimeMs: number; context: string }>()
  for (const f of listFiles(peopleDir, log)) {
    if (!f.name.endsWith('.md') || f.name.startsWith('.')) continue
    const raw = readTextIfExists(f.path, log)
    if (raw === undefined) continue
    const parsed = parseNote(raw)
    if (!parsed.ok) {
      log.warn('people note skipped: unterminated frontmatter', { file: f.name })
      continue
    }
    const person = firstString(parsed.frontmatter.person)
    if (person === undefined || person.trim() === '') {
      log.warn('people note skipped: no person frontmatter', { file: f.name })
      continue
    }
    const name = person.trim()
    const text = stripTriageMarkers(parsed.body)
    const firstParagraph = (text.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    const existing = byPerson.get(name)
    if (existing === undefined || f.mtimeMs > existing.mtimeMs) {
      byPerson.set(name, { mtimeMs: f.mtimeMs, context: firstParagraph })
    }
  }
  return [...byPerson.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, v]) => ({
      id: 'person-' + translitSlug(name, 40),
      name,
      relation: '',
      context: v.context,
      preferredLanguage: '',
      agreements: [],
      lastInteraction: null,
    }))
}

/* ----------------------- inbox capture events (timeline) ----------------- */

export interface InboxFileEvent {
  id: string
  at: string
  slug: string
}

export function inboxFileEvents(inboxDir: string, log: Logger): InboxFileEvent[] {
  return listFiles(inboxDir, log)
    .filter((f) => f.name.endsWith('.md') && !f.name.startsWith('.'))
    .map((f) => {
      const slug = f.name.replace(/\.md$/, '')
      return { id: `note-${slug}`, at: toWarsawIso(new Date(f.mtimeMs)), slug }
    })
}
