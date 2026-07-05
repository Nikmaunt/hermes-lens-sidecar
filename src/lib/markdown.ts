/**
 * Minimal tolerant parser for the agent's note format (documented in the
 * VPS skill vault-automation/SKILL.md): YAML-ish frontmatter between ---
 * fences, then a Markdown body that may carry an HTML triage comment and a
 * `> [!question]` callout. Not a YAML implementation — only the flat
 * `key: value` / `key: [a, b]` / `- item` shapes the agent actually writes.
 */

export interface ParsedNote {
  /** Flat frontmatter; list values become string[]. */
  frontmatter: Record<string, string | string[]>
  body: string
  /** False when a frontmatter fence opens but never closes (torn write). */
  ok: boolean
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

export function parseNote(raw: string): ParsedNote {
  const original = raw.replace(/^﻿/, '')
  // The agent's triage cron may leave an HTML marker comment (and blank
  // lines) above the frontmatter fence; the fence must still be found there,
  // otherwise the whole file — frontmatter included — leaks out as body.
  let text = original
  for (;;) {
    const lead = /^(?:[ \t\r\n]+|<!--[\s\S]*?-->)/.exec(text)
    if (lead === null) break
    text = text.slice(lead[0].length)
  }
  if (!text.startsWith('---')) return { frontmatter: {}, body: original, ok: true }

  const lines = text.split(/\r?\n/)
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i] ?? '')) {
      close = i
      break
    }
  }
  if (close === -1) return { frontmatter: {}, body: '', ok: false }

  const fm: Record<string, string | string[]> = {}
  let lastListKey: string | null = null
  for (const line of lines.slice(1, close)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && lastListKey !== null) {
      const prev = fm[lastListKey]
      const arr = Array.isArray(prev) ? prev : []
      arr.push(unquote(item[1] ?? ''))
      fm[lastListKey] = arr
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue // junk line inside frontmatter — tolerated
    const key = kv[1] ?? ''
    const value = (kv[2] ?? '').trim()
    if (value === '') {
      fm[key] = []
      lastListKey = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      fm[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter((s) => s !== '')
      lastListKey = null
    } else {
      fm[key] = unquote(value)
      lastListKey = null
    }
  }
  return { frontmatter: fm, body: lines.slice(close + 1).join('\n'), ok: true }
}

/**
 * Strip agent triage markers from a note body: HTML comments and
 * `> [!question]` callout blocks (the marker line plus following quoted
 * lines). What remains is the user-facing note text.
 */
export function stripTriageMarkers(body: string): string {
  const noComments = body.replace(/<!--[\s\S]*?-->/g, '')
  const out: string[] = []
  let inCallout = false
  for (const line of noComments.split(/\r?\n/)) {
    if (/^>\s*\[!\w+\]/.test(line)) {
      inCallout = true
      continue
    }
    if (inCallout && /^>/.test(line)) continue
    inCallout = false
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Lightly flatten a Markdown note body to plain text for display: drop ATX
 * heading marks and **emphasis** asterisks, unwrap [[wikilinks]] to their
 * visible words. Line breaks are preserved — this is a cleanup, not a
 * re-layout.
 */
export function flattenInlineMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '') // ATX heading marks
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // [[target|alias]] → alias
        .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[name]] → name
        .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
        .replace(/__([^_]+)__/g, '$1') // __bold__
        .replace(/\*([^*\s][^*]*)\*/g, '$1'), // *italic* (list markers untouched)
    )
    .join('\n')
    .trim()
}

export function firstString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v[0] : v
}

export function asStringArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}
