import { parseIsoMs, toWarsawIso } from '../lib/time.js'
import type { SessionRow } from '../readers/statedb.js'
import type { InboxFileEvent } from '../readers/vault.js'
import type { JournalRecord } from '../writes/journal.js'
import type { FileEntry } from '../lib/fsread.js'

export type EventCategoryOut =
  | 'agent'
  | 'memory'
  | 'capture'
  | 'habit'
  | 'document'
  | 'project'
  | 'people'
  | 'system'

export interface TimelineEventOut {
  id: string
  at: string
  category: EventCategoryOut
  title: string
  detail: string | null
  relatedId: string | null
}

export const TIMELINE_PAGE_SIZE = 25

const BACKUP_NAME_RE = /^(?:state|vault)-\d{4}-\d{2}-\d{2}\.(?:db|tar\.gz)$/

/**
 * The agent titles cron sessions like `reminders-recompute · Jul 05 07:01` —
 * log flavor the app shouldn't render. The event already carries `at`, so
 * the trailing ` · <date>` is dropped, and known cron job names map to human
 * labels (fallback: the raw name). Already-human titles (e.g. Telegram
 * sessions) pass through untouched.
 */
const TITLE_DATE_TAIL_RE =
  /\s*·\s*(?:[A-Z][a-z]{2}\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+\d{1,2}:\d{2})?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)\s*$/

const CRON_LABELS: Record<string, string> = {
  'inbox-triage': 'Разбор инбокса',
  'reminders-recompute': 'Пересчёт напоминаний',
  'reminders-escalate': 'Проверка критичных напоминаний',
  'nightly-backup': 'Ночной бэкап',
}

function sessionTitle(s: SessionRow): string {
  const title = s.title === null ? '' : s.title.replace(TITLE_DATE_TAIL_RE, '').trim()
  if (title === '') return s.source === 'cron' ? 'Cron run' : 'Agent session'
  if (s.source === 'cron') return CRON_LABELS[title] ?? title
  return title
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function sessionDetail(s: SessionRow): string {
  if (s.source === 'cron') {
    return `автозадача · ${s.toolCallCount} ${ruPlural(s.toolCallCount, 'шаг', 'шага', 'шагов')}`
  }
  return `${s.source} · ${s.messageCount} ${ruPlural(s.messageCount, 'сообщение', 'сообщения', 'сообщений')}`
}

/**
 * Merge all v1 event sources, newest first. PARTIAL endpoint: memory /
 * habit / document / people events don't exist yet — additive evolution
 * adds them later without breaking the contract.
 */
export function collectEvents(input: {
  sessions: SessionRow[]
  inboxFiles: InboxFileEvent[]
  backupFiles: FileEntry[]
  journal: JournalRecord[]
}): TimelineEventOut[] {
  const byId = new Map<string, TimelineEventOut>()

  for (const s of input.sessions) {
    byId.set(`sess-${s.id}`, {
      id: `sess-${s.id}`,
      at: toWarsawIso(new Date(s.endedAtMs ?? s.startedAtMs)),
      category: 'agent', // both chat and cron sessions are agent activity
      title: sessionTitle(s),
      detail: sessionDetail(s),
      relatedId: null,
    })
  }

  for (const f of input.backupFiles) {
    if (!BACKUP_NAME_RE.test(f.name)) continue
    byId.set(`backup-${f.name}`, {
      id: `backup-${f.name}`,
      at: toWarsawIso(new Date(f.mtimeMs)),
      category: 'system',
      title: 'Backup written',
      detail: `${f.name} · ${f.size} bytes`,
      relatedId: null,
    })
  }

  // Journal first, then live inbox files: a note that still exists in the
  // inbox overrides the journal's capture record for the same slug.
  for (const j of input.journal) {
    const id = j.type === 'capture' && j.relatedId !== null ? `note-${j.relatedId}` : j.id
    byId.set(id, {
      id,
      at: j.at,
      category: j.type === 'capture' ? 'capture' : j.type === 'habit-tick' ? 'habit' : 'system',
      title: j.title,
      detail: j.detail,
      relatedId: j.relatedId,
    })
  }

  for (const n of input.inboxFiles) {
    byId.set(n.id, {
      id: n.id,
      at: n.at,
      category: 'capture',
      title: 'Note captured',
      detail: n.slug,
      relatedId: n.slug,
    })
  }

  return [...byId.values()].sort((a, b) => (parseIsoMs(b.at) ?? 0) - (parseIsoMs(a.at) ?? 0))
}

export function paginate(
  events: TimelineEventOut[],
  params: { category?: string; before?: string },
): { events: TimelineEventOut[]; nextBefore: string | null } {
  let filtered = events
  if (params.category !== undefined) {
    filtered = filtered.filter((e) => e.category === params.category)
  }
  if (params.before !== undefined) {
    const cutoff = parseIsoMs(params.before)
    if (cutoff !== null) filtered = filtered.filter((e) => (parseIsoMs(e.at) ?? 0) < cutoff)
  }
  const page = filtered.slice(0, TIMELINE_PAGE_SIZE)
  const last = page.at(-1)
  return {
    events: page,
    nextBefore: filtered.length > TIMELINE_PAGE_SIZE && last !== undefined ? last.at : null,
  }
}
