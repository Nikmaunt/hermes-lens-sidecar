import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RemindersResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * The feed revision is a hash of the canonical items — NOT generated_at.
 * The agent rewrites reminders.json every morning even when nothing
 * changed; the phone must only resync when the items themselves move.
 */

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('reminders revision = content hash of items', () => {
  it('daily rewrite (new generated_at, reordered items) → SAME revision', async () => {
    const first = RemindersResponse.parse((await env.get('/api/reminders')).json)

    const doc = JSON.parse(readFileSync(env.paths.remindersPath, 'utf8')) as {
      generated_at: string
      reminders: unknown[]
    }
    doc.generated_at = '2026-07-06T07:00:02+02:00' // next cron run
    doc.reminders.reverse() // order is not content
    writeFileSync(env.paths.remindersPath, JSON.stringify(doc, null, 2), 'utf8')

    const second = RemindersResponse.parse((await env.get('/api/reminders')).json)
    expect(second.revision).toBe(first.revision)
    expect(second.items).toHaveLength(first.items.length)
  })

  it('changing one item → DIFFERENT revision', async () => {
    const before = RemindersResponse.parse((await env.get('/api/reminders')).json)

    const doc = JSON.parse(readFileSync(env.paths.remindersPath, 'utf8')) as {
      reminders: { title: string }[]
    }
    const target = doc.reminders[0]
    if (target !== undefined) target.title = target.title + ' (перенесено)'
    writeFileSync(env.paths.remindersPath, JSON.stringify(doc, null, 2), 'utf8')

    const after = RemindersResponse.parse((await env.get('/api/reminders')).json)
    expect(after.revision).not.toBe(before.revision)
  })
})
