import { statfsSync } from 'node:fs'
import { freemem, totalmem, uptime as osUptime } from 'node:os'
import { listFiles, readJsonTolerant, readTextIfExists } from '../lib/fsread.js'
import { parseIsoMs, toWarsawDate, toWarsawIso, toWarsawMonth } from '../lib/time.js'
import type { Logger } from '../lib/log.js'
import type { Paths } from '../config.js'
import type { SessionRow } from './statedb.js'

/** Fallback for required IsoDateTime fields when the source is unreadable. */
const EPOCH_ISO = '1970-01-01T01:00:00+01:00'

/** Heartbeat refreshes ~every minute; 3 missed ticks = not alive. */
const HEARTBEAT_FRESH_MS = 180_000

export interface CronJobOut {
  id: string
  name: string
  schedule: string
  lastRun: string
  lastResult: 'ok' | 'error' | 'skipped'
}

export interface AgentStatusOut {
  gateway: { alive: boolean; lastHeartbeat: string }
  cronJobs: CronJobOut[]
  lastBackup: { at: string; sizeBytes: number; target: string } | null
  system: {
    diskUsedBytes: number
    diskTotalBytes: number
    ramUsedBytes: number
    ramTotalBytes: number
    uptimeSeconds: number
  }
  tokenSpend: { todayUsd: number; monthUsd: number; since?: string }
  generatedAt: string
}

