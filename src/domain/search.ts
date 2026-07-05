import type { MemoryItemOut } from '../readers/memory.js'
import type { PersonOut, DocumentItemOut } from '../readers/vault.js'
import type { InboxItemOut } from '../readers/inbox.js'
import type { SessionRow } from '../readers/statedb.js'
import type { CronJobOut } from '../readers/status.js'

export interface SearchResultOut {
  id: string
  title: string
  snippet: string
  sensitive: boolean
}

export interface SearchGroupOut {
  kind: 'memory' | 'people' | 'projects' | 'decisions' | 'timeline' | 'documents' | 'inbox'
  results: SearchResultOut[]
}

/**
 * In-memory search over the parsed collections, mirroring the app's
 * MockDataSource semantics.
 *
 * Privacy rules (contract "Semantics that matter"):
 * - sensitive memory items match on `topic` only, return an EMPTY snippet
 *   and sensitive: true — the fact text neither matches nor leaks;
 * - the timeline group matches session titles and cron job names ONLY.
 *   Raw message bodies from state.db are never queried here (v1).
 */
export function runSearch(
  query: string,
  data: {
    memory: MemoryItemOut[]
    people: PersonOut[]
    documents: DocumentItemOut[]
    inbox: InboxItemOut[]
    sessions: SessionRow[]
    cronJobs: CronJobOut[]
  },
): { query: string; groups: SearchGroupOut[] } {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return { query, groups: [] }

  const snippet = (text: string): string => {
    const idx = text.toLowerCase().indexOf(q)
    if (idx < 0) return text.slice(0, 90)
    const start = Math.max(0, idx - 30)
    return (start > 0 ? '…' : '') + text.slice(start, start + 90)
  }
  const match = (...fields: (string | null)[]): boolean =>
    fields.some((f) => f !== null && f.toLowerCase().includes(q))

  const groups: SearchGroupOut[] = []
  const add = (kind: SearchGroupOut['kind'], results: SearchResultOut[]): void => {
    if (results.length > 0) groups.push({ kind, results })
  }

  add(
    'memory',
    data.memory
      .filter((m) => (m.sensitivity === 'sensitive' ? match(m.topic) : match(m.fact, m.topic)))
      .map((m) =>
        m.sensitivity === 'sensitive'
          ? { id: m.id, title: m.topic, snippet: '', sensitive: true }
          : { id: m.id, title: m.topic, snippet: snippet(m.fact), sensitive: false },
      ),
  )
  add(
    'people',
    data.people
      .filter((p) => match(p.name, p.relation, p.context))
      .map((p) => ({ id: p.id, title: p.name, snippet: snippet(p.context), sensitive: false })),
  )
  // projects / decisions: both collections are EMPTY-VALID in v1 (no vault
  // format exists yet) — their groups appear once the sources do.
  add(
    'timeline',
    [
      ...data.sessions
        .filter((s) => s.title !== null && match(s.title))
        .map((s) => ({
          id: `sess-${s.id}`,
          title: s.title ?? '',
          snippet: snippet(s.title ?? ''),
          sensitive: false,
        })),
      ...data.cronJobs
        .filter((c) => match(c.name))
        .map((c) => ({ id: `cron-${c.id}`, title: c.name, snippet: snippet(c.name), sensitive: false })),
    ],
  )
  add(
    'documents',
    data.documents
      .filter((d) => match(d.title, d.provider, d.notes))
      .map((d) => ({ id: d.id, title: d.title, snippet: snippet(d.notes ?? d.provider), sensitive: false })),
  )
  add(
    'inbox',
    data.inbox
      .filter((i) => match(i.text, i.tags.join(' ')))
      .map((i) => ({ id: i.id, title: snippet(i.text), snippet: i.tags.join(', '), sensitive: false })),
  )

  return { query, groups }
}
