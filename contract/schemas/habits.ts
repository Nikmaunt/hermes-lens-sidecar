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
