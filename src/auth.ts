import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Static bearer token check. Both sides are hashed before comparison so
 * timingSafeEqual gets equal-length buffers and the comparison leaks
 * neither content nor length.
 */
export function isAuthorized(authorizationHeader: string | undefined, token: string): boolean {
  if (authorizationHeader === undefined) return false
  if (!authorizationHeader.startsWith('Bearer ')) return false
  const presented = authorizationHeader.slice('Bearer '.length)
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(token, 'utf8').digest()
  return timingSafeEqual(a, b)
}
