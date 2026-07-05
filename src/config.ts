import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface Config {
  port: number
  bind: string
  token: string
  vaultDir: string
  hermesDir: string
  backupsDir: string
  dataDir: string
  diskPath: string
}

/** Every path the sidecar touches, derived once from Config. */
export interface Paths {
  inboxDir: string
  peopleDir: string
  projectsDir: string
  followupsPath: string
  subscriptionsPath: string
  decisionsPath: string
  remindersPath: string
  briefsDir: string
  lensQueueDir: string
  lastSyncPath: string
  gatewayStatePath: string
  heartbeatPath: string
  jobsPath: string
  memoryMdPath: string
  userMdPath: string
  stateDbPath: string
  backupsDir: string
  dataDir: string
  capturesLedgerPath: string
  journalPath: string
  diskPath: string
}

export function makePaths(cfg: Config): Paths {
  const v = cfg.vaultDir
  const h = cfg.hermesDir
  return {
    inboxDir: join(v, 'inbox'),
    peopleDir: join(v, 'people'),
    projectsDir: join(v, 'projects'),
    followupsPath: join(v, 'followups.md'),
    subscriptionsPath: join(v, 'subscriptions.md'),
    decisionsPath: join(v, 'decisions.md'),
    remindersPath: join(v, 'system', 'reminders.json'),
    briefsDir: join(v, 'system', 'briefs'),
    lensQueueDir: join(v, 'system', 'lens-queue'),
    lastSyncPath: join(v, 'system', 'last-sync.json'),
    gatewayStatePath: join(h, 'gateway_state.json'),
    heartbeatPath: join(h, 'cron', 'ticker_heartbeat'),
    jobsPath: join(h, 'cron', 'jobs.json'),
    memoryMdPath: join(h, 'memories', 'MEMORY.md'),
    userMdPath: join(h, 'memories', 'USER.md'),
    stateDbPath: join(h, 'state.db'),
    backupsDir: cfg.backupsDir,
    dataDir: cfg.dataDir,
    capturesLedgerPath: join(cfg.dataDir, 'captures.ndjson'),
    journalPath: join(cfg.dataDir, 'journal.ndjson'),
    diskPath: cfg.diskPath,
  }
}

function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const key = t.slice(0, eq).trim()
    let value = t.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Loads the sidecar's OWN .env (never the agent's ~/.hermes/.env).
 * Real environment variables take precedence over the file.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  envFilePath = join(process.cwd(), '.env'),
): Config {
  let fileVars: Record<string, string> = {}
  try {
    fileVars = parseEnvFile(readFileSync(envFilePath, 'utf8'))
  } catch {
    // no .env file — pure environment configuration
  }
  const get = (key: string): string | undefined => env[key] ?? fileVars[key]

  const token = get('LENS_TOKEN') ?? ''
  if (token.length < 16) {
    // Fail fast; never echo the value itself.
    throw new Error('LENS_TOKEN missing or shorter than 16 characters — refusing to start')
  }
  const port = Number(get('LENS_PORT') ?? '8787')
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid LENS_PORT: ${get('LENS_PORT') ?? ''}`)
  }
  return {
    port,
    bind: get('LENS_BIND') ?? '127.0.0.1',
    token,
    vaultDir: resolve(get('VAULT_DIR') ?? '/home/nick/vault'),
    hermesDir: resolve(get('HERMES_DIR') ?? '/home/nick/.hermes'),
    backupsDir: resolve(get('BACKUPS_DIR') ?? '/home/nick/backups'),
    dataDir: resolve(get('DATA_DIR') ?? join(process.cwd(), 'data')),
    diskPath: get('DISK_PATH') ?? '/',
  }
}
