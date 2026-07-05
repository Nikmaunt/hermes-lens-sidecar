import { readTextIfExists } from '../lib/fsread.js'
import type { Logger } from '../lib/log.js'
import type { Writer } from './fswrite.js'

/**
 * Append-only journal (sidecar's own data dir) of every write the sidecar
 * performed. Feeds sidecar-performed capture/triage/flag/ack events into
 * /api/timeline. Never contains note text or tokens — only slugs/ids.
 */

const JOURNAL_TYPES = [
  'capture',
  'triage',
  'flag',
  'ack',
  'followup-action',
  'followup-undo',
  'habit-tick',
] as const

export interface JournalEntry {
  type: (typeof JOURNAL_TYPES)[number]
  at: string
  title: string
  detail: string | null
  relatedId: string | null
}

export interface JournalRecord extends JournalEntry {
  /** Stable id derived from the line position in the append-only file. */
  id: string
}

export function appendJournal(writer: Writer, journalPath: string, entry: JournalEntry): void {
  writer.appendLine(journalPath, JSON.stringify(entry))
}

export function readJournal(journalPath: string, log: Logger): JournalRecord[] {
  const raw = readTextIfExists(journalPath)
  if (raw === undefined) return []
  const out: JournalRecord[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    try {
      const e = JSON.parse(line) as Record<string, unknown>
      const type = JOURNAL_TYPES.find((t) => t === e.type)
      if (type !== undefined && typeof e.at === 'string' && typeof e.title === 'string') {
        out.push({
          id: `jrnl-${i}`,
          type,
          at: e.at,
          title: e.title,
          detail: typeof e.detail === 'string' ? e.detail : null,
          relatedId: typeof e.relatedId === 'string' ? e.relatedId : null,
        })
      }
    } catch {
      log.warn('malformed journal line skipped', { line: i })
    }
  }
  return out
}
