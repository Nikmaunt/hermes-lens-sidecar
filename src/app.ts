import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { makePaths, type Config, type Paths } from './config.js'
import { isAuthorized } from './auth.js'
import { createLogger, type Logger, type LogSink } from './lib/log.js'
import { listFiles, readJsonTolerant } from './lib/fsread.js'
import { toWarsawIso } from './lib/time.js'
import { StateDb } from './readers/statedb.js'
import { readQueueState } from './readers/queuestate.js'
import { readReminders } from './readers/reminders.js'
import { readInbox } from './readers/inbox.js'
import { readMemory } from './readers/memory.js'
import { buildStatus, readCronJobs } from './readers/status.js'
import { readFollowups, readPeople, readSubscriptions, inboxFileEvents } from './readers/vault.js'
import { readBrief, readBriefs, todayMorningBrief } from './readers/briefs.js'
import { readDecisions } from './readers/decisions.js'
import { readHabits } from './readers/habits.js'
import { readPolishWords } from './readers/polish.js'
import { readDocs } from './readers/docs.js'
import { readMonthSpend } from './readers/transactions.js'
import type { DocumentItemOut } from './readers/vault.js'
import { collectEvents, paginate } from './domain/timeline.js'
import { buildToday } from './domain/today.js'
import { runSearch } from './domain/search.js'
import { Writer } from './writes/fswrite.js'
import { readJournal } from './writes/journal.js'
import { handleCapture } from './writes/capture.js'
import { handleFlag, handleFollowupAction, handleHabitTick, handleTriage } from './writes/queue.js'
import { handleSyncAck } from './writes/syncack.js'

const MAX_BODY_BYTES = 256 * 1024

export interface App {
  server: Server
  log: Logger
}

interface Ctx {
  cfg: Config
  paths: Paths
  writer: Writer
  statedb: StateDb
  log: Logger
  now: () => Date
}

