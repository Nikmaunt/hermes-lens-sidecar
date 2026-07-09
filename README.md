# hermes-lens-sidecar

Read-mostly JSON API that lets the **Hermes Lens** phone app see the Hermes
agent's world (vault, state.db, gateway/cron status, memories) without ever
becoming a second writer of the agent's data.

- **Zero runtime dependencies** — native `node:http` + `node:sqlite` on
  Node ≥ 22.5 (`zod`, `vitest`, `typescript`, `eslint` are dev-only).
- Binds **127.0.0.1** only; TLS + tailnet exposure via `tailscale serve`.
- Single static bearer token, compared with `crypto.timingSafeEqual`.
- All timestamps ISO-8601 with offset; every "today" / date window is
  computed in **Europe/Warsaw**.

The API contract lives in the app repo (`hermes-lens/API-CONTRACT.md`).
[`contract/schemas/`](contract/schemas) is a **verbatim mirror** of
`hermes-lens/src/schemas/` used only by the test suite — the app repo is the
source of truth; evolution is additive-only.

## Write surface (everything else is strictly read-only)

The sidecar's *entire* write surface, enforced by a single write module
([`src/writes/fswrite.ts`](src/writes/fswrite.ts)) with a path allowlist, and
grep-proven by [`test/write-restriction.test.ts`](test/write-restriction.test.ts):

1. **New** capture notes in `vault/inbox/` (agent's own note format,
   `.lock`-companion protocol, never modifies existing notes),
2. queue files in `vault/system/lens-queue/` (consumed by the agent),
3. overwriting `vault/system/last-sync.json`,
4. its own private data dir (`captures.ndjson` clientId ledger +
   `journal.ndjson` write journal).

`state.db` is opened per request with a `file:…?mode=ro` URI +
`readOnly: true` + `busy_timeout 2000ms`; no `.backup()`, no long-lived
handle. Nothing under `~/.hermes/` is ever written.

Malformed or torn agent files (the agent writes with `.lock` companions)
never 500 an endpoint: tolerant parsers skip the broken item, log a warning
(JSON lines on stdout — method/path/status/ms only, never the token, bodies
or note contents), and keep serving.

## Endpoints

| Method | Path | Source | Launch state |
|---|---|---|---|
| GET | `/api/status` | gateway_state.json + ticker_heartbeat + cron/jobs.json + ~/backups + statfs//proc + state.db costs (Warsaw today & month-to-date) | FULL |
| GET | `/api/today` | followups.md + subscriptions deadlines + last-24h timeline + inbox count | FULL |
| GET | `/api/timeline` | state.db sessions + inbox file mtimes + backups + sidecar write-journal; 25/page, `?before=` cursor, `?category=` filter | PARTIAL¹ |
| GET | `/api/memory` | MEMORY.md (`§`-separated facts) + USER.md sections + lens-queue flag overlay | PARTIAL¹ |
| GET | `/api/projects` | `vault/projects/` | EMPTY-VALID² |
| GET | `/api/people` | `vault/people/*.md` grouped by frontmatter `person` | PARTIAL¹ |
| GET | `/api/documents` | subscriptions.md parser; `monthlyTotal` per currency (yearly ÷ 12) | EMPTY-VALID² (parser live day 1) |
| GET | `/api/decisions` | decisions.md | EMPTY-VALID² |
| GET | `/api/habits` | — | EMPTY-VALID² |
| GET | `/api/polish-words` | — | EMPTY-VALID² |
| GET | `/api/inbox` | `vault/inbox/*.md`, triage markers stripped, oldest first | FULL |
| GET | `/api/reminders` | `vault/system/reminders.json`; `revision` = content hash of items (a daily no-op rewrite does **not** change it) | FULL |
| GET | `/api/search?q=` | in-memory over parsed collections; **sensitive memory matches topic only with empty snippet; the timeline group matches session titles / cron names ONLY — never raw message bodies** | PARTIAL¹ |
| POST | `/api/capture` | writes `vault/inbox/<translit-slug>-<hhmm>.md`; `clientId` replay returns the first response | FULL |
| POST | `/api/inbox/{id}/triage` | queue file `<ts>-triage-<id>.json`; idempotent | FULL (queue side) |
| POST | `/api/memory/{id}/flag` | queue file `<ts>-flag-<id>.json`; `pendingFlag` served immediately, `mark-sensitive` masks sidecar-side at once | FULL |
| POST | `/api/sync/ack` | overwrites `vault/system/last-sync.json` | FULL |
| POST | `/api/chat` | starts an agent turn (job+poll); `clientId` replay returns the same `jobId`, one turn; **202** running (200 on replay) | FULL (needs `API_SERVER_KEY`) |
| GET | `/api/chat/{jobId}` | polls a turn: `running` \| `done` (+`reply`,`tokensUsed`) \| `error`; unknown/expired → 404 | FULL |

¹ PARTIAL = correct and schema-valid today; richer fields/events arrive
additively as the vault grows structure (people relations/agreements,
memory/habit/document timeline events, deeper search).

