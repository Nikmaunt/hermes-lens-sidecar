import { z } from 'zod'
import { Id, IsoDate } from './common'

export const PolishWord = z.object({
  id: Id,
  word: z.string(),
  translation: z.string(), // English translation
  example: z.string().nullable(),
  addedOn: IsoDate,
  tags: z.array(z.string()),
})
export type PolishWord = z.infer<typeof PolishWord>

export const PolishWordsResponse = z.object({
  words: z.array(PolishWord),
})
export type PolishWordsResponse = z.infer<typeof PolishWordsResponse>
