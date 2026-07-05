import { setTimeout as sleep } from 'node:timers/promises'
import { listFiles, readTextIfExists } from '../lib/fsread.js'
import {
  asStringArray,
  firstString,
  flattenInlineMarkdown,
  parseNote,
  stripTriageMarkers,
} from '../lib/markdown.js'
import { toWarsawIso } from '../lib/time.js'
import type { Logger } from '../lib/log.js'

export interface InboxItemOut {
  id: string
  text: string
  capturedAt: string
  source: 'telegram' | 'capture' | 'agent'
  tags: string[]
}

/**
 * vault/inbox/*.md → /api/inbox items, oldest first.
 * id = filename slug; text = body stripped of triage markers and flattened
 * to plain text; capturedAt =
 * file mtime; source: sidecar `via: hermes-lens` marker → capture, explicit
 * frontmatter source honored, everything else (agent-written) → telegram.
 */
export async function readInbox(inboxDir: string, log: Logger): Promise<InboxItemOut[]> {
  const files = listFiles(inboxDir, log)
    .filter((f) => f.name.endsWith('.md') && !f.name.startsWith('.'))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)

  const items: InboxItemOut[] = []
  for (const f of files) {
    let raw = readTextIfExists(f.path, log)
    if (raw === undefined) continue
    let parsed = parseNote(raw)
    if (!parsed.ok) {
      // torn agent write (it uses .lock companions): re-read once, then skip
      await sleep(60)
      raw = readTextIfExists(f.path, log) ?? raw
      parsed = parseNote(raw)
      if (!parsed.ok) {
        log.warn('inbox note skipped: unterminated frontmatter', { file: f.name })
        continue
      }
    }
    const fm = parsed.frontmatter
    const via = firstString(fm.via)
    const fmSource = firstString(fm.source)
    const source: InboxItemOut['source'] =
      via === 'hermes-lens'
        ? 'capture'
        : fmSource === 'telegram' || fmSource === 'capture' || fmSource === 'agent'
          ? fmSource
          : 'telegram'
    const tags = [...new Set([...asStringArray(fm.tags), ...asStringArray(fm.category)])].filter(
      (t) => t !== '',
    )
    items.push({
      id: f.name.replace(/\.md$/, ''),
      text: flattenInlineMarkdown(stripTriageMarkers(parsed.body)),
      capturedAt: toWarsawIso(new Date(f.mtimeMs)),
      source,
      tags,
    })
  }
  return items
}
