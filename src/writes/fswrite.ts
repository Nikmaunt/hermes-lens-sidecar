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
 *   4. its own private data dir (ledgers, journal)
 *   5. NEW notification records in vault/system/notif-inbox/
 * Everything else — state.db, ~/.hermes/*, existing vault notes — is
 * strictly read-only, and Writer refuses paths outside the allowlist.
 *
 * DELETION is narrower still: the ONLY root where files may be removed is
 * vault/system/lens-queue/ — undo of a still-pending request deletes its
 * queue file (which this sidecar itself created). Notes, ledgers, journal,
 * last-sync.json and notif-inbox records can never be deleted through
 * Writer (notif-inbox is append-only input; the AGENT consumes it).
 */
export class Writer {
  private readonly allowedDirs: string[]
  private readonly allowedFiles: Set<string>
  private readonly deleteRoot: string

  constructor(opts: {
    inboxDir: string
    lensQueueDir: string
    notifInboxDir: string
    lastSyncPath: string
    dataDir: string
  }) {
    this.allowedDirs = [
      resolve(opts.inboxDir),
      resolve(opts.lensQueueDir),
      resolve(opts.notifInboxDir),
      resolve(opts.dataDir),
    ]
    this.allowedFiles = new Set([
      resolve(opts.lastSyncPath),
      resolve(opts.lastSyncPath + '.tmp'),
    ])
    this.deleteRoot = resolve(opts.lensQueueDir)
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

  /**
   * Delete one queue file — the undo primitive. Same direct-child rule as
   * writes (resolved path must sit immediately under lens-queue, no
   * subdirectories, no traversal); anything else is refused.
   * Returns false when the file is already gone (the agent consumed it
   * first, or a concurrent undo won) — callers answer "gone".
   */
  deleteQueueFile(path: string): boolean {
    const p = resolve(path)
    if (!p.startsWith(this.deleteRoot + sep) || p.slice(this.deleteRoot.length + 1).includes(sep)) {
      throw new Error(`delete refused, path outside lens-queue: ${p}`)
    }
    try {
      rmSync(p)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
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
