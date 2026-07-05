import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../src/app.js'
import { makePaths, type Config, type Paths } from '../../src/config.js'
import { toWarsawDate } from '../../src/lib/time.js'

export const TEST_TOKEN = 'test-token-0123456789abcdef0123456789abcdef'

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures')

export interface SessionSpec {
  id: string
  startedAtMs: number
  costUsd: number
}

export interface TestEnv {
  root: string
  baseUrl: string
  token: string
  cfg: Config
  paths: Paths
  logs: string[]
  /** What buildStateDb inserted — lets tests recompute expected spend. */
  sessionSpecs: SessionSpec[]
  close(): Promise<void>
  get(path: string, token?: string | null): Promise<{ status: number; json: unknown }>
  post(path: string, body: unknown, token?: string | null): Promise<{ status: number; json: unknown }>
  listInboxFiles(): string[]
  listQueueFiles(): string[]
}

function warsawDatePlus(days: number): string {
  return toWarsawDate(new Date(Date.now() + days * 86_400_000))
}

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts)
}

function buildStateDb(dbPath: string): SessionSpec[] {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL') // the agent's db runs WAL — mimic it
  db.exec(`
    CREATE TABLE sessions(
      id TEXT PRIMARY KEY, source TEXT, title TEXT,
      started_at REAL, ended_at REAL,
      message_count INTEGER, tool_call_count INTEGER,
      input_tokens INTEGER, output_tokens INTEGER,
      estimated_cost_usd REAL, actual_cost_usd REAL
    );
    CREATE TABLE messages(
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at REAL
    );
  `)
  const nowSec = Date.now() / 1000
  const ins = db.prepare(
    `INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  // today, inside the 24 h activity window and today's spend
  ins.run('s-today', 'telegram', 'Обсуждение бюджета поездки', nowSec - 7200, nowSec - 6900, 12, 3, 900, 400, 0.02, 0.031)
  // 30 h ago — outside the 24 h window, inside month-to-date (same month in tests run mid-month)
  ins.run('s-digest', 'cron', 'Morning digest', nowSec - 108_000, nowSec - 107_700, 4, 1, 300, 120, 0.012, null)
  // 20 days ago, NULL title and no ended_at — exercises fallbacks
  ins.run('s-old', 'telegram', null, nowSec - 20 * 86_400, null, 40, 9, 5000, 2000, 0.5, 0.4)
  db.prepare(`INSERT INTO messages VALUES (1, 's-today', 'user', ?, ?)`).run(
    'тело сообщения с SECRETWORD-XYZ которое никогда не должно попасть в выдачу',
    nowSec - 7100,
  )
  db.close()
  // costUsd mirrors COALESCE(actual, estimated) so tests can recompute spend
  return [
    { id: 's-today', startedAtMs: (nowSec - 7200) * 1000, costUsd: 0.031 },
    { id: 's-digest', startedAtMs: (nowSec - 108_000) * 1000, costUsd: 0.012 },
    { id: 's-old', startedAtMs: (nowSec - 20 * 86_400) * 1000, costUsd: 0.4 },
  ]
}

export async function buildEnv(): Promise<TestEnv> {
  const root = mkdtempSync(join(tmpdir(), 'lens-sidecar-'))
  const vaultDir = join(root, 'vault')
  const hermesDir = join(root, 'hermes')
  const backupsDir = join(root, 'backups')
  const dataDir = join(root, 'data')

  cpSync(fixturePath('vault'), vaultDir, { recursive: true })
  cpSync(fixturePath('hermes'), hermesDir, { recursive: true })
  mkdirSync(join(vaultDir, 'projects'), { recursive: true })
  mkdirSync(backupsDir, { recursive: true })

  // Date-relative content so urgency / deadline windows are deterministic
  // whenever the suite runs. Static fixtures keep the same shapes for the
  // pure parser unit tests.
  writeFileSync(
    join(vaultDir, 'followups.md'),
    [
      '# Follow-ups',
      '',
      `- [ ] [[${warsawDatePlus(-1)}]] — ответить Олегу про маршрут, критично (from [[vstrecha-s-olegom]])`,
      `- [ ] [[${warsawDatePlus(0)}]] — продлить проездной (from [[kupit-bilety-na-poezd]])`,
      `- [ ] [[${warsawDatePlus(4)}]] — записаться к стоматологу`,
      `- [x] [[${warsawDatePlus(-2)}]] — оплатить интернет (from [[oplata-interneta]])`,
      '- [ ] сломанная строка без даты — парсер должен её пропустить',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(vaultDir, 'subscriptions.md'),
    [
      '# Subscriptions',
      '',
      `- **Spotify Family** — renews: ${warsawDatePlus(10)}, $17.99/month (from [[podpiski]])`,
      `- **Proton Mail** — renews: ${warsawDatePlus(200)}, $79.99/year (from [[podpiski]])`,
      '- **Netflix** — сломанная строка, не по формату',
      '',
    ].join('\n'),
    'utf8',
  )

  writeFileSync(join(hermesDir, 'cron', 'ticker_heartbeat'), (Date.now() / 1000).toFixed(3), 'utf8')
  const today = warsawDatePlus(0)
  writeFileSync(join(backupsDir, `state-${today}.db`), 'x'.repeat(1024), 'utf8')
  writeFileSync(join(backupsDir, `vault-${today}.tar.gz`), 'y'.repeat(2048), 'utf8')
  const sessionSpecs = buildStateDb(join(hermesDir, 'state.db'))

  const cfg: Config = {
    port: 0,
    bind: '127.0.0.1',
    token: TEST_TOKEN,
    vaultDir,
    hermesDir,
    backupsDir,
    dataDir,
    diskPath: root,
  }
  const logs: string[] = []
  const { server } = createApp({ cfg, logSink: (line) => logs.push(line) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`

  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token: string | null = TEST_TOKEN,
  ): Promise<{ status: number; json: unknown }> => {
    const headers: Record<string, string> = {}
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (method === 'POST') headers['content-type'] = 'application/json'
    const res = await fetch(baseUrl + path, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body) : null,
    })
    return { status: res.status, json: (await res.json()) as unknown }
  }

  return {
    root,
    baseUrl,
    token: TEST_TOKEN,
    cfg,
    paths: makePaths(cfg),
    logs,
    sessionSpecs,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // Windows can hold the sqlite file briefly; temp dir cleanup is best-effort
      }
    },
    get: (path, token) => request('GET', path, undefined, token),
    post: (path, body, token) => request('POST', path, body, token),
    listInboxFiles: () => readdirSync(join(vaultDir, 'inbox')).filter((f) => f.endsWith('.md')),
    listQueueFiles: () => {
      try {
        return readdirSync(join(vaultDir, 'system', 'lens-queue'))
      } catch {
        return []
      }
    },
  }
}
