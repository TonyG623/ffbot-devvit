/**
 * Markdown table builders. Pure functions — no Reddit client, no Redis — so
 * the exact output can be unit tested against the Python original.
 *
 * Ports of calculate_leader_index, calculate_overall_leader_index and
 * create_unanswered_index from post_daily_threads.py.
 */

import type {ThreadAccumulator, UnansweredRow} from '../shared/types.ts'
import {fillRowCounts} from './comments.ts'

/**
 * Replicates Python's `list.sort()` then `.reverse()` over
 * (helpedHere, helpedAll, createdSort, author, permalink) tuples: a plain
 * descending lexicographic ordering across the tuple.
 */
export function compareUnanswered(a: UnansweredRow, b: UnansweredRow): number {
  if (a.helpedHere !== b.helpedHere) return b.helpedHere - a.helpedHere
  if (a.helpedAll !== b.helpedAll) return b.helpedAll - a.helpedAll
  if (a.createdSort !== b.createdSort) return b.createdSort - a.createdSort
  if (a.author !== b.author) return a.author < b.author ? 1 : -1
  if (a.permalink !== b.permalink) return a.permalink < b.permalink ? 1 : -1
  return 0
}

/** Sort a `Record<user, count>` into descending (count, user) pairs. */
function rankUsers(counts: Record<string, number>): [string, number][] {
  const pairs: [string, number][] = Object.entries(counts)
  pairs.sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1]
    return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0
  })
  return pairs
}

/**
 * Port of calculate_leader_index.
 *
 * Takes the thread's UNFILTERED reply counts. The Python builds this table
 * straight from `reply.author.name` with no length test, unlike the identically
 * named "# Helped in thread" COLUMN in the unanswered table below, which is
 * length filtered. Two tables, same header, different numbers.
 */
export function leaderTable(
  allCount: Record<string, number>,
  limit = 5,
): string {
  let table =
    '\n----\n**The following users have helped the most people in this thread:**'
  table += '\n\nUser | # Helped in thread\n-------|:-----:'
  for (const [user, count] of rankUsers(allCount).slice(0, limit)) {
    table += `\n${user}|${count}`
  }
  return table
}

/**
 * Port of calculate_overall_leader_index.
 *
 * NOTE: the Python version builds this table from a `defaultdict(int)` that is
 * created empty and never populated, so upstream it always renders as a bare
 * header with no rows. This version accepts the real cross-thread counts. Pass
 * `{}` to reproduce the original (empty) behaviour exactly.
 */
export function overallLeaderTable(
  helpCountAll: Record<string, number>,
  limit = 10,
): string {
  let table =
    '\n----\n**The following users have helped the most people in all of the threads:**'
  table += '\n\nUser | # Helped in thread\n-------|:-----:'
  for (const [user, count] of rankUsers(helpCountAll).slice(0, limit)) {
    table += `\n${user}|${count}`
  }
  return table
}

export type UnansweredTableOptions = {
  rows: UnansweredRow[]
  /** Total top-level comments on the thread, the "% helped" denominator. */
  topLevelCount: number
  /**
   * Unanswered comments INCLUDING ones whose author is deleted. Defaults to
   * `rows.length`. The Python's percentage counts deleted-author comments that
   * never appear as rows, so the two are not the same number.
   */
  unansweredTotal?: number
  length: number
  /** Include the explanatory preamble (false for the compact index copy). */
  text: boolean
  showPercents: boolean
}

/** Port of create_unanswered_index. Returns "" when there is nothing to list. */
export function unansweredTable(opts: UnansweredTableOptions): string {
  const {rows, topLevelCount, length, text, showPercents} = opts
  const unansweredTotal = opts.unansweredTotal ?? rows.length

  let table = '\n\n-------------\n\n'
  if (text) {
    table +=
      '**The following posts have less than two replies in this thread. Please respond directly to the OP or the Bot will not pick up your comment. Please provide quality replies, short answers will be ignored.** \n\n **Would you like your post to be at the top of the list? Remember that the table is sorted by those that have helped the most other users.** \n\n'
  }
  table +=
    '\n\nUser | # Helped in thread | # Helped in all threads | Direct Link'
  table += '\n----|:-----:|:-----:|----'

  const percentAnswered =
    topLevelCount > 0
      ? Math.trunc((1 - unansweredTotal / topLevelCount) * 100)
      : 100

  const sorted = [...rows].sort(compareUnanswered)
  if (sorted.length === 0) return ''

  for (const row of sorted.slice(0, length)) {
    table += `\n${row.author} | ${row.helpedHere} | ${row.helpedAll} | [Comment](${row.permalink})`
  }
  if (sorted.length > length) {
    table += `\n**and ${sorted.length - length} others.**| | `
  }
  table += '\n\n^(This table will be updated every ~15 minutes.)'
  if (showPercents) {
    table += `\n\n**${percentAnswered}% of users have been helped in this thread**`
  }
  return table
}

/**
 * Build a thread's published body. Pure, and exported, so the wiring of the
 * three counters to the two tables is unit tested — that wiring is the whole
 * bug surface here, and getting it wrong is invisible in review but wrong on
 * every thread:
 *
 *   acc.allCount      unfiltered, this thread   -> leaderboard
 *   acc.helpCount     filtered, this thread     -> "# Helped in thread" column
 *   helpCountAll      unfiltered, all threads   -> "# Helped in all threads"
 */
export function composeThreadBody(
  wikiBody: string,
  acc: ThreadAccumulator,
  helpCountAll: Record<string, number>,
): string {
  const rows = fillRowCounts(acc.unanswered, acc.helpCount, helpCountAll)
  let body = wikiBody
  body += leaderTable(acc.allCount)
  body += unansweredTable({
    rows,
    topLevelCount: acc.topLevelSeen,
    unansweredTotal: acc.unansweredTotal,
    length: 40,
    text: true,
    showPercents: false,
  })
  return body
}
