import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/**
 * THE ONLY MODULE IN THE SIDECAR THAT PERFORMS FILESYSTEM WRITES.
 * (Enforced by test/write-restriction.test.ts, which greps src/ for write
 * calls outside this file.)
 *
 * The sidecar's entire write surface, by design:
 *   1. NEW capture notes in vault/inbox/ (plus their transient .lock)
 *   2. queue files in vault/system/lens-queue/
 *   3. overwriting vault/system/last-sync.json
 *   4. its own private data dir (ledger, journal)
 * Everything else — state.db, ~/.hermes/*, existing vault notes — is
 * strictly read-only, and Writer refuses paths outside the allowlist.
 */
export class Writer {
  private readonly allowedDirs: string[]
  private readonly allowedFiles: Set<string>

  constructor(opts: {
    inboxDir: string
    lensQueueDir: string
    lastSyncPath: string
    dataDir: string
  }) {
    this.allowedDirs = [resolve(opts.inboxDir), resolve(opts.lensQueueDir), resolve(opts.dataDir)]
    this.allowedFiles = new Set([
      resolve(opts.lastSyncPath),
      resolve(opts.lastSyncPath + '.tmp'),
    ])
  }

  private assertAllowed(path: string): string {
    const p = resolve(path)
    if (this.allowedFiles.has(p)) return p
    for (const dir of this.allowedDirs) {
      if (p === dir || (p.startsWith(dir + sep) && !p.slice(dir.length + 1).includes(sep))) {
        return p
      }
    }
    throw new Error(`write refused, path outside sidecar write surface: ${p}`)
  }

  ensureDir(dir: string): void {
    mkdirSync(this.assertAllowed(dir), { recursive: true })
  }

  /** Create a new file; throws if it already exists (no overwrites). */
  writeNewFileExclusive(path: string, content: string): void {
    this.ensureParent(path)
    writeFileSync(this.assertAllowed(path), content, { encoding: 'utf8', flag: 'wx' })
  }

  /** Atomic overwrite (tmp + rename); only for last-sync.json. */
  writeFileAtomic(path: string, content: string): void {
    const target = this.assertAllowed(path)
    const tmp = this.assertAllowed(path + '.tmp')
    writeFileSync(tmp, content, { encoding: 'utf8' })
    renameSync(tmp, target)
  }

  appendLine(path: string, line: string): void {
    this.ensureParent(path)
    appendFileSync(this.assertAllowed(path), line + '\n', 'utf8')
  }

  /** .lock companion protocol, matching the agent's own convention. */
  withLock(notePath: string, fn: () => void): void {
    const lock = this.assertAllowed(notePath + '.lock')
    writeFileSync(lock, '', { encoding: 'utf8', flag: 'wx' })
    try {
      fn()
    } finally {
      try {
        rmSync(lock)
      } catch {
        // lock already gone — nothing to clean up
      }
    }
  }

  private ensureParent(path: string): void {
    const parent = resolve(dirname(path))
    if (this.allowedDirs.includes(parent)) mkdirSync(parent, { recursive: true })
  }
}
