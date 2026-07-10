import { fileMtimeMs, readTextIfExists } from '../lib/fsread.js'
import { shortHash } from '../lib/hash.js'
import { toWarsawIso } from '../lib/time.js'
import type { Logger } from '../lib/log.js'
import type { QueueState } from './queuestate.js'

export type MemoryCategoryOut =
  | 'identity'
  | 'preferences'
  | 'health'
  | 'routines'
  | 'plans'
  | 'relationships'
  | 'finance'
  | 'misc'

export interface MemoryItemOut {
  id: string
  category: MemoryCategoryOut
  topic: string
  fact: string
  sensitivity: 'normal' | 'sensitive'
  source: 'telegram' | 'vault' | 'inferred' | 'capture'
  learnedAt: string
  updatedAt: string
  pendingFlag: { action: 'forget' | 'mark-sensitive'; requestedAt: string; status: 'pending' } | null
}

/** Cheap keyword heuristic for MEMORY.md facts (RU + EN). */
function guessCategory(fact: string): MemoryCategoryOut {
  const f = fact.toLowerCase()
  if (/здоров|врач|болит|лекарств|сон|аллерг|health|doctor|sleep/.test(f)) return 'health'
  if (/деньг|бюджет|подписк|zł|злот|плат|зарплат|usd|eur|pln|финанс|money|budget|cost/.test(f)) return 'finance'
  if (/каждый день|каждое утро|привычк|по утрам|routine|daily/.test(f)) return 'routines'
  if (/план|собирается|хочет к|намерен|plan|goal/.test(f)) return 'plans'
  if (/жена|муж|мама|папа|брат|сестра|друг|подруг|сосед|коллег|famil|friend/.test(f)) return 'relationships'
  if (/предпочитает|любит|не любит|prefers|likes|dislikes/.test(f)) return 'preferences'
  return 'misc'
}

const TOPIC_MAX = 40

/**
 * Human title for a fact: the whole first sentence when it fits TOPIC_MAX,
 * otherwise a word-boundary cut with an ellipsis — never a dangling
 * fragment («ИДЕЯ ДЛЯ HERMES LENS: НА»).
 */
function topicOf(fact: string): string {
  const text = fact.replace(/\s+/g, ' ').trim()
  // sentence end = terminator before whitespace/EOL, so «40.5 USD» stays whole
  const end = /[.!?](?=\s|$)/.exec(text)
  const sentence = (end === null ? text : text.slice(0, end.index)).replace(/[.,;:!?]+$/, '').trim()
  if (sentence.length <= TOPIC_MAX) return sentence
  let topic = ''
  for (const w of sentence.split(' ')) {
    if (topic !== '' && (topic + ' ' + w).length > TOPIC_MAX) break
    topic = topic === '' ? w : topic + ' ' + w
  }
  return topic.replace(/[.,;:!?]+$/, '') + '…'
}

interface RawFact {
  fact: string
  category: MemoryCategoryOut
}

/** MEMORY.md: fact-paragraphs separated by lines containing `§`. */
function parseMemoryMd(raw: string): RawFact[] {
  const chunks: string[] = []
  let current: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.includes('§')) {
      chunks.push(current.join('\n'))
      current = []
    } else {
      current.push(line)
    }
  }
  chunks.push(current.join('\n'))
  return chunks
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter((c) => c !== '')
    .map((fact) => ({ fact, category: guessCategory(fact) }))
}

/** USER.md: `# USER` identity block, `## Как общаться`, `## Контекст и границы`. */
function parseUserMd(raw: string): RawFact[] {
  const out: RawFact[] = []
  let category: MemoryCategoryOut = 'identity'
  let current: string[] = []
  const flush = (): void => {
    const fact = current.join(' ').replace(/\s+/g, ' ').trim()
    if (fact !== '') out.push({ fact, category })
    current = []
  }
  for (const line of raw.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      flush()
      const heading = line.replace(/^#{1,6}\s*/, '').trim().toLowerCase()
      if (heading === 'user') category = 'identity'
      else if (heading.includes('общаться')) category = 'preferences'
      else category = 'misc' // boundaries and anything unrecognized
      continue
    }
    if (line.trim() === '') {
      flush()
    } else {
      current.push(line.trim())
    }
  }
  flush()
  return out
}

/**
 * ~/.hermes/memories/{MEMORY,USER}.md → /api/memory items.
 * id = content hash (stable across the agent's file regenerations);
 * learnedAt/updatedAt = file mtime (coarse — the files carry no per-fact
 * dates); sensitivity defaults to normal with a sidecar-side overlay from
 * the lens-queue flag files (mark-sensitive masks immediately, before the
 * agent has processed the request).
 */
export function readMemory(
  memoryMdPath: string,
  userMdPath: string,
  queue: QueueState,
  log: Logger,
): MemoryItemOut[] {
  const items: MemoryItemOut[] = []
  const seen = new Set<string>()
  const sources: { path: string; parse: (raw: string) => RawFact[] }[] = [
    { path: userMdPath, parse: parseUserMd },
    { path: memoryMdPath, parse: parseMemoryMd },
  ]
  for (const src of sources) {
    const raw = readTextIfExists(src.path, log)
    if (raw === undefined) continue
    const mtime = fileMtimeMs(src.path)
    const stamp = toWarsawIso(mtime === undefined ? new Date(0) : new Date(mtime))
    for (const { fact, category } of src.parse(raw)) {
      const id = 'mem-' + shortHash(fact)
      if (seen.has(id)) continue // identical fact in both files
      seen.add(id)
      const flag = queue.flags.get(id)
      items.push({
        id,
        category,
        topic: topicOf(fact),
        fact,
        sensitivity: flag?.action === 'mark-sensitive' ? 'sensitive' : 'normal',
        source: 'vault',
        learnedAt: stamp,
        updatedAt: stamp,
        pendingFlag: flag ? { action: flag.action, requestedAt: flag.requestedAt, status: 'pending' } : null,
      })
    }
  }
  return items
}
