import { z } from 'zod'
import { Id, IsoDate, IsoDateTime } from './common'

export const Agreement = z.object({
  id: Id,
  text: z.string(),
  madeOn: IsoDate,
  status: z.enum(['open', 'done']),
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
