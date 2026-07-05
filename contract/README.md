# Contract mirror

`schemas/` is a **verbatim copy** of `hermes-lens/src/schemas/` — the app repo
is the source of truth (see `API-CONTRACT.md` there). Do not edit these files
here; re-copy them when the app contract evolves (additive changes only).

They are used exclusively by the vitest contract suite to validate every real
sidecar response. Nothing under `contract/` is imported by runtime code, so
`zod` stays a dev-only dependency and the built server has zero runtime
dependencies.
