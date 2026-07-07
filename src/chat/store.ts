import { readTextIfExists } from '../lib/fsread.js'
import type { Logger } from '../lib/log.js'
import type { Writer } from '../writes/fswrite.js'

/**
 * The chat job buffer — the sidecar's transit store for async chat turns, and
 * the ONLY new write this feature introduces. It is append-only NDJSON in the
 * sidecar-private DATA_DIR (a direct child, already inside Writer's allowlist),
 * written EXCLUSIVELY through Writer.appendLine so the grep-provable write
 * surface (test/write-restriction.test.ts) stays intact — nothing here opens a
 * file handle of its own.
 *
 * A turn mutates by appending a fresh full snapshot for its jobId; the LAST
 * line per jobId wins. Records whose turn started more than `ttlMs` ago are
 * expired: they drop out of the live view, which bounds BOTH poll retention
 * and how far a session's rolling dialog context can reach. Growth matches the
 * existing captures/journal ledgers (append-only, single-user, tiny).
 */

export type JobStatus = 'running' | 'done' | 'error'

/** One proxied chat turn, persisted as a single NDJSON line. */
export interface JobRecord {
  jobId: string
  clientId: string
  sessionId: string
  status: JobStatus
  /** Epoch ms the turn was accepted — drives TTL, never exposed to the app. */
  startedAtMs: number
  /** This turn's user message; kept so a later turn can rebuild dialog context. */
  message: string
  reply?: string
  error?: string
  tokensUsed?: number
  finishedAt?: string
}

export interface JobState {
  /** Live (non-expired) records, latest snapshot per jobId. */
  byJobId: Map<string, JobRecord>
  /** Live records indexed by clientId (latest start wins) — the dedup view. */
  byClientId: Map<string, JobRecord>
}

function isJobRecord(v: unknown): v is JobRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.jobId === 'string' &&
    typeof r.clientId === 'string' &&
    typeof r.sessionId === 'string' &&
    typeof r.startedAtMs === 'number' &&
    typeof r.message === 'string' &&
    (r.status === 'running' || r.status === 'done' || r.status === 'error')
  )
}

/** Parse the buffer into the live, TTL-filtered view at instant `nowMs`. */
export function readJobState(path: string, ttlMs: number, nowMs: number, log: Logger): JobState {
  const latest = new Map<string, JobRecord>()
  const raw = readTextIfExists(path, log)
  if (raw !== undefined) {
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isJobRecord(parsed)) latest.set(parsed.jobId, parsed) // last line wins
      } catch {
        log.warn('malformed chat job line skipped')
      }
    }
  }
  const byJobId = new Map<string, JobRecord>()
  const byClientId = new Map<string, JobRecord>()
  const cutoff = nowMs - ttlMs
  for (const record of latest.values()) {
    if (record.startedAtMs < cutoff) continue // expired
    byJobId.set(record.jobId, record)
    const prior = byClientId.get(record.clientId)
    if (prior === undefined || record.startedAtMs >= prior.startedAtMs) {
      byClientId.set(record.clientId, record)
    }
  }
  return { byJobId, byClientId }
}

/** Append a full snapshot. The Writer is the only module allowed to write. */
export function appendJob(writer: Writer, path: string, record: JobRecord): void {
  writer.appendLine(path, JSON.stringify(record))
}
