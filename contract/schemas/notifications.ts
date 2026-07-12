import { z } from 'zod'

/*
 * Notification listener capture contract, spoken by both the web layer and
 * the shipped native listener service (HermesNotificationListenerService).
 * The two declarations below are a VERBATIM copy shared with the sidecar,
 * which keeps an identical mirror of this schema — any change must land in
 * both places or replays will be rejected.
 *
 * Enum decision (kept out of the verbatim block): status (ok|duplicate) is a
 * CLOSED protocol enum — the offline queue branches on it, so an unknown
 * value must fail loudly, not silently pick a branch.
 */

export const NotificationCaptureRequest = z.object({
  clientId: z.string().min(8),
  package: z.string().min(1).max(100),
  postedAt: z.string(), // ISO8601
  capturedAt: z.string(), // ISO8601
  title: z.string().max(300),
  text: z.string().max(4096),
  bigText: z.string().max(4096).optional(),
})

export const NotificationCaptureResponse = z.object({
  status: z.enum(['ok', 'duplicate']),
  itemId: z.string(),
})

export type NotificationCaptureRequest = z.infer<typeof NotificationCaptureRequest>
export type NotificationCaptureResponse = z.infer<typeof NotificationCaptureResponse>
