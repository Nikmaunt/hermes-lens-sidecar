import { listFiles, readTextIfExists } from '../lib/fsread.js'
import { shortHash } from '../lib/hash.js'
import { firstString, parseNote, stripTriageMarkers } from '../lib/markdown.js'
import { translitSlug } from '../lib/translit.js'
import { daysUntil, toWarsawIso } from '../lib/time.js'
import type { Logger } from '../lib/log.js'

/* ------------------------------- follow-ups ------------------------------ */

export interface FollowUpPendingActionOut {
  action: 'done' | 'snooze' | 'someday'
  until?: string
  requestedAt: string
}

export interface FollowUpOut {
  id: string
  title: string
  dueDate: string | null
  source: string
  urgency: 'overdue' | 'today' | 'soon'
  /** Set while a done/snooze queue file awaits the agent (overlay). */
  pendingAction?: FollowUpPendingActionOut
}

/**
 * The agent appends criticality words to follow-up descriptions
 * («…, критично»). Criticality already reaches the app structurally
 * (urgency / reminder badges), so trailing markers are noise in a display
 * title. Strips punctuation-separated or parenthesized trailing markers,
 * repeatedly for stacked ones; never empties the title.
 */
const CRITICALITY_TAIL_RE =
  /(?:\s*[,;:—–-]+\s*|\s+[(（])(?:критично|важно|срочно|critical|important|urgent)[)）]?[\s.!]*$/i

function stripCriticalityTail(title: string): string {
  let t = title.trim()
  for (;;) {
    const m = CRITICALITY_TAIL_RE.exec(t)
    if (m === null || m.index === 0) return t
    t = t.slice(0, m.index).trimEnd()
  }
}

const FOLLOWUP_LINE_RE = /^- \[ \] \[\[(\d{4}-\d{2}-\d{2})\]\]\s*[—-]\s*(.+)$/

/**
 * Active followups.md lines keyed by their content-hash id (fu-<sha256/10>).
 * The verbatim line is what a followup-action queue file must carry — the
 * agent cannot recompute the hash, it matches by line text.
 */
export function readFollowupLines(path: string, log: Logger): Map<string, string> {
  const map = new Map<string, string>()
  const raw = readTextIfExists(path, log)
  if (raw === undefined) return map
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- [') || /^- \[[xX]\]/.test(t)) continue
    if (!FOLLOWUP_LINE_RE.test(t)) continue
    map.set('fu-' + shortHash(t, 10), t)
  }
  return map
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
    const m = FOLLOWUP_LINE_RE.exec(t)
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
    title = stripCriticalityTail(title)
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

// Live PLN/EUR data uses the currency token as prefix (`zł 23.99`,
// `EUR 5.00`) AND as suffix with a comma decimal (`23,50 zł`) — both forms
// must parse everywhere an amount appears.
const CUR_SRC = '\\$|€|zł|PLN|USD|EUR'
const NUM_SRC = '\\d+(?:[.,]\\d{1,2})?'
const AMOUNT_SRC = `(?:(${CUR_SRC})\\s?(${NUM_SRC})|(${NUM_SRC})\\s?(${CUR_SRC}))`

function parseBillingPeriod(word: string): 'monthly' | 'yearly' | null {
  const w = word.toLowerCase()
  if (/^(month|mo|monthly|месяц)/.test(w)) return 'monthly'
  if (/^(year|yr|annual|год)/.test(w)) return 'yearly'
  return null
}

function toMoney(
  currencyToken: string,
  amountStr: string,
): { cents: number; currency: 'EUR' | 'PLN' | 'USD' } | null {
  const currency = CURRENCY[currencyToken]
  const amountNum = Number(amountStr.replace(',', '.'))
  if (currency === undefined || !Number.isFinite(amountNum)) return null
  return { cents: Math.round(amountNum * 100), currency }
}

const AMOUNT_SPEC_RE = new RegExp(`^${AMOUNT_SRC}(?:\\s*\\/\\s*(\\w+))?$`)

/** Parse a standalone amount spec like "2400 PLN/month" or "EUR 5.00/month". */
export function parseAmountSpec(spec: string): {
  amount: { cents: number; currency: 'EUR' | 'PLN' | 'USD' } | null
  billingPeriod: 'monthly' | 'yearly' | null
} {
  const m = AMOUNT_SPEC_RE.exec(spec.trim())
  if (m === null) return { amount: null, billingPeriod: null }
  return {
    amount: toMoney(m[1] ?? m[4] ?? '', m[2] ?? m[3] ?? ''),
    billingPeriod: parseBillingPeriod(m[5] ?? ''),
  }
}

/**
 * subscriptions.md lines, per SKILL.md:
 *   `- **Service Name** — renews: YYYY-MM-DD[, cancel by: YYYY-MM-DD], $amount/period (from [[NoteName]])`
 * The `cancel by` group is optional and fills cancelBy when present.
 */
const SUBSCRIPTION_RE = new RegExp(
  '^- \\*\\*(.+?)\\*\\*\\s*[—-]\\s*renews:\\s*(\\d{4}-\\d{2}-\\d{2})' +
    '(?:,\\s*cancel by:\\s*(\\d{4}-\\d{2}-\\d{2}))?' +
    `,\\s*${AMOUNT_SRC}\\/(\\w+)` +
    '(?:\\s*\\(from \\[\\[(.+?)\\]\\]\\))?\\s*$',
)

export function readSubscriptions(path: string, log: Logger): DocumentItemOut[] {
  const raw = readTextIfExists(path, log)
  if (raw === undefined) return []
  const out: DocumentItemOut[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- ')) continue
    const m = SUBSCRIPTION_RE.exec(t)
    if (m === null) {
      log.warn('subscription line skipped: unrecognized format')
      continue
    }
    const name = m[1] ?? ''
    out.push({
      id: 'sub-' + translitSlug(name, 40),
      title: name,
      kind: 'subscription',
      provider: name,
      amount: toMoney(m[4] ?? m[7] ?? '', m[5] ?? m[6] ?? ''),
      billingPeriod: parseBillingPeriod(m[8] ?? ''),
      renewsOn: m[2] ?? null,
      cancelBy: m[3] ?? null,
      notes: m[9] !== undefined ? `from ${m[9]}` : null,
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
