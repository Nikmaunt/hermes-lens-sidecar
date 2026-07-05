import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Logger } from './log.js'

/**
 * Tolerant read helpers. The agent owns these files and may be mid-write
 * (it uses .lock companions); a torn read must degrade, never crash a
 * request. All functions return undefined / [] instead of throwing.
 */

export function readTextIfExists(path: string, log?: Logger): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && log) log.warn('read failed', { path, code: code ?? 'unknown' })
    return undefined
  }
}

/**
 * Read + JSON.parse with one re-read on failure (torn agent write), then
 * degrade to undefined with a warning.
 */
export async function readJsonTolerant(path: string, log: Logger): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = readTextIfExists(path, log)
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      if (attempt === 0) await sleep(60)
    }
  }
  log.warn('malformed json, skipping', { path })
  return undefined
}

export interface FileEntry {
  name: string
  path: string
  mtimeMs: number
  size: number
}

/** Regular files in `dir` (non-recursive); [] when the dir is missing. */
export function listFiles(dir: string, log?: Logger): FileEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: FileEntry[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (st.isFile()) out.push({ name, path, mtimeMs: st.mtimeMs, size: st.size })
    } catch (err) {
      if (log) log.warn('stat failed', { path, code: (err as NodeJS.ErrnoException).code ?? '?' })
    }
  }
  return out
}

export function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}