² EMPTY-VALID rationale: `vault/projects/`, `poland/`, `docs/` are empty and
`decisions.md` is empty with **no line format defined anywhere** in the
agent's skills — parsing would be guesswork, so these endpoints serve valid
empty collections (the app renders its empty states) until the agent defines
a format. `subscriptions.md` *does* have a documented format, so its parser
is implemented and tested even though the file is empty today. Habits and
Polish words have no data source on the VPS at all yet.

Errors are always `{ "error": "…" }` with a matching status code
(401 unauthorized, 400 bad body, 404 unknown route, 405 wrong method,
413 oversized body, 503 chat unconfigured). Unknown query params are ignored.

## Chat proxy (`/api/chat`)

The app never talks to the agent's model server; it only knows the sidecar and
the `LENS_TOKEN`. The sidecar forwards a turn to the agent's OpenAI-compatible
server on `127.0.0.1:8642`, hiding both the 30–120 s latency and the upstream
`API_SERVER_KEY`.

- **Job + poll.** `POST /api/chat {message, clientId, sessionId?}` returns
  `{jobId, sessionId, status:"running"}` immediately (202; a `clientId` replay
  returns the same job with 200 and never starts a second turn). The turn runs
  in the background — a single `POST /v1/chat/completions` to `AGENT_API_URL`
  with the upstream bearer, `CHAT_TURN_BUDGET_MS` budget — and the result lands
  in the job buffer. `GET /api/chat/{jobId}` polls until `done` (with `reply`
  and `tokensUsed` from `usage.total_tokens`) or `error`.
- **Leak-free errors.** Upstream 5xx / timeout / unreadable body collapse to a
  short human string (`agent error`, `agent timed out`, …); the upstream body
  and the key are never forwarded. The key appears in no log line and no
  response — pinned by tests, same bar as `LENS_TOKEN`.
- **Job buffer.** Append-only `chat-jobs.ndjson` in `DATA_DIR` (the only new
  write, through the same `Writer` allowlist; the fs invariant is unchanged).
  Records expire after `CHAT_JOB_TTL_MS` (default 10 min), which bounds both
  poll retention and dialog memory.
