// Build step: emit the dist/server.mjs entry the runbook and systemd unit
// expect (`node dist/server.mjs`). tsc outputs ESM .js files; this wrapper
// gives the deployment a stable .mjs entry point.
import { writeFileSync } from 'node:fs'

writeFileSync('dist/server.mjs', "import './server.js';\n", 'utf8')
