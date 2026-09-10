/**
 * Incremental comment counters, maintained from the onCommentCreate trigger.
 *
 * WHY THIS EXISTS. The full walk cannot survive the season. Measured against
 * live r/fantasyfootball threads, the Devvit Reddit API rate-limits to roughly
 * 4 requests/second, and the walk needs one request per top-level comment whose
 * replies Reddit truncated (~38% of them). That puts a hard floor of about
 * `topLevelCount / 10` seconds on any walk — 19.6s for a 541-comment thread,
 * and a timeout for anything bigger. Concurrency makes it strictly worse
 * (429 RESOURCE_EXHAUSTED). See HANDOFF.md item 1 for the measurements.
 *
 * So: stop reading threads, and count comments as they arrive instead. The
 * trigger payload carries author, body, parentId and permalink, so maintaining
 * these counters costs ZERO Reddit API calls, and the cost is O(new comments)
 * rather than O(all comments) every fifteen minutes.
 *
 * CONCURRENCY. Comment triggers fire in parallel, so every write here is a
 * single atomic Redis field op (hSetNX / hIncrBy). Nothing does
 * read-modify-write on a shared blob, because that loses updates under load —
 * which is exactly the load a busy thread produces.
 */
import type {ThreadAccumulator, UnansweredRow} from '../shared/types.ts'
import {
  isRealAuthor,
  SUBSTANTIVE_REPLY_LENGTH,
  UNANSWERED_MAX,
} from './comments.ts'

/**
 * The slice of the Redis client this module uses. Declared as an interface,
 * rather than importing the Devvit client directly, so the counting rules can
 * be exercised against an in-memory fake — see comment-counting.test.ts. This
 * is now THE counting path, so it needs the same test rigor the walk had.
 */
export type RedisLike = {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
  del(key: string): Promise<unknown>
  hGet(key: string, field: string): Promise<string | undefined>
  hSet(key: string, values: Record<string, string>): Promise<unknown>
  hSetNX(key: string, field: string, value: string): Promise<number>
  hIncrBy(key: string, field: string, value: number): Promise<number>
  hDel(key: string, fields: string[]): Promise<unknown>
  hGetAll(key: string): Promise<Record<string, string>>
}

/** Counters outlive a run so late edits still land; they are not permanent. */
const TTL_SECONDS = 60 * 60 * 24 * 3

/** True when a comment sits directly under the post rather than under a comment. */
export function isTopLevelParent(parentId: string): boolean {
  return parentId.startsWith('t3_')
}

/** The Python's reply-length test, in one place. */
export function isSubstantive(body: string): boolean {
  return body.length > SUBSTANTIVE_REPLY_LENGTH
}

/** Facts about a top-level comment that never change after it is written. */
type TopLevelFacts = {
  /** author */ a: string
  /** created, seconds */ t: number
  /** permalink */ p: string
}

const keyTracked = (postId: string): string => `ffbot:cc:track:${postId}`
const keyFacts = (postId: string): string => `ffbot:cc:${postId}:facts`
const keySeen = (postId: string): string => `ffbot:cc:${postId}:seen`
const keySubReplies = (postId: string): string =>
  `ffbot:cc:${postId}:subreplies`
const keyRemoved = (postId: string): string => `ffbot:cc:${postId}:removed`
const keySeeded = (postId: string): string => `ffbot:cc:${postId}:seeded`
const keyPending = (postId: string): string => `ffbot:cc:${postId}:pending`
const keyHelp = (postId: string): string => `ffbot:cc:${postId}:help`
const keyAll = (postId: string): string => `ffbot:cc:${postId}:all`

/**
 * Mark a post as one of today's bot threads. The trigger fires for EVERY
 * comment in the subreddit, so this is the cheap gate that ignores the rest.
 */
export async function trackPost(db: RedisLike, postId: string): Promise<void> {
  await db.set(keyTracked(postId), '1')
  await db.expire(keyTracked(postId), TTL_SECONDS)
}

export async function isTracked(
  db: RedisLike,
  postId: string,
): Promise<boolean> {
  return (await db.get(keyTracked(postId))) === '1'
}

/**
 * Claim a comment id, returning true only the first time. Triggers can be
 * delivered more than once and the reconciliation walk deliberately re-reads
 * comments, so every counter update goes through this or it double counts.
 */
async function claim(
  db: RedisLike,
  postId: string,
  commentId: string,
): Promise<boolean> {
  const fresh = await db.hSetNX(keySeen(postId), commentId, '1')
  if (fresh) await db.expire(keySeen(postId), TTL_SECONDS)
  return Boolean(fresh)
}