- **Followups context.** The agent's own turn context (SOUL/MEMORY/USER/
  skills) does not include `followups.md`, and the chat channel has no file
  tools — so the sidecar prepends the **active** follow-up lines (unchecked
  `- [ ]` only, overdue marked) as a `system` message on every turn, read
  fresh from the vault (read-only, `/api/today`'s parser). Missing/empty/
  unreadable file fails open: the turn goes out without the block. Gate:
  `CHAT_FOLLOWUPS_CONTEXT` (default `true`).
- **Someday context.** Second section of that same `system` message: the
  parked `someday.md` items (deferred follow-ups without a date, unchecked
  lines only, `/api/someday`'s parser), so the agent can answer «что у меня
  отложено?». Same rules — fresh read every turn, fail-open per section.
  Own gate: `CHAT_SOMEDAY_CONTEXT` (default `true`).
- **Sessions (v1).** `sessionId` groups a dialog. Continuity is
  **sidecar-maintained rolling context**: prior completed turns of the session
  (up to `CHAT_HISTORY_MAX_TURNS`, within the TTL window) are replayed as the
  `messages` array, so continuity holds regardless of how the agent server
  keys sessions. The agent injects its own system prompt/memory/personality
  (~17 k prompt tokens), so the sidecar carries only the dialog. **Caveat /
  to confirm on the VPS:** whether the agent server has native session support
  (e.g. `/api/sessions/:id`) that would give unbounded, server-side history is
  not yet verified; if it does, a later version can switch to it additively.

## Development

```bash
npm ci
npm run check        # typecheck (src + tests/mirror) + eslint + vitest
npm run build        # → dist/, entry dist/server.mjs (plain Node ≥22.5)
```

The test suite boots the real server against a fixture vault + a real
`node:sqlite` state.db in a temp dir: a contract walk over **every** endpoint
validated against the mirrored zod schemas (plus 401 checks), idempotency
replays, reminders-revision stability, search privacy guarantees,
broken/torn-input degradation, and the grep test that pins the write surface.

---

# Deploy runbook (manual, on the VPS)

## 1. Generate the token

```bash
openssl rand -hex 32
```

Put the value in **two** places:
- the sidecar's own `.env` on the VPS (step 2) — never in the agent's
  `~/.hermes/.env`;
- Hermes Lens → Settings → API token (step 6).

## 2. Install

```bash
cd ~
git clone git@github.com:<you>/hermes-lens-sidecar.git
cd hermes-lens-sidecar
~/.hermes/node/bin/npm ci
~/.hermes/node/bin/npm run build
cp .env.example .env
chmod 600 .env
nano .env        # set LENS_TOKEN=<value from step 1>; defaults fit the VPS
```

For chat (`/api/chat`), also set **`API_SERVER_KEY`** in this same `.env` to
the value already in the agent's `~/.hermes/.env`. The sidecar loads only its
own `.env` — it must never read the agent's env file (that read-only boundary
is pinned by `test/write-restriction.test.ts`), so the key is duplicated here
by design. Leave it blank to ship without chat: `/api/chat` then returns 503
and every other endpoint works normally. Confirm the value with:

```bash
grep API_SERVER_KEY ~/.hermes/.env    # copy the value into ~/hermes-lens-sidecar/.env
```

Quick foreground sanity check (Ctrl-C to stop):

```bash
~/.hermes/node/bin/node dist/server.mjs
```

## 3. systemd user unit

```bash
mkdir -p ~/.config/systemd/user
cp deploy/hermes-lens-sidecar.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hermes-lens-sidecar
systemctl --user status hermes-lens-sidecar
```

(Lingering is already enabled for hermes-gateway, so the unit survives
logout/reboot.)

## 4. Expose over Tailscale

```bash
sudo tailscale serve --bg 8787
tailscale serve status     # prints the https://hermes-vps.<tailnet>.ts.net mapping
```

`serve` terminates HTTPS with tailscale-managed certs and forwards to
127.0.0.1:8787, tailnet-only. (On older CLI versions the equivalent is
`tailscale serve --bg https / http://127.0.0.1:8787`.) To undo:
`sudo tailscale serve --https=443 off`.

## 5. Smoke checks

```bash
TOKEN=<value from step 1>
HOST=$(tailscale serve status | grep -oE 'https://[^ ]+' | head -1)

curl -s -o /dev/null -w '%{http_code}\n' "$HOST/api/status"            # → 401
curl -s -H "Authorization: Bearer $TOKEN" "$HOST/api/status" | head -c 400; echo   # → 200 JSON

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"Тест из runbook","tags":["test"]}' "$HOST/api/capture"
ls -t ~/vault/inbox/ | head -3   # the new note lands here (translit slug + -hhmm)

# chat (only if API_SERVER_KEY is set) — start a turn, then poll the jobId
JOB=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"message":"Скажи привет","clientId":"runbook-1"}' "$HOST/api/chat" | grep -oE '"jobId":"[^"]+"' | cut -d'"' -f4)
sleep 5; curl -s -H "Authorization: Bearer $TOKEN" "$HOST/api/chat/$JOB"   # → status done + reply
```

## 6. Lens app settings

- **Base URL**: the `https://hermes-vps.<tailnet>.ts.net` URL from step 4
  (no port — serve maps 443).
- **API token**: the value from step 1.

## 7. AGENT-SIDE TODO — teach the triage cron about lens-queue

The inbox-triage cron must consume `vault/system/lens-queue/`. Send the agent
this Telegram message:

> Привет! Я подключил телефонное приложение Hermes Lens через сайдкар-API.
> Он кладёт запросы от телефона в новую очередь `vault/system/lens-queue/` —
> расширь, пожалуйста, inbox-triage cron, чтобы он обрабатывал её при каждом
> прогоне:
>
> 1. Файлы `<timestamp>-triage-<itemId>.json` вида
>    `{"type":"triage","itemId":"<имя заметки в inbox без .md>","destination":"note|task|memory|archive|trash","requestedAt":"…"}`.
>    Перемести `vault/inbox/<itemId>.md` по назначению: `note` — как обычную
>    постоянную заметку по твоим правилам триажа; `task` — в followups.md;
>    `memory` — факт в память; `archive` — в архив; `trash` — удалить.
>    Запиши результат в лог триажа как обычно и **удали файл очереди** после
>    обработки. Если такой заметки уже нет — просто удали файл очереди.
>
> 2. Файлы `<timestamp>-flag-<itemId>.json` вида
>    `{"type":"flag","itemId":"mem-<12 hex>","action":"forget|mark-sensitive","reason":"…","requestedAt":"…"}`.
>    `itemId` — это `mem-` + первые 12 hex sha256 от полного текста факта;
>    факты — это абзацы MEMORY.md (разделённые строками с `§`) и абзацы
>    USER.md. `forget` — удали факт из файла памяти; `mark-sensitive` —
>    пометь факт чувствительным (вынеси в отдельную защищённую
>    секцию/файл на твоё усмотрение, но не теряй его).
>    После обработки **удали файл очереди** — именно его удаление снимает
>    статус «pending» у пункта в телефоне.
>
> Файлы очереди пишет только сайдкар; ты их только читаешь и удаляешь.
> `vault/system/last-sync.json` не трогай — его перезаписывает сайдкар.

## 8. Token rotation & logs

Rotate:

```bash
openssl rand -hex 32                       # new value
nano ~/hermes-lens-sidecar/.env            # replace LENS_TOKEN
systemctl --user restart hermes-lens-sidecar
# then paste the same value into Lens → Settings → API token
```

The old token stops working the moment the service restarts.

Logs (structured JSON lines; no tokens, bodies or note contents):

```bash
journalctl --user -u hermes-lens-sidecar -f      # live
journalctl --user -u hermes-lens-sidecar --since today
```

Sidecar-private state lives in `DATA_DIR` (default
`~/hermes-lens-sidecar/data`): `captures.ndjson` (clientId dedup ledger),
`journal.ndjson` (write journal that feeds /api/timeline), and
`chat-jobs.ndjson` (transit buffer for `/api/chat` turns; append-only,
TTL-bounded, holds message + reply text so keep `chmod 700` on `DATA_DIR`).
