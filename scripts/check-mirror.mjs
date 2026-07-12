// Mirror-diff gate: contract/schemas/ must stay a verbatim copy of the app
// repo's src/schemas/ (the source of truth — see contract/README.md).
//
// Source dir comes from CONTRACT_SOURCE_DIR (default ../hermes-lens/src/schemas).
// When that directory does not exist — CI on the VPS has no app checkout —
// the check SKIPS with a warning instead of failing. Any content divergence
// on a machine that does have the app repo exits 1 and turns `npm run check`
// red. Line endings are normalized before comparing: the two repos may be
// checked out with different git eol settings.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Deliberately not mirrored — the only allowed divergences:
//   index.ts  — local export barrel; additionally re-exports sidecar-only schemas
//   polish.ts — sidecar-only endpoint (/api/polish-words), absent in the app repo
const LOCAL_ONLY = new Set(['index.ts', 'polish.ts'])

const MIRROR_DIR = 'contract/schemas'
const sourceDir = process.env.CONTRACT_SOURCE_DIR ?? join('..', 'hermes-lens', 'src', 'schemas')

if (!existsSync(sourceDir)) {
  console.warn(`check-mirror: SKIPPED — source dir not found: ${sourceDir}`)
  console.warn('check-mirror: set CONTRACT_SOURCE_DIR to the app repo schemas dir to enable it')
  process.exit(0)
}

const normalize = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n')

const mirrorFiles = readdirSync(MIRROR_DIR).filter((f) => f.endsWith('.ts'))
const sourceFiles = readdirSync(sourceDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

let failed = false
let compared = 0

for (const f of mirrorFiles) {
  if (LOCAL_ONLY.has(f)) continue
  compared++
  const sourcePath = join(sourceDir, f)
  if (!existsSync(sourcePath)) {
    console.error(`check-mirror: RED — ${MIRROR_DIR}/${f} has no counterpart in ${sourceDir}`)
    failed = true
    continue
  }
  if (normalize(join(MIRROR_DIR, f)) !== normalize(sourcePath)) {
    console.error(`check-mirror: RED — ${MIRROR_DIR}/${f} diverged from ${sourcePath} (re-copy it verbatim)`)
    failed = true
  }
}

// A schema the app added but the mirror does not have yet is not a failure —
// the sidecar may lag behind additively — but say so out loud.
for (const f of sourceFiles) {
  if (!mirrorFiles.includes(f)) {
    console.warn(`check-mirror: warn — ${sourceDir}/${f} is not mirrored in ${MIRROR_DIR}`)
  }
}

if (failed) process.exit(1)
console.log(`check-mirror: OK — ${compared} mirrored schemas match ${sourceDir}`)