export type IncomingComment = {
  commentId: string
  postId: string
  parentId: string
  author: string
  body: string
  permalink: string
  createdAtMs: number
  removed?: boolean
}

/**
 * Fold one comment into the counters. Safe to call repeatedly for the same
 * comment: only the first call counts.
 *
 * Returns what it decided, for logging and for the tests.
 */
export async function recordComment(
  db: RedisLike,
  c: IncomingComment,
): Promise<
  'top-level' | 'direct-reply' | 'orphan-reply' | 'deeper-reply' | 'duplicate'
> {
  if (isTopLevelParent(c.parentId)) {
    if (!(await claim(db, c.postId, c.commentId))) return 'duplicate'
    const facts: TopLevelFacts = {
      a: c.author,
      t: Math.trunc(c.createdAtMs / 1000),
      p: c.permalink,
    }
    await db.hSet(keyFacts(c.postId), {
      [c.commentId]: JSON.stringify(facts),
    })
    await db.expire(keyFacts(c.postId), TTL_SECONDS)
    if (c.removed) await markRemoved(db, c.postId, c.commentId)

    // Any replies that arrived BEFORE this comment did can now be applied.
    const rescued = await drainPending(db, c.postId, c.commentId)
    if (rescued > 0) {
      // Worth logging loudly: this is trigger reordering caught in the act,
      // and before the fix every one of these was a silently lost reply.
      console.log(
        `RESCUED ${rescued} out-of-order repl${rescued === 1 ? 'y' : 'ies'} ` +
          `for ${c.commentId}`,
      )
    }
    return 'top-level'
  }

  // A reply. It only counts if its parent is a TOP-LEVEL comment of this post;
  // the Python counted direct replies only, never the whole subtree.
  const parentFacts = await db.hGet(keyFacts(c.postId), c.parentId)
  if (!parentFacts) {
    // The parent is unknown, which means one of two things and we cannot yet
    // tell which: either this is a genuinely deeper reply (ignore it), or its
    // parent's trigger has not arrived yet. TRIGGERS ARE NOT ORDERED — this
    // was observed live, with a reply's event delivered before its parent's.
    //
    // So do NOT claim it. Claiming here would mark it counted while dropping
    // it, and the reconciliation walk would then skip it as a duplicate
    // forever, silently losing the reply. Stash it instead and apply it if the
    // parent turns up. A truly deeper reply just expires with the TTL.
    await db.hSet(keyPending(c.postId), {
      [c.commentId]: JSON.stringify({
        parent: c.parentId,
        author: c.author,
        substantive: isSubstantive(c.body),
      }),
    })
    await db.expire(keyPending(c.postId), TTL_SECONDS)
    return 'orphan-reply'
  }

  if (!(await claim(db, c.postId, c.commentId))) return 'duplicate'
  await applyReply(db, c.postId, c.parentId, c.author, isSubstantive(c.body))
  return 'direct-reply'
}

/** Apply one direct reply's contribution to the three counters. */
async function applyReply(
  db: RedisLike,
  postId: string,
  parentId: string,
  author: string,
  substantive: boolean,
): Promise<void> {
  if (substantive) {
    // Author-independent: a long reply answers the question whoever wrote it.
    await db.hIncrBy(keySubReplies(postId), parentId, 1)
    await db.expire(keySubReplies(postId), TTL_SECONDS)
  }
  if (isRealAuthor(author)) {
    await db.hIncrBy(keyAll(postId), author, 1)
    await db.expire(keyAll(postId), TTL_SECONDS)
    if (substantive) {
      await db.hIncrBy(keyHelp(postId), author, 1)
      await db.expire(keyHelp(postId), TTL_SECONDS)
    }
  }
}

/**
 * Apply replies that arrived before their parent did, now that it exists.
 * Returns how many were rescued, which is worth logging: a non-zero count is
 * direct evidence that trigger delivery is reordering.
 */
async function drainPending(
  db: RedisLike,
  postId: string,
  parentId: string,
): Promise<number> {
  const pending = await db.hGetAll(keyPending(postId))
  if (!pending) return 0

  let rescued = 0
  for (const [commentId, raw] of Object.entries(pending)) {
    let entry: {parent: string; author: string; substantive: boolean}
    try {
      entry = JSON.parse(raw)
    } catch {
      await db.hDel(keyPending(postId), [commentId])
      continue
    }
    if (entry.parent !== parentId) continue

    await db.hDel(keyPending(postId), [commentId])
    if (!(await claim(db, postId, commentId))) continue
    await applyReply(db, postId, parentId, entry.author, entry.substantive)
    rescued++
  }
  return rescued
}

