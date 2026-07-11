import { z } from 'zod'

export const AdhocDigestPayload = z.object({
  topic: z.string().min(1).max(500),
})
export const CreatePersonNotePayload = z.object({
  target: z.literal('people'),
  person: z.string().min(1).max(120),
  title: z.string().max(120).optional(),
  text: z.string().min(1).max(4096),
})
export const CommandRequest = z.discriminatedUnion('type', [
  z.object({ clientId: z.string().min(8), type: z.literal('adhoc-digest'),
    payload: AdhocDigestPayload }),
  z.object({ clientId: z.string().min(8), type: z.literal('create-note'),
    payload: CreatePersonNotePayload }),
])
export const CommandAccepted = z.object({
  status: z.enum(['ok', 'duplicate']), commandId: z.string(),
})
export const CommandStatus = z.object({
  commandId: z.string(), type: z.enum(['adhoc-digest', 'create-note']),
  requestedAt: z.string(),
  state: z.enum(['pending', 'running', 'done', 'error']),
  summary: z.string().optional(),
  result: z.object({ kind: z.enum(['brief', 'note']), id: z.string() }).optional(),
})
export const CommandsResponse = z.object({
  items: z.array(CommandStatus), generatedAt: z.string(),
})
