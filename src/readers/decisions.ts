import { readTextIfExists } from '../lib/fsread.js'
import { shortHash } from '../lib/hash.js'
import type { Logger } from '../lib/log.js'

/**
 * decisions.md — decision log blocks:
 *   ## YYYY-MM-DD — <решение>
 *   - контекст: …
 *   - почему: …
 *   - альтернативы: a; b
 *   - пересмотреть: YYYY-MM-DD   (optional)
 *   - проект: <слаг>             (optional)
 * Missing bullets degrade to empty strings / [] / null per the contract
 * schema; a heading without a valid date drops the whole block (tolerant).
 * id = dec-<sha256/10 of the heading line> — stable while the heading is.
 */

export interface DecisionOut {
  id: string
  title: string
  decidedOn: string
  context: string
  reasoning: string
  alternatives: string[]
  projectId: string | null
  revisitBy: string | null
}

const HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/
const BULLET_RE = /^-\s+([^:]+):\s*(.*)$/

export function readDecisions(path: string, log: Logger): DecisionOut[] {
  const raw = readTextIfExists(path, log)
  if (raw === undefined) return []
  const out: DecisionOut[] = []
  let current: DecisionOut | null = null

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('## ')) {
      const m = HEADING_RE.exec(t)
      if (m === null) {
        log.warn('decision block skipped: heading has no date')
        current = null // bullets under a broken heading are dropped too
        continue
      }
      current = {
        id: 'dec-' + shortHash(t, 10),
        title: (m[2] ?? '').trim(),
        decidedOn: m[1] ?? '',
        context: '',
        reasoning: '',
        alternatives: [],
        projectId: null,
        revisitBy: null,
      }
      out.push(current)
      continue
    }
    if (current === null || !t.startsWith('- ')) continue
    const bullet = BULLET_RE.exec(t)
    if (bullet === null) continue
    const key = (bullet[1] ?? '').trim().toLowerCase()
    const value = (bullet[2] ?? '').trim()
    switch (key) {
      case 'контекст':
        current.context = value
        break
      case 'почему':
        current.reasoning = value
        break
      case 'альтернативы':
        current.alternatives = value
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s !== '')
        break
      case 'пересмотреть':
        current.revisitBy = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
        break
      case 'проект':
        current.projectId = value === '' ? null : value
        break
      default:
        break // unknown bullet — tolerated
    }
  }

  // Newest first; equal dates keep file order (stable sort).
  return out.sort((a, b) => b.decidedOn.localeCompare(a.decidedOn))
}