/** Accepts unix seconds (number) or an ISO string; returns ms or null. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 1000)
  if (typeof v === 'string') return parseIsoMs(v)
  return null
}

function readGateway(paths: Paths, now: Date, log: Logger, state: unknown): AgentStatusOut['gateway'] {
  const gw = (typeof state === 'object' && state !== null ? state : {}) as Record<string, unknown>
  const running = gw.gateway_state === 'running'

  const hbRaw = readTextIfExists(paths.heartbeatPath, log)
  const hbEpoch = hbRaw === undefined ? NaN : Number.parseFloat(hbRaw.trim())
  const hbMs = Number.isFinite(hbEpoch) ? Math.round(hbEpoch * 1000) : null

  const lastMs = hbMs ?? toMs(gw.updated_at)
  return {
    alive: running && (hbMs === null || now.getTime() - hbMs < HEARTBEAT_FRESH_MS),
    lastHeartbeat: lastMs === null ? EPOCH_ISO : toWarsawIso(new Date(lastMs)),
  }
}

export function readCronJobs(jobsJson: unknown, log: Logger): CronJobOut[] {
  const root = (typeof jobsJson === 'object' && jobsJson !== null ? jobsJson : {}) as Record<string, unknown>
  if (!Array.isArray(root.jobs)) return []
  const out: CronJobOut[] = []
  for (const raw of root.jobs) {
    if (typeof raw !== 'object' || raw === null) continue
    const j = raw as Record<string, unknown>
    const id = typeof j.id === 'string' ? j.id : typeof j.name === 'string' ? j.name : ''
    const name = typeof j.name === 'string' ? j.name : id
    if (id === '') continue
    const lastRunMs = toMs(j.last_run_at)
    if (lastRunMs === null) {
      // contract requires lastRun; a job that never ran yet is not shown
      log.warn('cron job skipped: no last_run_at', { id })
      continue
    }
    out.push({
      id,
      name,
      schedule: typeof j.schedule_display === 'string' ? j.schedule_display : '',
      lastRun: toWarsawIso(new Date(lastRunMs)),
      lastResult:
        j.last_status === 'ok'
          ? 'ok'
          : j.last_status === 'error' || (typeof j.last_error === 'string' && j.last_error !== '')
            ? 'error'
            : 'skipped',
    })
  }
  return out
}

const BACKUP_RE = /^(?:state|vault)-(\d{4}-\d{2}-\d{2})\.(?:db|tar\.gz)$/

function readLastBackup(paths: Paths, log: Logger): AgentStatusOut['lastBackup'] {
  const groups = new Map<string, { newestMtimeMs: number; sizeBytes: number }>()
  for (const f of listFiles(paths.backupsDir, log)) {
    const m = BACKUP_RE.exec(f.name)
    if (m === null) continue
    const date = m[1] ?? ''
    const g = groups.get(date) ?? { newestMtimeMs: 0, sizeBytes: 0 }
    g.newestMtimeMs = Math.max(g.newestMtimeMs, f.mtimeMs)
    g.sizeBytes += f.size
    groups.set(date, g)
  }
  const latest = [...groups.keys()].sort().at(-1)
  if (latest === undefined) return null
  const g = groups.get(latest)
  if (g === undefined) return null
  return {
    at: toWarsawIso(new Date(g.newestMtimeMs)),
    sizeBytes: g.sizeBytes,
    target: `local:${paths.backupsDir}`,
  }
}

function readSystem(paths: Paths, log: Logger): AgentStatusOut['system'] {
  let diskUsed = 0
  let diskTotal = 1
  try {
    const s = statfsSync(paths.diskPath)
    diskTotal = Math.max(1, s.bsize * s.blocks)
    diskUsed = Math.max(0, s.bsize * (s.blocks - s.bfree))
  } catch (err) {
    log.warn('statfs failed', { path: paths.diskPath, error: (err as Error).message.slice(0, 80) })
  }

  // /proc/meminfo when available (MemAvailable is the honest number);
  // os.totalmem/freemem otherwise.
  let ramTotal = Math.max(1, totalmem())
  let ramUsed = Math.max(0, totalmem() - freemem())
  const meminfo = readTextIfExists('/proc/meminfo')
  if (meminfo !== undefined) {
    const total = /^MemTotal:\s+(\d+)\s*kB/m.exec(meminfo)
    const avail = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo)
    if (total !== null && avail !== null) {
      ramTotal = Math.max(1, Number(total[1]) * 1024)
      ramUsed = Math.max(0, ramTotal - Number(avail[1]) * 1024)
    }
  }

  let uptimeSeconds = Math.round(osUptime())
  const procUptime = readTextIfExists('/proc/uptime')
  if (procUptime !== undefined) {
    const first = Number.parseFloat(procUptime.split(' ')[0] ?? '')
    if (Number.isFinite(first)) uptimeSeconds = Math.round(first)
  }
  return {
    diskUsedBytes: Math.round(diskUsed),
    diskTotalBytes: Math.round(diskTotal),
    ramUsedBytes: Math.round(ramUsed),
    ramTotalBytes: Math.round(ramTotal),
    uptimeSeconds: Math.max(0, uptimeSeconds),
  }
}

export function tokenSpend(sessions: SessionRow[], now: Date): AgentStatusOut['tokenSpend'] {
  const today = toWarsawDate(now)
  const month = toWarsawMonth(now)
  let todayUsd = 0
  let monthUsd = 0
  let earliestMs = Number.POSITIVE_INFINITY
  for (const s of sessions) {
    const day = toWarsawDate(new Date(s.startedAtMs))
    if (day === today) todayUsd += s.costUsd
    if (day.startsWith(month)) monthUsd += s.costUsd
    earliestMs = Math.min(earliestMs, s.startedAtMs)
  }
  const round = (v: number): number => Math.round(v * 10_000) / 10_000
  return {
    todayUsd: round(todayUsd),
    monthUsd: round(monthUsd),
    // Warsaw date of the first accounted session (additive, optional in the
    // contract). No sessions yet → omitted, never null/empty.
    ...(Number.isFinite(earliestMs) ? { since: toWarsawDate(new Date(earliestMs)) } : {}),
  }
}

export async function buildStatus(
  paths: Paths,
  sessions: SessionRow[],
  now: Date,
  log: Logger,
): Promise<AgentStatusOut> {
  const gatewayState = await readJsonTolerant(paths.gatewayStatePath, log)
  const jobsJson = await readJsonTolerant(paths.jobsPath, log)
  return {
    gateway: readGateway(paths, now, log, gatewayState),
    cronJobs: readCronJobs(jobsJson, log),
    lastBackup: readLastBackup(paths, log),
    system: readSystem(paths, log),
    tokenSpend: tokenSpend(sessions, now),
    generatedAt: toWarsawIso(now),
  }
}
