/**
 * Cyrillic + Polish → ASCII slugs, matching the transliterated-slug style the
 * agent uses for inbox note filenames.
 */

const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
}

export function translitSlug(text: string, maxLen = 48): string {
  const lower = text.toLowerCase()
  let out = ''
  for (const ch of lower) out += MAP[ch] ?? ch
  const slug = out
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const cut = slug.slice(0, maxLen).replace(/-$/, '')
  return cut === '' ? 'note' : cut
}
