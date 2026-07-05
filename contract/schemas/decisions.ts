import { z } from 'zod'
import { Id, IsoDate } from './common'

export const Decision = z.object({
  id: Id,
  title: z.string(),
  decidedOn: IsoDate,
  context: z.string(),
  reasoning: z.string(),
  alternatives: z.array(z.string()),
  projectId: Id.nullable(),
  revisitBy: IsoDate.nullable(),
})
export type Decision = z.infer<typeof Decision>

export const DecisionsResponse = z.object({
  decisions: z.array(Decision),
})
export type DecisionsResponse = z.infer<typeof DecisionsResponse>
