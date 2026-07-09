import { z } from 'zod'
import { Id, IsoDateTime } from './common'

/*
 * Chat with the Hermes agent (Release A).
 *
 * DECISION / deliberate exception to the app's enum-first convention: the
 * sidecar endpoint shipped to prod *before* this schema existed, so the source
 * of truth for these shapes is the LIVE contract the server already serves
 * (verified with curl), not this file. Everything below mirrors what the
 * deployed sidecar actually sends and accepts — see schemas/chat.test.ts for
 * the verbatim prod fixtures. Evolve additively only.
 *
 * Flow: POST /api/chat starts (or, by clientId, dedups) a turn and returns a
 * running jobId; GET /api/chat/{jobId} is polled until status leaves "running".
 * The agent thinks 30–120s and replies in one shot (no streaming); the job
 * lives ~10 min server-side (TTL) before a poll 404s.
 */

/** The three states the sidecar reports for a chat turn. */
export const ChatStatus = z.enum(['running', 'done', 'error'])
export type ChatStatus = z.infer<typeof ChatStatus>

/** POST /api/chat — start, or (by clientId) dedup, a turn. */
export const ChatStartRequest = z.object({
  message: z.string().min(1),
  /**
   * Client-generated id, stable across retries of the same turn. A replay with
   * the same clientId returns the same jobId (server dedup) and does not start
   * a second turn — the idempotency key for inline retry (D-A8).
   */
  clientId: z.string().min(1),
  /** Continues the rolling session; omitted on the very first turn (D-A7). */
  sessionId: Id.optional(),
})
export type ChatStartRequest = z.infer<typeof ChatStartRequest>

/** POST /api/chat response — the turn is accepted and running. */
export const ChatStartResponse = z.object({
  jobId: Id,
  sessionId: Id,
  status: ChatStatus,
})
export type ChatStartResponse = z.infer<typeof ChatStartResponse>

/** GET /api/chat/{jobId} response — one poll of a turn. */
export const ChatJobResponse = z.object({
  jobId: Id,
  status: ChatStatus,
  /** The agent's full answer; present only once status is "done". */
  reply: z.string().optional(),
  /** Failure detail; present only once status is "error". */
  error: z.string().optional(),
  /** Finish time; present on the terminal (done/error) response. */
  finishedAt: IsoDateTime.optional(),
  /** Token spend for the turn (a small cost meter); present once the agent ran. */
  tokensUsed: z.int().optional(),
})
export type ChatJobResponse = z.infer<typeof ChatJobResponse>
