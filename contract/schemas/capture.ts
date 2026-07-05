import { z } from 'zod'
import { Id, IsoDateTime } from './common'

export const CaptureRequest = z.object({
  text: z.string().min(1),
  tags: z.array(z.string()),
  /**
   * Client-generated id, stable across retries of the same capture (additive,
   * optional). Lets the server deduplicate offline-queue replays — see the
   * Idempotency section of API-CONTRACT.md.
   */
  clientId: z.string().min(1).optional(),
})
export type CaptureRequest = z.infer<typeof CaptureRequest>

export const CaptureResponse = z.object({
  status: z.literal('ok'),
  id: Id,
  capturedAt: IsoDateTime,
})
export type CaptureResponse = z.infer<typeof CaptureResponse>