/**
 * Mark a thread as having had at least one COMPLETE reconciliation pass.
 *
 * This is what distinguishes "no comments yet" from "not counted yet", and the
 * two must not be confused: rendering an uncounted thread publishes an empty
 * leaderboard and an empty unanswered table over real content. A thread that is
 * genuinely empty is seeded and has zero counts; a thread that has never been
 * reconciled is not seeded and gets priority for the next repair pass.
 */
export async function markSeeded(db: RedisLike, postId: string): Promise<void> {
  await db.set(keySeeded(postId), '1')
  await db.expire(keySeeded(postId), TTL_SECONDS)
}

export async function isSeeded(
  db: RedisLike,
  postId: string,
): Promise<boolean> {
  return (await db.get(keySeeded(postId))) === '1'
}

/** Flag a top-level comment as removed so it drops off the unanswered table. */
export async function markRemoved(
  db: RedisLike,
  postId: string,
  commentId: string,
): Promise<void> {
  await db.hSet(keyRemoved(postId), {[commentId]: '1'})
  await db.expire(keyRemoved(postId), TTL_SECONDS)
}

/** Clear a removal, for a comment the reconciliation walk finds reinstated. */
export async function clearRemoved(
  db: RedisLike,
  postId: string,
  commentId: string,
): Promise<void> {
  await db.hDel(keyRemoved(postId), [commentId])
}

function parseCounts(raw: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v)
    if (Number.isFinite(n) && n !== 0) out[k] = n
  }
  return out
}

/**
 * Rebuild the accumulator the render step expects, entirely from Redis. No
 * Reddit API calls, so this is not rate limited and does not grow with thread
 * size in wall-clock terms the way the walk did.
 */
export async function readThreadState(
  db: RedisLike,
  postId: string,
): Promise<ThreadAccumulator> {
  const [factsRaw, subRaw, removedRaw, helpRaw, allRaw] = await Promise.all([
    db.hGetAll(keyFacts(postId)),
    db.hGetAll(keySubReplies(postId)),
    db.hGetAll(keyRemoved(postId)),
    db.hGetAll(keyHelp(postId)),
    db.hGetAll(keyAll(postId)),
  ])

  const unanswered: UnansweredRow[] = []
  const seenAuthors = new Set<string>()
  let unansweredTotal = 0
  let topLevelSeen = 0

  // NEWEST FIRST. The bot sets suggested sort to New, so the walk read comments
  // newest-first, and "each author listed once" therefore kept each author's
  // MOST RECENT comment. Sorting the other way silently swaps which permalink
  // lands in the table — verified against the captured thread, whose
  // created_utc values are strictly descending.
  const entries = Object.entries(factsRaw ?? {})
    .map(([id, raw]) => {
      try {
        return {id, facts: JSON.parse(raw) as TopLevelFacts}
      } catch {
        return undefined
      }
    })
    .filter((e): e is {id: string; facts: TopLevelFacts} => e !== undefined)
    .sort((a, b) => b.facts.t - a.facts.t)

  for (const {id, facts} of entries) {
    topLevelSeen++
    if (removedRaw?.[id] === '1') continue
    if (Number(subRaw?.[id] ?? 0) > UNANSWERED_MAX) continue

    if (!isRealAuthor(facts.a)) {
      // Counts toward "% helped" but never gets a row — matches the Python.
      unansweredTotal++
      continue
    }
    if (seenAuthors.has(facts.a)) continue
    seenAuthors.add(facts.a)
    unansweredTotal++
    unanswered.push({
      author: facts.a,
      helpedHere: 0,
      helpedAll: 0,
      createdSort: -facts.t,
      permalink: facts.p,
    })
  }

  return {
    postId,
    helpCount: parseCounts(helpRaw ?? {}),
    allCount: parseCounts(allRaw ?? {}),
    unanswered,
    topLevelSeen,
    unansweredTotal,
    partial: false,
  }
}

/** Drop everything for a post. Used by tests and by manual resets. */
export async function clearThreadState(
  db: RedisLike,
  postId: string,
): Promise<void> {
  await Promise.all([
    db.del(keyFacts(postId)),
    db.del(keySeen(postId)),
    db.del(keySubReplies(postId)),
    db.del(keyRemoved(postId)),
    db.del(keySeeded(postId)),
    db.del(keyPending(postId)),
    db.del(keyHelp(postId)),
    db.del(keyAll(postId)),
  ])
}
