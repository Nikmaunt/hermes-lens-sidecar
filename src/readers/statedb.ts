import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import type { Logger } from '../lib/log.js'

/**
 * Read-only view over the agent's ~/.hermes/state.db (WAL mode, owned and
 * written exclusively by the agent). The connection is opened per call with
 * a `file:...?mode=ro` URI + readOnly flag — the sidecar can never write,
 * and never uses .backup. A short busy_timeout rides out agent checkpoints.
 */

export interface SessionRow {
  id: string
  source: string
  title: string | null
  startedAtMs: number
  endedAtMs: number | null
  messageCount: number
  toolCallCount: number
  costUsd: number
}

export class StateDb {
  constructor(
    private readonly dbPath: string,
    private readonly log: Logger,
  ) {}

  private open(): DatabaseSync {
    const uri = pathToFileURL(this.dbPath).toString() + '?mode=ro'
    const db = new DatabaseSync(uri, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    return db
  }

  /** All sessions, oldest first. Degrades to [] on any sqlite error. */
  allSessions(): SessionRow[] {
    let db: DatabaseSync | undefined
    try {
      db = this.open()
      const rows = db
        .prepare(
          `SELECT id, source, title, started_at, ended_at,
                  message_count, tool_call_count,
                  COALESCE(actual_cost_usd, estimated_cost_usd, 0) AS cost_usd
             FROM sessions
            ORDER BY started_at ASC`,
        )
        .all() as Record<string, unknown>[]
      const out: SessionRow[] = []
      for (const r of rows) {
        const startedAt = typeof r.started_at === 'number' ? r.started_at : null
        if (startedAt === null || typeof r.id !== 'string' && typeof r.id !== 'number') continue
        out.push({
          id: String(r.id),
          source: typeof r.source === 'string' ? r.source : 'unknown',
          title: typeof r.title === 'string' && r.title.trim() !== '' ? r.title : null,
          startedAtMs: Math.round(startedAt * 1000),
          endedAtMs: typeof r.ended_at === 'number' ? Math.round(r.ended_at * 1000) : null,
          messageCount: typeof r.message_count === 'number' ? r.message_count : 0,
          toolCallCount: typeof r.tool_call_count === 'number' ? r.tool_call_count : 0,
          costUsd: typeof r.cost_usd === 'number' ? r.cost_usd : 0,
        })
      }
      return out
    } catch (err) {
      this.log.warn('state.db unavailable, serving without session data', {
        error: (err as Error).message.slice(0, 120),
      })
      return []
    } finally {
      try {
        db?.close()
      } catch {
        // already closed
      }
    }
  }
}
