import { readTextIfExists } from '../lib/fsread.js'
import { translitSlug } from '../lib/translit.js'
import type { Logger } from '../lib/log.js'

/**
 * polish-words.md flashcard lines:
 *   - <слово> | <перевод> | <пример> | <теги через запятую> (added: YYYY-MM-DD)
 * The three pipes and a valid added-date are what makes a card (the
 * contract requires addedOn); translation/example/tags may be empty.
 * Empty words and unparsable lines are skipped — the vault has held
 * template lines. id = pw-<translit slug of the WORD> and must stay
 * stable across translation/example edits: the client's SM-2 state is
 * keyed on it.
 */

export interface PolishWordOut {
  id: string
  word: string
  translation: string
  example: string | null
  addedOn: string
  tags: string[]
}

const ADDED_RE = /\(added:\s*(\d{4}-\d{2}-\d{2})\s*\)\s*$/

export function readPolishWords(path: string, log: Logger): PolishWordOut[] {
  const raw = readTextIfExists(path, log)
  if (raw === undefined) return []
  const out: PolishWordOut[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('- ')) continue
    const parts = t.slice(2).split('|')
    if (parts.length !== 4) {
      log.warn('polish word line skipped: needs exactly three | separators')
      continue
    }
    const word = (parts[0] ?? '').trim()
    const tail = parts[3] ?? ''
    const added = ADDED_RE.exec(tail)
    if (word === '' || word.includes('<') || added === null) {
      log.warn('polish word line skipped: empty/template word or missing added-date')
      continue
    }
    const example = (parts[2] ?? '').trim()
    const tags = tail
      .slice(0, added.index)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    out.push({
      id: 'pw-' + translitSlug(word, 40),
      word,
      translation: (parts[1] ?? '').trim(),
      example: example === '' ? null : example,
      addedOn: added[1] ?? '',
      tags,
    })
  }
  return out
}
