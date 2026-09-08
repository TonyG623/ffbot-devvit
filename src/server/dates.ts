/**
 * Date/thread-zone helpers. Port of the module-level date block and
 * `get_thread_zone` from post_daily_threads.py.
 *
 * The Python used `pytz.timezone('US/Central')`; here the timezone is a
 * subreddit setting so the app is not hardcoded to one community's clock.
 */

export type ThreadDate = {
  /** "09/08/2026" */
  date: string
  /** "Mon" */
  day: string
  /** "monday" */
  dayFull: string
  /** Local hour 0-23, BEFORE any rollover adjustment. */
  hour: number
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const WEEKDAY_LONG = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const

/** Read the wall-clock parts of `at` as seen in `timeZone`. */
function partsIn(
  at: Date,
  timeZone: string,
): {year: number; month: number; day: number; hour: number} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(at)) parts[p.type] = p.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl can emit "24" for midnight in some locales/engines.
    hour: Number(parts.hour) % 24,
  }
}

/**
 * Compute the date FFBot should stamp on today's threads.
 *
 * Mirrors the Python: before `rolloverHour` local time, the bot is still
 * working on the previous day's threads, so the date rolls back one day while
 * the hour used for the thread zone stays as-is.
 */
export function threadDate(
  now: Date,
  timeZone: string,
  rolloverHour: number,
): ThreadDate {
  const local = partsIn(now, timeZone)
  // Anchor at noon UTC so the -1 day step cannot skip across a DST boundary.
  const anchor = Date.UTC(local.year, local.month - 1, local.day, 12)
  const shifted = new Date(
    local.hour < rolloverHour ? anchor - 24 * 60 * 60 * 1000 : anchor,
  )

  const y = shifted.getUTCFullYear()
  const m = shifted.getUTCMonth() + 1
  const d = shifted.getUTCDate()
  const dow = shifted.getUTCDay()

  return {
    date: `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`,
    day: WEEKDAY_SHORT[dow] as string,
    dayFull: WEEKDAY_LONG[dow] as string,
    hour: local.hour,
  }
}

/**
 * "Morning "/"Afternoon "/"Evening " prefix, or "" for one post per day.
 * Port of get_thread_zone; the caller trims it, as the Python did.
 */
export function threadZone(postsPerDay: number, hour: number): string {
  if (postsPerDay === 3) {
    if (hour >= 6 && hour < 11) return 'Morning '
    if (hour >= 11 && hour < 18) return 'Afternoon '
    return 'Evening '
  }
  if (postsPerDay === 2) {
    return hour >= 8 && hour < 16 ? 'Morning ' : 'Evening '
  }
  return ''
}

/** Port of get_days_since_monday(): 7 on Monday, else days back to Monday. */
export function daysSinceMonday(now: Date, timeZone: string): number {
  const {year, month, day} = partsIn(now, timeZone)
  const dow = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()
  // Python weekday(): Monday == 0. JS getUTCDay(): Sunday == 0.
  const pyWeekday = (dow + 6) % 7
  return pyWeekday === 0 ? 7 : pyWeekday + 1
}

/** Collapse runs of whitespace, matching `re.sub(r'\s+', ' ', title)`. */
export function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
