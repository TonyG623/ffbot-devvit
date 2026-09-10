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

/**
 * Reddit reports removed/deleted accounts under this name. PRAW gave the
 * Python `None` here, which made every `author.name` access raise inside a
 * bare `except: pass`, so deleted authors silently dropped out of the counts.
 * Devvit hands back the literal string instead, which is TRUTHY — so without
 * this check "[deleted]" climbs the leaderboards as if it were a real user.
 */
export const DELETED_AUTHOR = '[deleted]'

export function isRealAuthor(name: string): boolean {
  return !!name && name !== DELETED_AUTHOR
}

/** One comment as read by the reconciliation walk, top-level or direct reply. */
export type WalkedComment = {
  commentId: string
  /** `t3_…` for a top-level comment, `t1_…` for a direct reply. */
  parentId: string
  authorName: string
  body: string
  permalink: string
  createdAtMs: number
  removed: boolean
  isTopLevel: boolean
}

export type WalkResult = {
  /** Everything read this pass, for folding into the incremental counters. */
  comments: WalkedComment[]
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
  /**
   * Every comment that met the unanswered rule, INCLUDING ones whose author is
   * deleted. The Python renders rows from a list that drops deleted authors but
   * computes "% helped" from one that keeps them, so the two genuinely differ.
   */
  unansweredTotal: number
  /** Authors already listed as unanswered; the Python lists each author once. */
  seenAuthors: Set<string>
}

export function emptyAccumulation(): Accumulation {
  return {
    substantive: {},
    allReplies: {},
    unanswered: [],
    topLevelSeen: 0,
    unansweredTotal: 0,
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
    const substantive = reply.body.length > SUBSTANTIVE_REPLY_LENGTH
    // A long reply answers the question whoever wrote it, so this counter runs
    // before the author check — the Python's length test never touched .author.
    if (substantive) substantiveReplies++
    if (!isRealAuthor(reply.authorName)) continue
    bump(acc.allReplies, reply.authorName)
    if (substantive) bump(acc.substantive, reply.authorName)
  }

  if (substantiveReplies > UNANSWERED_MAX || c.removed) return

  // Counted for the "% helped" figure even when the author is gone...
  if (!isRealAuthor(c.authorName)) {
    acc.unansweredTotal++
    return
  }
  if (!acc.seenAuthors.has(c.authorName)) {
    // ...but only a real author gets a row in the table.
    acc.unansweredTotal++
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
  const comments: WalkedComment[] = []
  let topLevelSeen = 0
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
    topLevelSeen++

    comments.push({
      commentId: comment.id,
      parentId: comment.parentId,
      authorName: comment.authorName,
      body: comment.body ?? '',
      permalink: comment.permalink,
      createdAtMs: comment.createdAt.getTime(),
      removed: comment.removed,
      isTopLevel: true,
    })

    try {
      for (const reply of await comment.replies.all()) {
        comments.push({
          commentId: reply.id,
          parentId: comment.id,
          authorName: reply.authorName,
          body: reply.body ?? '',
          permalink: reply.permalink,
          createdAtMs: reply.createdAt.getTime(),
          removed: reply.removed,
          isTopLevel: false,
        })
      }
    } catch (err) {
      console.warn(
        `WARN: could not read replies for ${comment.id}: ${String(err)}`,
      )
    }
  }

  return {comments, topLevelSeen, partial}
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
    allCount: {},
    unanswered: [],
    topLevelSeen: 0,
    unansweredTotal: 0,
    partial: false,
  }
}
