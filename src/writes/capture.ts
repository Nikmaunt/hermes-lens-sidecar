import { readTextIfExists } from '../lib/fsread.js'
import { translitSlug } from '../lib/translit.js'
import { toWarsawDate, toWarsawIso, warsawHhmm, warsawTimeOfDay } from '../lib/time.js'
import { join } from 'node:path'
import type { Logger } from '../lib/log.js'
import type { Paths } from '../config.js'
import type { Writer } from './fswrite.js'
import { appendJournal } from './journal.js'

export interface CaptureResult {
  status: number
  body: { status: 'ok'; id: string; capturedAt: string } | { error: string }
}

interface LedgerEntry {
  clientId: string
  response: { status: 'ok'; id: string; capturedAt: string }
}

/** clientId → first response, for offline-replay dedup (contract Idempotency). */
function readLedger(path: string, log: Logger): Map<string, LedgerEntry['response']> {
  const map = new Map<string, LedgerEntry['response']>()
  const raw = readTextIfExists(path)
  if (raw === undefined) return map
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line) as LedgerEntry
      if (typeof e.clientId === 'string' && e.response !== undefined) map.set(e.clientId, e.response)
    } catch {
      log.warn('malformed ledger line skipped')
    }
  }
  return map
}

function noteContent(text: string, tags: string[], now: Date): string {
  const lines = ['---', `date: ${toWarsawDate(now)}`, `time: "${warsawTimeOfDay(now)}"`]
  lines.push(`category: ${tags[0] ?? 'inbox'}`)
  if (tags.length > 0) lines.push(`tags: [${tags.join(', ')}]`)
  // Marks the note as sidecar-written so /api/inbox reports source: capture.
  lines.push('via: hermes-lens', '---', '', text.trim(), '')
  return lines.join('\n')
}

/**
 * POST /api/capture — the only general write: a NEW note appended into the
 * agent's inbox, in the agent's own note format, guarded by the same .lock
 * companion convention the agent uses. Never touches existing notes.
 */
export function handleCapture(
  deps: { paths: Paths; writer: Writer; log: Logger; now: Date },
  body: unknown,
): CaptureResult {
  const { paths, writer, log, now } = deps
  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'invalid body' } }
  const req = body as Record<string, unknown>
  if (typeof req.text !== 'string' || req.text.trim() === '') {
    return { status: 400, body: { error: 'text is required' } }
  }
  const tags = Array.isArray(req.tags) ? req.tags.filter((t): t is string => typeof t === 'string') : []
  const clientId = typeof req.clientId === 'string' && req.clientId !== '' ? req.clientId : undefined

  if (clientId !== undefined) {
    const previous = readLedger(paths.capturesLedgerPath, log).get(clientId)
    if (previous !== undefined) return { status: 200, body: previous }
  }

  const base = `${translitSlug(req.text)}-${warsawHhmm(now)}`
  let slug = ''
  let written = false
  for (let attempt = 0; attempt < 20 && !written; attempt++) {
    slug = attempt === 0 ? base : `${base}-${attempt + 1}`
    const notePath = join(paths.inboxDir, `${slug}.md`)
    try {
      writer.withLock(notePath, () => {
        writer.writeNewFileExclusive(notePath, noteContent(req.text as string, tags, now))
      })
      written = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // filename (or stale lock) collision — try the next suffix
    }
  }
  if (!written) return { status: 500, body: { error: 'could not allocate note filename' } }

  const response = { status: 'ok' as const, id: slug, capturedAt: toWarsawIso(now) }
  if (clientId !== undefined) {
    writer.appendLine(paths.capturesLedgerPath, JSON.stringify({ clientId, response }))
  }
  appendJournal(writer, paths.journalPath, {
    type: 'capture',
    at: response.capturedAt,
    title: 'Note captured',
    detail: slug,
    relatedId: slug,
  })
  log.info('capture accepted', { id: slug })
  return { status: 201, body: response }
}
