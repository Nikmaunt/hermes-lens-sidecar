import { z } from 'zod'

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