function respond(res: ServerResponse, status: number, body: unknown): number {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
  return status
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

async function timelineEvents(ctx: Ctx): Promise<ReturnType<typeof collectEvents>> {
  return collectEvents({
    sessions: ctx.statedb.allSessions(),
    inboxFiles: inboxFileEvents(ctx.paths.inboxDir, ctx.log),
    backupFiles: listFiles(ctx.paths.backupsDir, ctx.log),
    journal: readJournal(ctx.paths.journalPath, ctx.log),
  })
}

/** Everything /api/documents serves: subscriptions.md lines + vault/docs/ files. */
function allDocuments(ctx: Ctx): DocumentItemOut[] {
  return [
    ...readSubscriptions(ctx.paths.subscriptionsPath, ctx.log),
    ...readDocs(ctx.paths.docsDir, ctx.log),
  ]
}

async function currentInbox(ctx: Ctx): Promise<Awaited<ReturnType<typeof readInbox>>> {
  // Items with a pending lens-queue triage are hidden until the agent's
  // cron actually moves the file — mirrors the app's optimistic model.
  const queue = readQueueState(ctx.paths.lensQueueDir, ctx.log)
  const items = await readInbox(ctx.paths.inboxDir, ctx.log)
  return items.filter((i) => !queue.triagedItemIds.has(i.id))
}

async function handleGet(ctx: Ctx, path: string, url: URL, res: ServerResponse): Promise<number> {
  const now = ctx.now()
  const briefId = /^\/api\/briefs\/([^/]+)$/.exec(path)
  if (briefId !== null) {
    const brief = readBrief(ctx.paths.briefsDir, decodeURIComponent(briefId[1] ?? ''), ctx.log)
    if (brief === undefined) return respond(res, 404, { error: 'not found' })
    return respond(res, 200, brief)
  }
  switch (path) {
    case '/api/status': {
      const body = await buildStatus(ctx.paths, ctx.statedb.allSessions(), now, ctx.log)
      return respond(res, 200, body)
    }
    case '/api/today': {
      const [events, inbox] = await Promise.all([timelineEvents(ctx), currentInbox(ctx)])
      // Overlay: while a done/snooze queue file awaits the agent, the item
      // is served WITH pendingAction (mirrors pendingFlag on memory items).
      const queue = readQueueState(ctx.paths.lensQueueDir, ctx.log)
      const followUps = readFollowups(ctx.paths.followupsPath, now, ctx.log).map((f) => {
        const pending = queue.followupActions.get(f.id)
        return pending === undefined ? f : { ...f, pendingAction: pending }
      })
      const brief = todayMorningBrief(ctx.paths.briefsDir, now, ctx.log)
      const body = buildToday({
        followUps,
        documents: allDocuments(ctx),
        timelineEvents: events,
        inboxCount: inbox.length,
        now,
        ...(brief !== undefined ? { brief } : {}),
      })
      return respond(res, 200, body)
    }
    case '/api/timeline': {
      const events = await timelineEvents(ctx)
      const params: { category?: string; before?: string } = {}
      const category = url.searchParams.get('category')
      const before = url.searchParams.get('before')
      if (category !== null) params.category = category
      if (before !== null) params.before = before
      return respond(res, 200, paginate(events, params))
    }
    case '/api/memory': {
      const queue = readQueueState(ctx.paths.lensQueueDir, ctx.log)
      return respond(res, 200, {
        items: readMemory(ctx.paths.memoryMdPath, ctx.paths.userMdPath, queue, ctx.log),
      })
    }
    case '/api/projects':
      // EMPTY-VALID: vault/projects/ exists but is empty and carries no
      // defined note format yet (see README). Served as a valid empty set.
      return respond(res, 200, { projects: [] })
    case '/api/people':
      return respond(res, 200, { people: readPeople(ctx.paths.peopleDir, ctx.log) })
    case '/api/documents': {
      const items = allDocuments(ctx)
      // monthlyTotal: recurring spend normalized per-month (yearly ÷ 12,
      // rounded to cents), one entry per currency — contract semantics.
      const totals = new Map<'EUR' | 'PLN' | 'USD', number>()
      for (const doc of items) {
        if (doc.amount === null || doc.billingPeriod === null) continue
        const perMonth =
          doc.billingPeriod === 'monthly' ? doc.amount.cents : Math.round(doc.amount.cents / 12)
        totals.set(doc.amount.currency, (totals.get(doc.amount.currency) ?? 0) + perMonth)
      }
      const monthlyTotal = [...totals.entries()].map(([currency, cents]) => ({ currency, cents }))
      // spentThisMonth is present iff the current month's transactions file
      // exists — field presence mirrors source presence.
      const spentThisMonth = readMonthSpend(ctx.paths.financeDir, now, ctx.log)
      return respond(res, 200, {
        items,
        monthlyTotal,
        ...(spentThisMonth !== undefined ? { spentThisMonth } : {}),
      })
    }
    case '/api/decisions': {
      const decisions = readDecisions(ctx.paths.decisionsPath, ctx.log)
      const project = url.searchParams.get('project')
      return respond(res, 200, {
        decisions: project === null ? decisions : decisions.filter((d) => d.projectId === project),
      })
    }
    case '/api/habits': {
      // Overlay: pending tick dates union into completedDates immediately,
      // so the streak the user just tapped never flickers away.
      const queue = readQueueState(ctx.paths.lensQueueDir, ctx.log)
      const habits = readHabits(ctx.paths.habitsPath, ctx.log).map((h) => {
        const pending = queue.habitTicks.get(h.id)
        if (pending === undefined) return h
        return { ...h, completedDates: [...new Set([...h.completedDates, ...pending])].sort() }
      })
      return respond(res, 200, { habits, generatedAt: toWarsawIso(now) })
    }
    case '/api/polish-words':
      return respond(res, 200, { words: readPolishWords(ctx.paths.polishWordsPath, ctx.log) })
    case '/api/briefs':
      return respond(res, 200, { items: readBriefs(ctx.paths.briefsDir, now, ctx.log) })
    case '/api/inbox':
      return respond(res, 200, { items: await currentInbox(ctx) })
    case '/api/reminders':
      return respond(res, 200, await readReminders(ctx.paths.remindersPath, ctx.log))
    case '/api/search': {
      const q = url.searchParams.get('q') ?? ''
      const queue = readQueueState(ctx.paths.lensQueueDir, ctx.log)
      const jobsJson = await readJsonTolerant(ctx.paths.jobsPath, ctx.log)
      const body = runSearch(q, {
        memory: readMemory(ctx.paths.memoryMdPath, ctx.paths.userMdPath, queue, ctx.log),
        people: readPeople(ctx.paths.peopleDir, ctx.log),
        documents: allDocuments(ctx),
        inbox: await currentInbox(ctx),
        sessions: ctx.statedb.allSessions(),
        cronJobs: readCronJobs(jobsJson, ctx.log),
      })
      return respond(res, 200, body)
    }
    default:
      return respond(res, 404, { error: 'not found' })
  }
}

async function handlePost(ctx: Ctx, path: string, raw: string | null, res: ServerResponse): Promise<number> {
  if (raw === null) return respond(res, 413, { error: 'body too large' })
  let body: unknown
  try {
    body = raw === '' ? {} : JSON.parse(raw)
  } catch {
    return respond(res, 400, { error: 'invalid json' })
  }
  const deps = { paths: ctx.paths, writer: ctx.writer, log: ctx.log, now: ctx.now() }

  if (path === '/api/capture') {
    const r = handleCapture(deps, body)
    return respond(res, r.status, r.body)
  }
  if (path === '/api/sync/ack') {
    const r = handleSyncAck(deps, body)
    return respond(res, r.status, r.body)
  }
  const triage = /^\/api\/inbox\/([^/]+)\/triage$/.exec(path)
  if (triage !== null) {
    const r = handleTriage(deps, decodeURIComponent(triage[1] ?? ''), body)
    return respond(res, r.status, r.body)
  }
  const flag = /^\/api\/memory\/([^/]+)\/flag$/.exec(path)
  if (flag !== null) {
    const r = handleFlag(deps, decodeURIComponent(flag[1] ?? ''), body)
    return respond(res, r.status, r.body)
  }
  const followupAction = /^\/api\/followups\/([^/]+)\/action$/.exec(path)
  if (followupAction !== null) {
    const r = handleFollowupAction(deps, decodeURIComponent(followupAction[1] ?? ''), body)
    return respond(res, r.status, r.body)
  }
  const habitTick = /^\/api\/habits\/([^/]+)\/tick$/.exec(path)
  if (habitTick !== null) {
    const r = handleHabitTick(deps, decodeURIComponent(habitTick[1] ?? ''), body)
    return respond(res, r.status, r.body)
  }
  return respond(res, 404, { error: 'not found' })
}

export function createApp(opts: { cfg: Config; logSink?: LogSink; nowFn?: () => Date }): App {
  const log = createLogger(opts.logSink)
  const cfg = opts.cfg
  const paths = makePaths(cfg)
  const writer = new Writer({
    inboxDir: paths.inboxDir,
    lensQueueDir: paths.lensQueueDir,
    lastSyncPath: paths.lastSyncPath,
    dataDir: paths.dataDir,
  })
  writer.ensureDir(paths.dataDir)
  const ctx: Ctx = {
    cfg,
    paths,
    writer,
    statedb: new StateDb(paths.stateDbPath, log),
    log,
    now: opts.nowFn ?? (() => new Date()),
  }

  const server = createServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const url = new URL(req.url ?? '/', 'http://internal')
    const path = url.pathname
    const method = req.method ?? 'GET'

    const finish = (status: number): void => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
      // path only — query strings (search terms) and bodies are never logged
      log.info('request', { method, path, status, ms: Math.round(ms * 10) / 10 })
    }

    void (async () => {
      try {
        // CORS: the Hermes Lens app runs in a Capacitor WebView whose origin
        // (https://localhost) never matches the sidecar's, so every fetch is
        // cross-origin. `*` is safe here because no cookies or ambient
        // credentials are involved — the security boundary is the bearer
        // token plus tailnet-only exposure. The header is set before any
        // dispatch so it reaches EVERY response, 401s and error envelopes
        // included; otherwise the app cannot read a 401 body and would
        // misclassify auth failures as network errors.
        res.setHeader('access-control-allow-origin', '*')
        if (method === 'OPTIONS') {
          // Preflight requests never carry Authorization, so this must run
          // before the auth check.
          res.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'Authorization, Content-Type',
            'access-control-max-age': '600',
          })
          res.end()
          finish(204)
          return
        }
        if (!isAuthorized(req.headers.authorization, cfg.token)) {
          finish(respond(res, 401, { error: 'unauthorized' }))
          return
        }
        if (method === 'GET') {
          finish(await handleGet(ctx, path, url, res))
        } else if (method === 'POST') {
          finish(await handlePost(ctx, path, await readBody(req), res))
        } else {
          finish(respond(res, 405, { error: 'method not allowed' }))
        }
      } catch (err) {
        // Tolerant parsers make this unreachable for malformed vault input;
        // this is the safety net for genuine bugs and I/O surprises.
        log.warn('handler error', { path, error: (err as Error).message.slice(0, 200) })
        if (!res.headersSent) finish(respond(res, 500, { error: 'internal error' }))
      }
    })()
  })

  return { server, log }
}
