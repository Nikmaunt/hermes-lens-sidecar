import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Grep-provable write surface: the ONLY module in src/ that calls fs write
 * APIs is writes/fswrite.ts (whose Writer refuses paths outside the four
 * allowed roots). Also proves sqlite is opened read-only everywhere and
 * that the sidecar never shells out.
 */

const SRC = join(import.meta.dirname, '..', 'src')

function allSrcFiles(): { rel: string; text: string }[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.ts'))
    .map((rel) => ({ rel: rel.replaceAll('\\', '/'), text: readFileSync(join(SRC, rel), 'utf8') }))
}

const WRITE_CALL = new RegExp(
  '\\b(writeFileSync|appendFileSync|mkdirSync|renameSync|rmSync|rmdirSync|unlinkSync|' +
    'truncateSync|ftruncateSync|chmodSync|chownSync|copyFileSync|cpSync|symlinkSync|' +
    'linkSync|createWriteStream|writeFile|appendFile|copyFile|mkdtempSync)\\s*\\(',
)

describe('write surface is grep-provable', () => {
  it('no fs write calls anywhere in src/ except writes/fswrite.ts', () => {
    const offenders = allSrcFiles()
      .filter((f) => f.rel !== 'writes/fswrite.ts')
      .filter((f) => WRITE_CALL.test(f.text))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('sqlite is opened via file:?mode=ro URI with readOnly, and .backup never appears', () => {
    const statedb = readFileSync(join(SRC, 'readers', 'statedb.ts'), 'utf8')
    expect(statedb).toContain("'?mode=ro'")
    expect(statedb).toContain('readOnly: true')
    for (const f of allSrcFiles()) {
      // method-call form so `paths.backupsDir` doesn't false-positive
      expect(f.text, `${f.rel} must not use sqlite .backup()`).not.toMatch(/\.backup\s*\(/)
    }
  })

  it('no shelling out (child_process) and no agent-.env reads in src/', () => {
    for (const f of allSrcFiles()) {
      expect(f.text, `${f.rel} must not spawn processes`).not.toContain('child_process')
      expect(f.text, `${f.rel} must not touch the agent's .env`).not.toMatch(/hermesDir.*\.env/)
    }
  })

  it('auth uses timingSafeEqual', () => {
    const auth = readFileSync(join(SRC, 'auth.ts'), 'utf8')
    expect(auth).toContain('timingSafeEqual')
  })
})
