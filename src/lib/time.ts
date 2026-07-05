/**
 * All timestamps the sidecar serves are ISO-8601 with the Europe/Warsaw UTC
 * offset, and every "today" / date-window computation happens in that zone,
 * regardless of the host's TZ setting.
 */

const TZ = 'Europe/Warsaw'

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const offsetFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  timeZoneName: 'longOffset',
})

interface WallClock {
  date: string // YYYY-MM-DD
  time: string // HH:mm:ss
}

function wallClock(d: Date): WallClock {
  const p: Record<string, string> = {}
  for (const part of partsFmt.formatToParts(d)) p[part.type] = part.value
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}:${p.second}`,
  }
}

/** UTC offset in effect in Warsaw at instant `d`, e.g. "+02:00". */
export function warsawOffset(d: Date): string {
  const name = offsetFmt.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const off = name.replace('GMT', '')
  return off === '' ? '+00:00' : off
}

/** e.g. "2026-07-05T14:32:10+02:00" */
export function toWarsawIso(d: Date): string {
  const { date, time } = wallClock(d)
  return `${date}T${time}${warsawOffset(d)}`
}

/** Calendar date in Warsaw, e.g. "2026-07-05". */
export function toWarsawDate(d: Date): string {
  return wallClock(d).date
}

/** "HHmm" in Warsaw, used for capture filenames. */
export function warsawHhmm(d: Date): string {
  return wallClock(d).time.slice(0, 5).replace(':', '')
}

/** "HH:MM" in Warsaw, used for capture frontmatter. */
export function warsawTimeOfDay(d: Date): string {
  return wallClock(d).time.slice(0, 5)
}

/** Warsaw year-month, e.g. "2026-07". */
export function toWarsawMonth(d: Date): string {
  return wallClock(d).date.slice(0, 7)
}

/**
 * Whole calendar days from Warsaw-today until `isoDate` (YYYY-MM-DD).
 * Negative = past, 0 = today.
 */
export function daysUntil(isoDate: string, now: Date): number {
  const today = toWarsawDate(now)
  const a = Date.parse(`${today}T00:00:00Z`)
  const b = Date.parse(`${isoDate}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/** Milliseconds since epoch, or null when the string is not parseable. */
export function parseIsoMs(s: string): number | null {
  const ms = Date.parse(s)
  return Number.isNaN(ms) ? null : ms
}

/** True for ISO-8601 datetimes that carry an explicit offset or Z. */
export function hasUtcOffset(s: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(s)
}
