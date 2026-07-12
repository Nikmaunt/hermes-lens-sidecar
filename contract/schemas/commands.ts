// The block below is a VERBATIM mirror of the sidecar's
// contract/schemas/commands.ts — do not reformat or "improve" it here;
// change it in lockstep with the sidecar or not at all.
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
// End of the verbatim mirror. Inferred types below follow the local
// schema-file convention.
//
// Enum decisions (documented outside the mirror so the block stays verbatim):
// every enum above is CLOSED. CommandRequest.type is a request enum (new
// command types deploy client-first; a 400 from an older sidecar is correct).
// CommandAccepted.status (ok|duplicate) and CommandStatus.state
// (pending|running|done|error) are protocol state machines the queue and the
// lifecycle UI branch on. CommandStatus.type and result.kind only echo
// command types the client itself queued, so client-first deployment
// guarantees the app knows every value it can see back.

export type AdhocDigestPayload = z.infer<typeof AdhocDigestPayload>
export type CreatePersonNotePayload = z.infer<typeof CreatePersonNotePayload>
export type CommandRequest = z.infer<typeof CommandRequest>
export type CommandAccepted = z.infer<typeof CommandAccepted>
export type CommandStatus = z.infer<typeof CommandStatus>
export type CommandsResponse = z.infer<typeof CommandsResponse>
export type CommandType = CommandStatus['type']
export type CommandState = CommandStatus['state']
