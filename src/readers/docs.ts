import { listFiles, readTextIfExists } from '../lib/fsread.js'
import { firstString, parseNote } from '../lib/markdown.js'
import { translitSlug } from '../lib/translit.js'
import { parseAmountSpec, type DocumentItemOut } from './vault.js'
import type { Logger } from '../lib/log.js'

/**
 * vault/docs/*.md — one document per file, frontmatter:
 *   title, kind: contract|insurance|id-document, provider,
 *   one of cancel_by | renews_on | valid_until (YYYY-MM-DD),
 *   optionally amount: "2400 PLN/month".
 * valid_until maps onto renewsOn (the contract's "next renewal / expiry
 * date"). Tolerant: unknown kind degrades to contract, bad dates → null,
 * torn frontmatter skips the file (agent mid-write).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function readDocs(docsDir: string, log: Logger): DocumentItemOut[] {
  const out: DocumentItemOut[] = []
  for (const f of listFiles(docsDir, log)) {
    if (!f.name.endsWith('.md') || f.name.startsWith('.')) continue
    const raw = readTextIfExists(f.path, log)
    if (raw === undefined) continue
    const parsed = parseNote(raw)
    if (!parsed.ok) {
      log.warn('doc skipped: unterminated frontmatter', { file: f.name })
      continue
    }
    const fm = parsed.frontmatter
    const str = (key: string): string => (firstString(fm[key]) ?? '').trim()
    const date = (key: string): string | null => (DATE_RE.test(str(key)) ? str(key) : null)

    const base = f.name.replace(/\.md$/, '')
    const kindRaw = str('kind')
    let kind: DocumentItemOut['kind'] = 'contract'
    if (kindRaw === 'contract' || kindRaw === 'insurance' || kindRaw === 'id-document') {
      kind = kindRaw
    } else if (kindRaw !== '') {
      log.warn('doc kind unknown, serving as contract', { file: f.name })
    }
    const { amount, billingPeriod } = parseAmountSpec(str('amount'))
    out.push({
      id: 'doc-' + translitSlug(base, 40),
      title: str('title') !== '' ? str('title') : base,
      kind,
      provider: str('provider'),
      amount,
      billingPeriod,
      renewsOn: date('renews_on') ?? date('valid_until'),
      cancelBy: date('cancel_by'),
      notes: null,
    })
  }
  return out
}
