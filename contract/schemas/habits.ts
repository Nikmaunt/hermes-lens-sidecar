import { z } from 'zod'
import { Id, IsoDate, IsoDateTime } from './common'

export const Habit = z.object({
  id: Id,
  name: z.string(),
  /** Emoji used as the habit icon. */
  icon: z.string(),
  startedOn: IsoDate,
  /** Dates on which the habit was completed (from agent logs), ascending. */
  completedDates: z.array(IsoDate),
})
export type Habit = z.infer<typeof Habit>

export const HabitsResponse = z.object({
  habits: z.array(Habit),
  generatedAt: IsoDateTime,
})
export type HabitsResponse = z.infer<typeof HabitsResponse>

export const HabitTickRequest = z.object({
  date: IsoDate,
})
export type HabitTickRequest = z.infer<typeof HabitTickRequest>

export const HabitTickResponse = z.object({
  /**
   * "ok" = queued (or already recorded); "gone" = the habit no longer
   * exists server-side — the client treats it as success.
   */
  status: z.enum(['ok', 'gone']),
  itemId: Id,
})
export type HabitTickResponse = z.infer<typeof HabitTickResponse>
