/**
 * Comment walking. Ports get_unanswered_comments, get_comment_replies,
 * get_numbered_helped and get_overall_help_count from common.py /
 * post_daily_threads.py.
 *
 * IMPORTANT FIDELITY NOTE — the Python keeps TWO different reply counts and
 * they are not interchangeable:
 *
 *   - `substantive` (reply.body length > 20) feeds get_comment_replies, which
 *     produces the "# Helped in thread" column and the unanswered threshold.
 *   - `allReplies` (no length filter) feeds calculate_leader_index and
 *     get_overall_help_count, which produce the leaderboard tables and the
 *     "# Helped in all threads" column.
 *
 * Collapsing them into one counter changes the published numbers, so both are
 * tracked here.
 */
import {reddit} from '@devvit/web/server'
import type {ThreadAccumulator, UnansweredRow} from '../shared/types.ts'

/** Minimum reply length the Python treats as a real answer. */
export const SUBSTANTIVE_REPLY_LENGTH = 20

/** A top-level comment with `<= UNANSWERED_MAX` substantive replies is "unanswered". */
export const UNANSWERED_MAX = 1

export type WalkResult = {
  /** Length-filtered per-author counts (the "# Helped in thread" column). */
  substantive: Record<string, number>
  /** Unfiltered per-author counts (leaderboards, "# Helped in all threads"). */
  allReplies: Record<string, number>
  unanswered: UnansweredRow[]
  topLevelSeen: number
  /** True when the time budget ran out before the listing was exhausted. */
  partial: boolean
}

/**
 * A top-level comment reduced to just what the counting rules look at.
 * Decoupled from Devvit's Comment class so the rules can be tested against
 * captured real-world data.
 */
export type RawComment = {
  authorName: string
  removed: boolean
  createdAtMs: number
  permalink: string
  replies: {authorName: string; body: string}[]
}

export type Accumulation = {
  substantive: Record<string, number>
  allReplies: Record<string, number>
  unanswered: UnansweredRow[]
  topLevelSeen: number
  /** Authors already listed as unanswered; the Python lists each author once. */
  seenAuthors: Set<string>
}

export function emptyAccumulation(): Accumulation {
  return {
    substantive: {},
    allReplies: {},
    unanswered: [],
    topLevelSeen: 0,
    seenAuthors: new Set(),
  }
}

function bump(counts: Record<string, number>, author: string): void {
  counts[author] = (counts[author] ?? 0) + 1
}

/**
 * Apply the counting rules for ONE top-level comment. Pure apart from mutating
 * `acc`. This is the heart of the port — see the fidelity note above for why
 * two separate counters are maintained.
 */
export function accumulateComment(acc: Accumulation, c: RawComment): void {
  acc.topLevelSeen++

  let substantiveReplies = 0
  for (const reply of c.replies) {
    if (!reply.authorName) continue
    bump(acc.allReplies, reply.authorName)
    if (reply.body.length > SUBSTANTIVE_REPLY_LENGTH) {
      substantiveReplies++
      bump(acc.substantive, reply.authorName)
    }
  }

  if (
    substantiveReplies <= UNANSWERED_MAX &&
    !c.removed &&
    c.authorName &&
    !acc.seenAuthors.has(c.authorName)
  ) {
    acc.seenAuthors.add(c.authorName)
    acc.unanswered.push({
      author: c.authorName,
      // Filled in by the caller once both counters are complete.
      helpedHere: 0,
      helpedAll: 0,
      createdSort: -Math.trunc(c.createdAtMs / 1000),
      permalink: c.permalink,
    })
  }
}

/** Convenience wrapper over accumulateComment for a whole list. */
export function accumulate(comments: RawComment[]): Accumulation {
  const acc = emptyAccumulation()
  for (const c of comments) accumulateComment(acc, c)
  return acc
}

/**
 * Walk a post's top-level comments and their direct replies, stopping when
 * `deadline` passes.
 *
 * `skip` lets a chained job resume where the previous one stopped. Resuming
 * re-reads the skipped pages, so it costs API calls but keeps the counts
 * correct; if threads routinely need more than one pass, move to the
 * trigger-driven accumulator described in the README instead.
 */
export async function walkThread(
  postId: string,
  deadline: number,
  skip = 0,
): Promise<WalkResult> {
  const acc = emptyAccumulation()
  let partial = false

  const post = await reddit.getPostById(postId as `t3_${string}`)
  let index = 0

  for await (const comment of post.comments) {
    index++
    if (index <= skip) continue

    if (Date.now() > deadline) {
      partial = true
      break
    }

    let replies: {authorName: string; body: string}[] = []
    try {
      const list = await comment.replies.all()
      replies = list.map(r => ({authorName: r.authorName, body: r.body ?? ''}))
    } catch (err) {
      console.warn(`WARN: could not read replies for ${comment.id}: ${String(err)}`)
    }

    accumulateComment(acc, {
      authorName: comment.authorName,
      removed: comment.removed,
      createdAtMs: comment.createdAt.getTime(),
      permalink: comment.permalink,
      replies,
    })
  }

  return {
    substantive: acc.substantive,
    allReplies: acc.allReplies,
    unanswered: acc.unanswered,
    topLevelSeen: acc.topLevelSeen,
    partial,
  }
}

/** Merge counts from `src` into `dst` in place. */
export function mergeCounts(
  dst: Record<string, number>,
  src: Record<string, number>,
): void {
  for (const [user, count] of Object.entries(src)) {
    dst[user] = (dst[user] ?? 0) + count
  }
}

/**
 * Fill in the two count columns on each unanswered row, now that the whole
 * thread (and every earlier thread in the run) has been counted.
 */
export function fillRowCounts(
  rows: UnansweredRow[],
  substantiveHere: Record<string, number>,
  allAcrossRun: Record<string, number>,
): UnansweredRow[] {
  return rows.map(row => ({
    ...row,
    helpedHere: substantiveHere[row.author] ?? 0,
    helpedAll: allAcrossRun[row.author] ?? 0,
  }))
}

export function emptyAccumulator(postId: string): ThreadAccumulator {
  return {
    postId,
    helpCount: {},
    unanswered: [],
    topLevelSeen: 0,
    partial: false,
  }
}
