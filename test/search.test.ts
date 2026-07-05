import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryResponse, SearchResponse } from '../contract/schemas/index'
import { buildEnv, type TestEnv } from './helpers/env'

let env: TestEnv

const search = async (q: string) =>
  SearchResponse.parse((await env.get(`/api/search?q=${encodeURIComponent(q)}`)).json)

const group = (r: { groups: { kind: string; results: unknown[] }[] }, kind: string) =>
  r.groups.find((g) => g.kind === kind) as
    | { kind: string; results: { id: string; title: string; snippet: string; sensitive: boolean }[] }
    | undefined

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

describe('search privacy guarantees', () => {
  it('normal memory: matches fact text, snippet included', async () => {
    const r = await search('эспрессо')
    const mem = group(r, 'memory')
    expect(mem).toBeDefined()
    expect(mem?.results[0]?.snippet).toContain('эспрессо')
    expect(mem?.results[0]?.sensitive).toBe(false)
  })

  it('sensitive memory: matched by topic ONLY, empty snippet, sensitive: true', async () => {
    const memory = MemoryResponse.parse((await env.get('/api/memory')).json)
    const coffee = memory.items.find((i) => i.fact.includes('эспрессо'))
    expect(coffee).toBeDefined()
    await env.post(`/api/memory/${coffee?.id}/flag`, { action: 'mark-sensitive' })

    // 'эспрессо' is in the fact but NOT in the topic → no longer matches
    const byFact = await search('эспрессо')
    expect(group(byFact, 'memory')?.results.find((x) => x.id === coffee?.id)).toBeUndefined()

    // topic word still matches, but content is masked
    const byTopic = await search('кофе')
    const hit = group(byTopic, 'memory')?.results.find((x) => x.id === coffee?.id)
    expect(hit).toBeDefined()
    expect(hit?.sensitive).toBe(true)
    expect(hit?.snippet).toBe('')
    expect(hit?.title).toBe(coffee?.topic)
  })

  it('timeline group: session titles match…', async () => {
    const r = await search('бюджета поездки')
    const tl = group(r, 'timeline')
    expect(tl?.results.map((x) => x.id)).toContain('sess-s-today')
  })

  it('…cron job names match…', async () => {
    const r = await search('Inbox triage')
    expect(group(r, 'timeline')?.results.map((x) => x.id)).toContain('cron-inbox-triage')
  })

  it('…but raw message bodies NEVER match (fts stays untouched in v1)', async () => {
    // SECRETWORD-XYZ exists only inside messages.content in state.db
    const r = await search('SECRETWORD')
    expect(r.groups).toEqual([])
  })

  it('documents and inbox groups work', async () => {
    expect(group(await search('Spotify'), 'documents')).toBeDefined()
    expect(group(await search('поезд'), 'inbox')).toBeDefined()
  })

  it('empty query → empty groups', async () => {
    const r = await search('')
    expect(r.groups).toEqual([])
  })
})
