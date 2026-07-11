import { listFiles, readTextIfExists } from '../lib/fsread.js'
import type { Logger } from '../lib/log.js'

/**
 * vault/system/command-results/*.json — the VPS runner's answer to a queued
 * command, one file per command. Tolerant like briefs: a broken or half-
 * written file is skipped with a warning, never served half-parsed. The
 * commandId is taken from the file CONTENT of a directory listing and used
 * only as a map key — it is never joined into a filesystem path, so a
 * crafted id cannot traverse outside the results directory.
 */

export interface CommandResultOut {
  state: 'done' | 'error'
  summary?: string
  result?: { kind: 'brief' | 'note'; id: string }
}

/** Same shape handleCommand mints: 'cmd-' + 8 hex chars of the clientId hash. */
const COMMAND_ID_RE = /^cmd-[0-9a-f]{8}$/

function parseResult(raw: string): { commandId: string; out: CommandResultOut } | undefined {
  let q: Record<string, unknown>
  try {
    q = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof q !== 'object' || q === null) return undefined
  if (typeof q.commandId !== 'string' || !COMMAND_ID_RE.test(q.commandId)) return undefined
  if (q.state !== 'done' && q.state !== 'error') return undefined
  const out: CommandResultOut = { state: q.state }
  if (typeof q.summary === 'string') out.summary = q.summary
  const r = q.result as Record<string, unknown> | undefined
  if (
    typeof r === 'object' &&
    r !== null &&
    (r.kind === 'brief' || r.kind === 'note') &&
    typeof r.id === 'string'
  ) {
    out.result = { kind: r.kind, id: r.id }
  }
  return { commandId: q.commandId, out }
}

/** commandId → parsed result; on duplicate ids the lexically later file wins. */
export function readCommandResults(commandResultsDir: string, log: Logger): Map<string, CommandResultOut> {
  const map = new Map<string, CommandResultOut>()
  const files = listFiles(commandResultsDir, log)
  files.sort((a, b) => a.name.localeCompare(b.name))
  for (const f of files) {
    if (!f.name.endsWith('.json') || f.name.startsWith('.')) continue
    const raw = readTextIfExists(f.path, log)
    if (raw === undefined) continue
    const parsed = parseResult(raw)
    if (parsed === undefined) {
      log.warn('command result skipped: malformed file', { file: f.name })
      continue
    }
    map.set(parsed.commandId, parsed.out)
  }
  return map
}
