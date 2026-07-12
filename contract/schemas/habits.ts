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

/**
 * Cancels a still-pending tick for `date` on the same /tick endpoint. A date
 * already written into the habit file (not pending) cannot be undone — the
 * server answers "gone".
 */
export const HabitUndoRequest = z.object({
  date: IsoDate,
  undo: z.literal(true),
})
export type HabitUndoRequest = z.infer<typeof HabitUndoRequest>

export const HabitTickResponse = z.object({
  /**
   * "ok" = queued (or already recorded); "gone" = the habit no longer
   * exists server-side — the client treats it as success.
   * CLOSED enum: protocol status the offline queue branches on — an unknown
   * value must fail loudly, not silently pick a branch.
   */
  status: z.enum(['ok', 'gone']),
  itemId: Id,
})
export type HabitTickResponse = z.infer<typeof HabitTickResponse>
