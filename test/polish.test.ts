import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PolishWordsResponse } from '../contract/schemas/index'
import { createLogger } from '../src/lib/log.js'
import { readPolishWords } from '../src/readers/polish.js'
import { buildEnv, fixturePath, type TestEnv } from './helpers/env'

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

const silentLog = createLogger(() => {})

describe('polish-words.md parser', () => {
  it('parses word | translation | example | tags (added: date) lines', () => {
    const words = readPolishWords(fixturePath('vault', 'polish-words.md'), silentLog)
    expect(words.find((w) => w.word === 'zniżka')).toEqual({
      id: 'pw-znizka',
      word: 'zniżka',
      translation: 'скидка',
      example: 'Mam zniżkę studencką.',
      addedOn: '2026-06-20',
      tags: ['shopping', 'money'],
    })
  })

  it('empty example → null, empty tags → [], separators still required', () => {
    const words = readPolishWords(fixturePath('vault', 'polish-words.md'), silentLog)
    expect(words.find((w) => w.word === 'pociąg')).toMatchObject({ example: null, tags: ['travel'] })
    expect(words.find((w) => w.word === 'wrzesień')).toMatchObject({ tags: [] })
  })

  it('template lines, empty words and lines without a valid added-date never become cards', () => {
    const words = readPolishWords(fixturePath('vault', 'polish-words.md'), silentLog)
    expect(words).toHaveLength(3)
    const all = JSON.stringify(words)
    expect(all).not.toContain('<слово>')
    expect(all).not.toContain('пустое слово')
    expect(all).not.toContain('kubek') // no (added: …) → no card
  })

  it('id is derived from the word ONLY — stable across translation/example edits (SM-2 state)', () => {
    const before = readPolishWords(fixturePath('vault', 'polish-words.md'), silentLog)
    const zn = before.find((w) => w.word === 'zniżka')
    expect(zn?.id).toBe('pw-znizka')
    // same word, different translation/example/tags → same id
    writeFileSync(
      env.paths.polishWordsPath,
      '- zniżka | скидка (обновлённый перевод) | Nowy przykład. | sale (added: 2026-06-21)\n',
      'utf8',
    )
    const after = readPolishWords(env.paths.polishWordsPath, silentLog)
    expect(after[0]?.id).toBe('pw-znizka')
  })
})

describe('GET /api/polish-words', () => {
  it('serves parsed cards, schema-valid', async () => {
    const r = await env.get('/api/polish-words')
    expect(r.status).toBe(200)
    const parsed = PolishWordsResponse.parse(r.json)
    expect(parsed.words.length).toBeGreaterThanOrEqual(1)
    expect(parsed.words.every((w) => w.id.startsWith('pw-'))).toBe(true)
  })

  it('garbage or empty file → 200 with empty list', async () => {
    for (const content of ['||| мусор |||\nне списковая строка\n- | | | (added: )\n', '']) {
      writeFileSync(env.paths.polishWordsPath, content, 'utf8')
      const r = await env.get('/api/polish-words')
      expect(r.status).toBe(200)
      expect(PolishWordsResponse.parse(r.json).words).toEqual([])
    }
  })
})
