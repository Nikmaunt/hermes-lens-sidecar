import { readJsonTolerant } from '../lib/fsread.js'
import { sha256Hex } from '../lib/hash.js'
import { hasUtcOffset, parseIsoMs } from '../lib/time.js'
import type { Logger } from '../lib/log.js'

/**
 * vault/system/reminders.json → /api/reminders.
 * Source shape (regenerated daily by the agent's cron):
 *   { generated_at, timezone, reminders: [{ id, title, datetime,
 *     criticality, source, category }] }
 * Field mapping: datetime→dueAt, criticality==="high"→critical,
 * source→sourceRef, category→notes; leadTimeMinutes intentionally omitted.
 */

export interface ReminderOut {
  id: string
  title: string
  dueAt: string
  notes?: string
  critical: boolean
  sourceRef?: string
}

export interface RemindersOut {
  items: ReminderOut[]
  revision: string
}

export async function readReminders(path: string, log: Logger): Promise<RemindersOut> {
  const json = await readJsonTolerant(path, log)
  const items: ReminderOut[] = []
  const list =
    typeof json === 'object' && json !== null && Array.isArray((json as Record<string, unknown>).reminders)
      ? ((json as Record<string, unknown>).reminders as unknown[])
      : []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || r.id === '' || typeof r.title !== 'string' || r.title === '') {
      log.warn('reminder skipped: missing id/title')
      continue
    }
    if (typeof r.datetime !== 'string' || parseIsoMs(r.datetime) === null || !hasUtcOffset(r.datetime)) {
      // naive or unparseable datetime — the phone must never guess a zone
      log.warn('reminder skipped: bad datetime', { id: r.id })
      continue
    }
    const item: ReminderOut = {
      id: r.id,
      title: r.title,
      dueAt: r.datetime,
      critical: r.criticality === 'high',
    }
    if (typeof r.category === 'string' && r.category !== '') item.notes = r.category
    if (typeof r.source === 'string' && r.source !== '') item.sourceRef = r.source
    items.push(item)
  }

  // Revision = hash of the canonical items only. The agent rewrites the file
  // (new generated_at) every morning even when nothing changed; the revision
  // must move only when the items themselves do.
  const canonical = JSON.stringify(
    [...items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => [i.id, i.title, i.dueAt, i.notes ?? '', i.critical, i.sourceRef ?? '']),
  )
  return { items, revision: 'rev-' + sha256Hex(canonical).slice(0, 16) }
}
