import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'

/**
 * Memory item titles (§8.4 tail): the topic is a HUMAN title now — the whole
 * first sentence when it fits the limit, otherwise a word-boundary cut with
 * an ellipsis. Never a dangling fragment like «ИДЕЯ ДЛЯ HERMES LENS: НА».
 * Only title formation changes; facts and sensitive masking stay as they are
 * (covered by search.test.ts / contract.test.ts).
 */

let env: TestEnv

const LONG_FACT = 'ИДЕЯ ДЛЯ HERMES LENS: НА ГЛАВНОМ ЭКРАНЕ ПОКАЗЫВАТЬ СВОДКУ ДНЯ И ПОГОДУ'
const SHORT_SENTENCE_FACT =
  'Люблю тишину. Дальше очень длинный хвост про всё на свете, который не должен попасть в титул.'

beforeAll(async () => {
  env = await buildEnv()
  writeFileSync(env.paths.memoryMdPath, [LONG_FACT, '§', SHORT_SENTENCE_FACT].join('\n'), 'utf8')
})
afterAll(async () => {
  await env.close()
})

const itemFor = async (fact: string) => {
  const m = MemoryResponse.parse((await env.get('/api/memory')).json)
  return m.items.find((i) => i.fact.startsWith(fact.slice(0, 20)))
}

describe('memory titles cut at word boundaries', () => {
  it('long fact → word-boundary cut with ellipsis, near the 40-char limit', async () => {
    const item = await itemFor(LONG_FACT)
    expect(item).toBeDefined()
    expect(item?.topic).toBe('ИДЕЯ ДЛЯ HERMES LENS: НА ГЛАВНОМ ЭКРАНЕ…')
    // the visible prefix is an exact word-boundary prefix of the fact
    const prefix = (item?.topic ?? '').replace(/…$/, '')
    expect(LONG_FACT.startsWith(prefix)).toBe(true)
    expect(LONG_FACT[prefix.length]).toBe(' ')
    expect(prefix.length).toBeLessThanOrEqual(40)
  })

  it('first sentence shorter than the limit → taken whole, no ellipsis', async () => {
    const item = await itemFor(SHORT_SENTENCE_FACT)
    expect(item).toBeDefined()
    expect(item?.topic).toBe('Люблю тишину')
  })
})
