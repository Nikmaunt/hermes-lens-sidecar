import { z } from 'zod'
import { Id } from './common'

export const SearchResultKind = z.enum([
  'memory',
  'people',
  'projects',
  'decisions',
  'timeline',
  'documents',
  'inbox',
])
export type SearchResultKind = z.infer<typeof SearchResultKind>

export const SearchResult = z.object({
  id: Id,
  title: z.string(),
  /** Empty for sensitive results — the server must not leak the content. */
  snippet: z.string(),
  /** True when the underlying item is sensitivity-protected; the UI masks it. */
  sensitive: z.boolean(),
})
export type SearchResult = z.infer<typeof SearchResult>

export const SearchResultGroup = z.object({
  kind: SearchResultKind,
  results: z.array(SearchResult),
})
export type SearchResultGroup = z.infer<typeof SearchResultGroup>

export const SearchResponse = z.object({
  query: z.string(),
  groups: z.array(SearchResultGroup), // only non-empty groups
})
export type SearchResponse = z.infer<typeof SearchResponse>
