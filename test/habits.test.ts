import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HabitsResponse, HabitTickResponse, TimelineResponse } from '../contract/schemas/index'
import { createLogger } from '../src/lib/log.js'
import { readHabits } from '../src/readers/habits.js'
import { buildEnv, fixturePath, type TestEnv } from './helpers/env'

let env: TestEnv

beforeAll(async () => {
  env = await buildEnv()
})
afterAll(async () => {
  await env.close()
})

const silentLog = createLogger(() => {})

describe('habits.md parser', () => {
  it('one block per habit: translit id, icon, startedOn, deduped ascending dates', () => {
    const habits = readHabits(fixturePath('vault', 'habits.md'), silentLog)
    const zaryadka = habits.find((h) => h.name === 'Зарядка')
    expect(zaryadka).toMatchObject({
      id: 'hab-zaryadka',
      icon: '💪',
      startedOn: '2026-05-01',
      completedDates: ['2026-06-30', '2026-07-01', '2026-07-03'],
    })
    // duplicates collapse, invalid dates drop, order is ascending
    const polish = habits.find((h) => h.name === 'Испанский язык')
    expect(polish?.id).toBe('hab-ispanskiy-yazyk')
    expect(polish?.completedDates).toEqual(['2026-07-01', '2026-07-02'])
  })

  it('missing начал falls back to the earliest отметка; missing icon → empty string', () => {
    const habits = readHabits(fixturePath('vault', 'habits.md'), silentLog)
    const noStart = habits.find((h) => h.name === 'Без начала')
    expect(noStart).toMatchObject({ icon: '', startedOn: '2026-07-04', completedDates: ['2026-07-04'] })
  })
})

describe('POST /api/habits/{id}/tick', () => {
  it('queues a habit-tick file carrying the verbatim habit name', async () => {
    const r = await env.post('/api/habits/hab-zaryadka/tick', { date: '2026-07-04' })
    expect(r.status).toBe(200)
    expect(HabitTickResponse.parse(r.json)).toEqual({ status: 'ok', itemId: 'hab-zaryadka' })

    const files = env.listQueueFiles().filter((f) => f.includes('-habit-tick-hab-zaryadka'))
    expect(files).toHaveLength(1)
    const queued = JSON.parse(
      readFileSync(`${env.paths.lensQueueDir}/${files[0]}`, 'utf8'),
    ) as Record<string, unknown>
    expect(queued).toMatchObject({
      type: 'habit-tick',
      habitId: 'hab-zaryadka',
      habitName: 'Зарядка',
      date: '2026-07-04',
    })
    expect(typeof queued.requestedAt).toBe('string')
  })

  it('overlay: the pending date is already inside completedDates, in order', async () => {
    const habits = HabitsResponse.parse((await env.get('/api/habits')).json)
    const zaryadka = habits.habits.find((h) => h.id === 'hab-zaryadka')
    expect(zaryadka?.completedDates).toEqual(['2026-06-30', '2026-07-01', '2026-07-03', '2026-07-04'])
  })

  it('replaying the same date → same success, still one queue file', async () => {
    const repeat = await env.post('/api/habits/hab-zaryadka/tick', { date: '2026-07-04' })
    expect(repeat.status).toBe(200)
    expect(repeat.json).toEqual({ status: 'ok', itemId: 'hab-zaryadka' })
    expect(env.listQueueFiles().filter((f) => f.includes('-habit-tick-hab-zaryadka'))).toHaveLength(1)
  })

  it('a date already recorded in habits.md → success WITHOUT a queue file (union idempotency)', async () => {
    const r = await env.post('/api/habits/hab-ispanskiy-yazyk/tick', { date: '2026-07-02' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ status: 'ok', itemId: 'hab-ispanskiy-yazyk' })
    expect(env.listQueueFiles().filter((f) => f.includes('-habit-tick-hab-ispanskiy'))).toHaveLength(0)
  })

  it('tick lands in /api/timeline with category habit', async () => {
    const t = TimelineResponse.parse((await env.get('/api/timeline')).json)
    const ev = t.events.find((e) => e.title === 'Habit tick queued')
    expect(ev).toBeDefined()
    expect(ev?.category).toBe('habit')
  })

  it('invalid or missing date → 400; unknown habit → 200 gone', async () => {
    for (const body of [{}, { date: 'вчера' }, { date: '2026-02-30' }]) {
      expect((await env.post('/api/habits/hab-zaryadka/tick', body)).status).toBe(400)
    }
    const gone = await env.post('/api/habits/hab-net-takogo/tick', { date: '2026-07-04' })
    expect(gone.status).toBe(200)
    expect(HabitTickResponse.parse(gone.json)).toEqual({ status: 'gone', itemId: 'hab-net-takogo' })
    expect(env.listQueueFiles().filter((f) => f.includes('hab-net-takogo'))).toHaveLength(0)
  })
})

describe('habits degradation', () => {
  it('garbage or empty habits.md → 200 with empty list', async () => {
    const original = readFileSync(env.paths.habitsPath, 'utf8')
    for (const content of [']]] не markdown\n- отметки: сироты без заголовка\n', '']) {
      writeFileSync(env.paths.habitsPath, content, 'utf8')
      const r = await env.get('/api/habits')
      expect(r.status).toBe(200)
      expect(HabitsResponse.parse(r.json).habits).toEqual([])
    }
    writeFileSync(env.paths.habitsPath, original, 'utf8')
  })

  it('the bearer token never appears in any log line (tick paths included)', () => {
    expect(env.logs.join('\n')).not.toContain(env.token)
  })
})
