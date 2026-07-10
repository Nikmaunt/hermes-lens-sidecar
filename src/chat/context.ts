import { readFollowups, readSomeday } from '../readers/vault.js'
import type { Logger } from '../lib/log.js'

/**
 * Followups context for chat turns. The agent's own turn context on 8642
 * (SOUL/MEMORY/USER/skills) does not include followups.md, and the chat
 * channel has no file tools — so without this block the agent answers
 * "какие у меня дела?" with "пусто" while active items sit in the vault.
 * followups.md is the single source of truth for active items
 * (reminders.json drops past dates on recompute), so it is read fresh on
 * every turn — the file is tiny, freshness beats caching.
 *
 * Reuses the /api/today parser (readFollowups): active `- [ ]` lines only,
 * done `- [x]` and unparsable lines never reach the block. Any failure —
 * missing file, unreadable file, no active lines — fails open: the turn
 * goes out without the block, never with an error.
 */
export function followupsSystemContent(path: string, now: Date, log: Logger): string | undefined {
  try {
    const items = readFollowups(path, now, log)
    if (items.length === 0) return undefined
    const lines = items.map((f) => {
      const source = f.source === '' ? '' : ` (from [[${f.source}]])`
      const overdue = f.urgency === 'overdue' ? ' (просрочено)' : ''
      return `- ${f.dueDate ?? 'без даты'} — ${f.title}${source}${overdue}`
    })
    // Human label only — the agent mirrors these headings back to the user,
    // so internal file names and vault mechanics must never appear here.
    return ['Активные дела пользователя (с датами):', ...lines].join('\n')
  } catch {
    return undefined // a context block must never cost the user the turn
  }
}

/**
 * Closes the cheat-sheet system block (appended once, after all sections):
 * without it the agent mirrors the block's internals — labels, file names,
 * source slugs — back into user-facing replies (UX finding).
 */
export const CONTEXT_INSTRUCTION =
  'Отвечая пользователю, называй это просто делами/отложенными делами, не упоминай файлы и внутреннюю механику.'

/**
 * Second cheat-sheet section: the parked someday.md items, so the agent can
 * answer «что у меня отложено?». Same rules as the followups section — read
 * fresh every turn, any failure shape fails open to a turn without it.
 */
export function somedaySystemContent(path: string, log: Logger): string | undefined {
  try {
    const items = readSomeday(path, log)
    if (items.length === 0) return undefined
    const lines = items.map((i) => {
      const source = i.source === undefined ? '' : ` (from [[${i.source}]])`
      return `- ${i.title}${source}`
    })
    return ['Отложенные дела без срока:', ...lines].join('\n')
  } catch {
    return undefined // a context block must never cost the user the turn
  }
}
