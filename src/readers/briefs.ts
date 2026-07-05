import { listFiles, readTextIfExists, type FileEntry } from '../lib/fsread.js'
import { firstString, parseNote } from '../lib/markdown.js'
import { daysUntil, toWarsawDate, toWarsawIso } from '../lib/time.js'
import type { Logger } from '../lib/log.js'

/**
 * vault/system/briefs/*.md — agent-written digests with `date`, `title`,
 * `kind: morning|adhoc` frontmatter. Every field is optional in practice:
 * kind falls back to adhoc, title to the file name, date to a date embedded
 * in the file name (else the file's mtime). Torn frontmatter (fence never
 * closed) means the agent is mid-write — the file is skipped, never served
 * half-parsed.
 */

export interface BriefListItemOut {
  id: string
  date: string
  title: string
  kind: 'morning' | 'adhoc'
}

export interface BriefDetailOut extends BriefListItemOut {
  markdown: string
  generatedAt: string
}

const LIST_WINDOW_DAYS = 90

interface BriefFile extends BriefListItemOut {
  mtimeMs: number
  markdown: string
}

function parseBriefFile(f: FileEntry, log: Logger): BriefFile | undefined {
  const raw = readTextIfExists(f.path, log)
  if (raw === undefined) return undefined
  const parsed = parseNote(raw)
  if (!parsed.ok) {
    log.warn('brief skipped: unterminated frontmatter', { file: f.name })
    return undefined
  }
  const id = f.name.replace(/\.md$/, '')
  const fmDate = (firstString(parsed.frontmatter.date) ?? '').trim()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(fmDate)
    ? fmDate
    : (/\d{4}-\d{2}-\d{2}/.exec(f.name)?.[0] ?? toWarsawDate(new Date(f.mtimeMs)))
  const fmTitle = (firstString(parsed.frontmatter.title) ?? '').trim()
  const title = fmTitle !== '' ? fmTitle : id
  const kind = firstString(parsed.frontmatter.kind) === 'morning' ? ('morning' as const) : ('adhoc' as const)
  return { id, date, title, kind, mtimeMs: f.mtimeMs, markdown: parsed.body.trim() }
}

function briefFiles(briefsDir: string, log: Logger): BriefFile[] {
  const out: BriefFile[] = []
  for (const f of listFiles(briefsDir, log)) {
    if (!f.name.endsWith('.md') || f.name.startsWith('.')) continue
    const brief = parseBriefFile(f, log)
    if (brief !== undefined) out.push(brief)
  }
  return out
}

export function readBriefs(briefsDir: string, now: Date, log: Logger): BriefListItemOut[] {
  return briefFiles(briefsDir, log)
    .filter((b) => daysUntil(b.date, now) >= -LIST_WINDOW_DAYS)
    .sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)))
    .map(({ id, date, title, kind }) => ({ id, date, title, kind }))
}

/** id = file name without .md; resolved against the directory listing, so a crafted id can never escape briefsDir. */
export function readBrief(briefsDir: string, id: string, log: Logger): BriefDetailOut | undefined {
  const f = listFiles(briefsDir, log).find((x) => x.name === `${id}.md`)
  if (f === undefined) return undefined
  const brief = parseBriefFile(f, log)
  if (brief === undefined) return undefined
  return {
    id: brief.id,
    date: brief.date,
    title: brief.title,
    kind: brief.kind,
    markdown: brief.markdown,
    generatedAt: toWarsawIso(new Date(brief.mtimeMs)),
  }
}

/** The freshest (by mtime) morning brief dated Warsaw-today, if any. */
export function todayMorningBrief(
  briefsDir: string,
  now: Date,
  log: Logger,
): { id: string; title: string } | undefined {
  const today = toWarsawDate(now)
  const candidate = briefFiles(briefsDir, log)
    .filter((b) => b.kind === 'morning' && b.date === today)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  return candidate === undefined ? undefined : { id: candidate.id, title: candidate.title }
}
