import { readTextIfExists } from '../lib/fsread.js'
import { translitSlug } from '../lib/translit.js'
import type { Logger } from '../lib/log.js'

/**
 * habits.md — one block per habit:
 *   ## <Название>
 *   - icon: <эмодзи>
 *   - начал: YYYY-MM-DD
 *   - отметки: <даты через запятую>
 * id = hab-<translit slug of the name> — deterministic and stable across
 * edits of the other fields. Tolerant: invalid отметки dates drop, missing
 * начал falls back to the earliest отметка, a habit with neither is skipped
 * (the contract requires startedOn).
 */

export interface HabitOut {
  id: string
  name: string
  icon: string
  startedOn: string
  completedDates: string[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface HabitDraft {
  name: string
  icon: string
  startedOn: string | null
  dates: Set<string>
}

export function readHabits(path: string, log: Logger): HabitOut[] {
  const raw = readTextIfExists(path, log)
  if (raw === undefined) return []
  const drafts: HabitDraft[] = []
  let current: HabitDraft | null = null

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('## ')) {
      const name = t.slice(3).trim()
      if (name === '') {
        current = null
        continue
      }
      current = { name, icon: '', startedOn: null, dates: new Set() }
      drafts.push(current)
      continue
    }
    if (current === null || !t.startsWith('- ')) continue
    const bullet = /^-\s+([^:]+):\s*(.*)$/.exec(t)
    if (bullet === null) continue
    const key = (bullet[1] ?? '').trim().toLowerCase()
    const value = (bullet[2] ?? '').trim()
    if (key === 'icon') {
      current.icon = value
    } else if (key === 'начал') {
      current.startedOn = DATE_RE.test(value) ? value : null
    } else if (key === 'отметки') {
      for (const part of value.split(',')) {
        const d = part.trim()
        if (DATE_RE.test(d)) current.dates.add(d)
        else if (d !== '') log.warn('habit tick date skipped: not a date')
      }
    }
  }

  const out: HabitOut[] = []
  for (const d of drafts) {
    const completedDates = [...d.dates].sort()
    const startedOn = d.startedOn ?? completedDates[0]
    if (startedOn === undefined) {
      log.warn('habit skipped: no начал and no valid отметки', { name: translitSlug(d.name, 40) })
      continue
    }
    out.push({
      id: 'hab-' + translitSlug(d.name, 40),
      name: d.name,
      icon: d.icon,
      startedOn,
      completedDates,
    })
  }
  return out
}
