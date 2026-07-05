import { createHash } from 'node:crypto'

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function shortHash(input: string, len = 12): string {
  return sha256Hex(input).slice(0, len)
}
