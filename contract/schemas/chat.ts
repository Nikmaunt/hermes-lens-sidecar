import { z } from 'zod'
import { Id, IsoDateTime } from './common'

/**
 * Chat proxy (sidecar job+poll topology). The app POSTs a turn and polls for
 * the reply; the sidecar forwards it to the Hermes agent's OpenAI-compatible
 * server on loopback and hides both the latency and the upstream key.
 *
 * VERBATIM mirror of the future hermes-lens schema — the app repo stays the
 * source of truth. This release introduces the ChatStatus values on the
 * sidecar; the app schema carrying the SAME enum values must ship with or
 * before it (enum-first: a value the app cannot parse would break the client).
 */

/** Lifecycle of a proxied chat turn. */
export const ChatStatus = z.enum(['running', 'done', 'error'])
export type ChatStatus = z.infer<typeof ChatStatus>

export const ChatStartRequest = z.object({
  message: z.string().min(1),
  /** Client-generated, stable across retries — dedups an offline replay. */
  clientId: z.string().min(1),
  /**
   * Continues an existing dialog; omit to start a fresh session. The server
   * echoes the session id it used in ChatStartResponse.
   */
  sessionId: z.string().min(1).optional(),
})
export type ChatStartRequest = z.infer<typeof ChatStartRequest>

/**
 * The turn was accepted and is running in the background — poll
 * GET /api/chat/{jobId} for the outcome. `status` is always "running" here;
 * the real terminal state (done/error) is only ever read from the poll.
 */
export const ChatStartResponse = z.object({
  jobId: Id,
  sessionId: Id,
  status: z.literal('running'),
})
export type ChatStartResponse = z.infer<typeof ChatStartResponse>

export const ChatStatusResponse = z.object({
  jobId: Id,
  status: ChatStatus,
  /** Present only when status is "done". */
  reply: z.string().optional(),
  /** Human-readable, leak-free; present only when status is "error". */
  error: z.string().optional(),
  /** Present once the turn reaches a terminal state (done or error). */
  finishedAt: IsoDateTime.optional(),
  /** usage.total_tokens from the agent, for the future spend meter. */
  tokensUsed: z.int().optional(),
})
export type ChatStatusResponse = z.infer<typeof ChatStatusResponse>
