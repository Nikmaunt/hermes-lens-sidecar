# Contract mirror

`schemas/` is a **verbatim copy** of `hermes-lens/src/schemas/` — the app repo
is the source of truth (see `API-CONTRACT.md` there). Do not edit these files
here; re-copy them when the app contract evolves (additive changes only).

They are used exclusively by the vitest contract suite to validate every real
sidecar response. Nothing under `contract/` is imported by runtime code, so
`zod` stays a dev-only dependency and the built server has zero runtime
dependencies.

## Mirror-diff gate

`npm run check` starts with `npm run check:mirror` (`scripts/check-mirror.mjs`),
which compares every `contract/schemas/*.ts` against the app repo byte-for-byte
(after line-ending normalization — the repos may be checked out with different
git eol settings):

- The source dir is `$CONTRACT_SOURCE_DIR`, default `../hermes-lens/src/schemas`.
- **Source dir missing** (e.g. CI on the VPS, where the app repo isn't checked
  out): the gate is **skipped with a warning** — it never fails a machine that
  cannot see the source of truth.
- **Any divergence** on a machine that does have the app repo: the gate exits 1
  and `check` goes red. Fix by re-copying the file verbatim from the app repo.
- A schema present in the app but not mirrored here is only a warning: the
  sidecar may lag behind additive contract growth.

Allowed local divergences (listed in `LOCAL_ONLY` inside the script):

- `index.ts` — local export barrel; additionally re-exports sidecar-only schemas.
- `polish.ts` — sidecar-only endpoint (`/api/polish-words`); the app repo has no
  copy of it (yet).
