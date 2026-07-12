import { z } from 'zod'
import { Id, IsoDate, IsoDateTime } from './common'

export const Agreement = z.object({
  id: Id,
  text: z.string(),
  madeOn: IsoDate,
  /**
   * OPEN enum fallback, fail-visible: an unknown status from a newer server
   * keeps the agreement shown as still open (no strike-through) rather than
   * failing the People screen or hiding a possibly live commitment.
   */
  status: z.enum(['open', 'done']).catch('open'),
})
export type Agreement = z.infer<typeof Agreement>

export const Person = z.object({
  id: Id,
  name: z.string(),
  relation: z.string(), // e.g. "sister", "landlord", "Spanish tutor"
  context: z.string(),
  preferredLanguage: z.string(), // e.g. "Spanish", "English"
  agreements: z.array(Agreement),
  lastInteraction: z
    .object({
      at: IsoDateTime,
      channel: z.string(), // e.g. "telegram", "in person"
      summary: z.string(),
    })
    .nullable(),
})
export type Person = z.infer<typeof Person>

export const PeopleResponse = z.object({
  people: z.array(Person),
})
export type PeopleResponse = z.infer<typeof PeopleResponse>
