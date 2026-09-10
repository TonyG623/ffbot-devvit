/**
 * READ-ONLY walk benchmark. Answers HANDOFF.md "Still to test" item 1: does the
 * comment walk fit inside Devvit's execution limit at r/fantasyfootball volume?
 *
 * r/ffbottest is empty, so a walk there finishes instantly and proves nothing.
 * This reads real, live, high-volume threads and times them. It NEVER writes:
 * no submit, no edit, no comment, no flair, no sticky. The only calls it makes
 * are getNewPosts (to find the threads) and the comment listings themselves.
 *
 * It times two strategies against the same threads and checks that they produce
 * IDENTICAL counts, because a faster walk that publishes different numbers is
 * worse than a slow one:
 *
 *   current  post.comments, then `await comment.replies.all()` per comment.
 *            Comment.js builds a FRESH lazy listing per comment, so each of
 *            those is a network round trip: 1 + N requests for N comments.
 *
 *   parallel the same walk, but reply listings are fetched REPLY_CONCURRENCY at
 *            a time instead of one after another. Measurement showed the reply
 *            fetches are 80-90% of the walk at ~250ms each and they are
 *            independent reads, so the serial await is mostly dead wall-clock.
 *
 * A `depth: 2` variant was measured first and REFUTED: Reddit truncates each
 * comment's replies into a `more` stub at the same rate either way, so the same
 * ~40% of comments still needed a round trip and the timings were identical.
 *
 * Delete this file and its route/menu/task entries before the port ships.
 */
import {reddit, redis, scheduler} from '@devvit/web/server'
import {
  type Accumulation,
  accumulateComment,
  emptyAccumulation,
} from './comments.ts'

/**
 * Mirror the REAL walk budget from jobs.ts, so "how far did it get" is the
 * production answer rather than a benchmark artifact.
 */
const BENCH_CAP_MS = 20_000
/** How many threads to benchmark before stopping the chain. */
const MAX_TARGETS = 2
const KEY_TARGETS = 'ffbot:bench:targets'
const JOB_BENCH = 'ffbot-bench'

export type BenchVariant = 'listing' | 'current' | 'parallel'

/**
 * How many reply listings to fetch concurrently in the 'parallel' variant.
 * The measured cost is ~250ms per fetch and they are pure independent reads,
 * so the sequential await in the current walk is almost all dead wall-clock.
 */
const REPLY_CONCURRENCY = 8

export type BenchTarget = {
  postId: string
  title: string
  /** Reddit's own count. Includes replies, so it exceeds the top-level count. */
  numberOfComments: number
}

export type BenchResult = {
  postId: string
  variant: BenchVariant
  topLevel: number
  directReplies: number
  /** replies.all() calls that actually went to the network. */
  replyFetches: number
  replyFetchMs: number
  /** Page fetches while advancing the top-level listing. */
  listingPages: number
  listingMs: number
  elapsedMs: number
  /** True when BENCH_CAP_MS ran out before the listing was exhausted. */
  hitCap: boolean
  /** Counting fingerprint, to prove two strategies agree. */
  fingerprint: string
}

/**
 * Reduce an accumulation to a comparable string. Two walks of the same thread
 * must produce the same fingerprint or the faster one is not a valid swap.
 */
function fingerprint(acc: Accumulation): string {
  const stable = (counts: Record<string, number>): string =>
    Object.entries(counts)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([user, n]) => `${user}:${n}`)
      .join(',')
  const authors = [...acc.seenAuthors].sort().join(',')
  return [
    `tl=${acc.topLevelSeen}`,
    `unanswered=${acc.unanswered.length}`,
    `sub=${stable(acc.substantive)}`,
    `all=${stable(acc.allReplies)}`,
    `authors=${authors}`,
  ].join('|')
}

/**
 * Find the BUSIEST bot threads to benchmark against, read-only.
 *
 * This deliberately reaches back over the past year rather than at this week's
 * threads. In September r/fantasyfootball dailies run 150-300 comments; in
 * October a Sunday thread runs into the thousands. Benchmarking the quiet ones
 * measures the easy case and answers nothing about the season.
 */
export async function findBenchTargets(
  authorName: string,
  subredditName: string,
): Promise<BenchTarget[]> {
  const seen = new Map<string, BenchTarget>()
  for (const listing of [
    reddit.getPostsByUser({
      username: authorName,
      sort: 'top',
      timeframe: 'year',
      limit: 100,
      pageSize: 100,
    }),
    reddit.getPostsByUser({
      username: authorName,
      sort: 'new',
      limit: 100,
      pageSize: 100,
    }),
  ]) {
    let page: Awaited<ReturnType<typeof listing.all>> = []
    try {
      page = await listing.all()
    } catch (err) {
      console.warn(`BENCH: listing failed: ${String(err)}`)
      continue
    }
    for (const p of page) {
      if (p.subredditName !== subredditName) continue
      if (!p.title.startsWith('Official:')) continue
      seen.set(p.id, {
        postId: p.id,
        title: p.title,
        numberOfComments: p.numberOfComments,
      })
    }
  }

  const ranked = [...seen.values()].sort(
    (a, b) => b.numberOfComments - a.numberOfComments,
  )
  console.log(
    `BENCH found ${ranked.length} bot threads; comment counts ` +
      `${ranked
        .slice(0, 10)
        .map(t => t.numberOfComments)
        .join(', ')}`,
  )
  return ranked.slice(0, MAX_TARGETS)
}

/**
 * Walk one thread with one strategy, timing it. Pure measurement: the
 * accumulation is computed and fingerprinted, then thrown away.
 */
export async function benchWalk(
  postId: string,
  variant: BenchVariant,
): Promise<BenchResult> {
  const started = Date.now()
  const deadline = started + BENCH_CAP_MS
  const acc = emptyAccumulation()

  let directReplies = 0
  let replyFetches = 0
  let replyFetchMs = 0
  let listingPages = 0
  let listingMs = 0
  let hitCap = false

  const listing = (await reddit.getPostById(postId as `t3_${string}`)).comments

  // 'listing' counts top-level comments WITHOUT reading any replies. That is
  // the cheapest possible pass over the thread, so it establishes both the real
  // top-level N and the floor cost of merely enumerating it.
  if (variant === 'listing') {
    let leftAt = Date.now()
    for await (const _comment of listing) {
      const gap = Date.now() - leftAt
      if (gap > 5) {
        listingPages++
        listingMs += gap
      }
      if (Date.now() > deadline) {
        hitCap = true
        break
      }
      acc.topLevelSeen++
      if (acc.topLevelSeen % 250 === 0) {
        console.log(
          `BENCH listing ${postId} counted ${acc.topLevelSeen} top-level in ` +
            `${Date.now() - started}ms (${listingPages} pages)`,
        )
      }
      leftAt = Date.now()
    }
    return {
      postId,
      variant,
      topLevel: acc.topLevelSeen,
      directReplies: 0,
      replyFetches: 0,
      replyFetchMs: 0,
      listingPages,
      listingMs,
      elapsedMs: Date.now() - started,
      hitCap,
      fingerprint: `listing-only tl=${acc.topLevelSeen}`,
    }
  }

  // Time spent inside the async iterator between yields is page-fetch time.
  let leftLoopAt = Date.now()
  const batchSize = variant === 'parallel' ? REPLY_CONCURRENCY : 1
  let batch: (typeof listing extends AsyncIterable<infer C> ? C : never)[] = []

  /**
   * Read one batch's replies, then accumulate IN LISTING ORDER. Order matters:
   * the unanswered table lists each author once, so whichever of that author's
   * comments comes first is the one that gets the row. Fetching concurrently
   * but folding sequentially keeps that identical to the serial walk.
   */
  const drain = async (): Promise<void> => {
    if (batch.length === 0) return
    const needed = batch.map(c => c.replies.hasMore)
    const fetchStart = Date.now()
    const settled = await Promise.all(
      batch.map(async c => {
        try {
          return (await c.replies.all()).map(r => ({
            authorName: r.authorName,
            body: r.body ?? '',
          }))
        } catch (err) {
          console.warn(`BENCH: reply read failed for ${c.id}: ${String(err)}`)
          return []
        }
      }),
    )
    const spent = Date.now() - fetchStart
    const hits = needed.filter(Boolean).length
    replyFetches += hits
    if (hits > 0) replyFetchMs += spent

    for (const [i, c] of batch.entries()) {
      const replies = settled[i] ?? []
      directReplies += replies.length
      accumulateComment(acc, {
        authorName: c.authorName,
        removed: c.removed,
        createdAtMs: c.createdAt.getTime(),
        permalink: c.permalink,
        replies,
      })
    }
    batch = []

    const elapsed = Date.now() - started
    console.log(
      `BENCH ${variant} ${postId} progress tl=${acc.topLevelSeen} ` +
        `replies=${directReplies} fetches=${replyFetches} ` +
        `elapsed=${elapsed}ms rate=${(elapsed / acc.topLevelSeen).toFixed(1)}ms/comment`,
    )
  }

  for await (const comment of listing) {
    const gap = Date.now() - leftLoopAt
    if (gap > 5) {
      listingPages++
      listingMs += gap
    }

    if (Date.now() > deadline) {
      hitCap = true
      break
    }

    batch.push(comment)
    if (batch.length >= batchSize) await drain()

    leftLoopAt = Date.now()
  }
  await drain()

  return {
    postId,
    variant,
    topLevel: acc.topLevelSeen,
    directReplies,
    replyFetches,
    replyFetchMs,
    listingPages,
    listingMs,
    elapsedMs: Date.now() - started,
    hitCap,
    fingerprint: fingerprint(acc),
  }
}

function logResult(target: BenchTarget | undefined, r: BenchResult): void {
  const perComment = r.topLevel ? (r.elapsedMs / r.topLevel).toFixed(1) : 'n/a'
  const perFetch = r.replyFetches
    ? (r.replyFetchMs / r.replyFetches).toFixed(0)
    : 'n/a'
  console.log(
    [
      '',
      `BENCH RESULT ${r.variant} ${r.postId}`,
      `  title           ${target?.title ?? '(unknown)'}`,
      `  reddit says     ${target?.numberOfComments ?? '?'} comments (incl. replies)`,
      `  top-level read  ${r.topLevel}`,
      `  direct replies  ${r.directReplies}`,
      `  reply fetches   ${r.replyFetches} network calls, ${r.replyFetchMs}ms total, ${perFetch}ms each`,
      `  listing pages   ${r.listingPages} fetches, ${r.listingMs}ms total`,
      `  ELAPSED         ${r.elapsedMs}ms  (${perComment}ms per top-level comment)`,
      `  finished        ${r.hitCap ? `NO - hit the ${BENCH_CAP_MS}ms cap` : 'yes'}`,
      `  fits 20s budget ${!r.hitCap && r.elapsedMs < 20_000 ? 'YES' : 'NO'}`,
      '',
    ].join('\n'),
  )
}

/**
 * Kick the chain off. Called from the menu action, which only discovers the
 * targets; the timing itself runs on the scheduler so it gets a full job slot.
 */
export async function startBench(
  authorName: string,
  subredditName: string,
): Promise<number> {
  const targets = await findBenchTargets(authorName, subredditName)
  await redis.set(KEY_TARGETS, JSON.stringify(targets))

  console.log(`BENCH targets on r/${subredditName} by u/${authorName}:`)
  for (const t of targets) {
    console.log(`  ${t.postId} ${t.numberOfComments} comments  ${t.title}`)
  }
  if (targets.length === 0) {
    console.log('BENCH: no targets found; nothing to measure')
    return 0
  }

  await scheduler.runJob({
    name: JOB_BENCH,
    data: {index: 0, variant: 'listing'},
    runAt: new Date(),
  })
  return targets.length
}

/**
 * One (thread, strategy) pair per invocation, so a single measurement can never
 * be truncated by the job limit. Chains: current then depth2 for each thread.
 */
export async function runBenchStep(data: {
  index: number
  variant: BenchVariant
}): Promise<void> {
  const raw = await redis.get(KEY_TARGETS)
  if (!raw) {
    console.warn('BENCH: no targets in redis; run the menu action again')
    return
  }
  const targets = JSON.parse(raw) as BenchTarget[]
  const target = targets[data.index]
  if (!target) {
    console.log('BENCH: all targets measured')
    return
  }

  console.log(
    `BENCH starting ${data.variant} on ${target.postId} (${target.numberOfComments} comments)`,
  )
  const result = await benchWalk(target.postId, data.variant)
  logResult(target, result)

  await redis.set(
    `ffbot:bench:result:${target.postId}:${data.variant}`,
    JSON.stringify(result),
  )

  const next: Record<BenchVariant, BenchVariant | undefined> = {
    listing: 'current',
    current: 'parallel',
    parallel: undefined,
  }
  const nextVariant = next[data.variant]
  if (nextVariant) {
    await scheduler.runJob({
      name: JOB_BENCH,
      data: {index: data.index, variant: nextVariant},
      runAt: new Date(),
    })
    return
  }

  // Both strategies have now run on this thread; compare them.
  const priorRaw = await redis.get(
    `ffbot:bench:result:${target.postId}:current`,
  )
  if (priorRaw) {
    const prior = JSON.parse(priorRaw) as BenchResult
    const agree = prior.fingerprint === result.fingerprint
    const speedup =
      result.elapsedMs > 0
        ? (prior.elapsedMs / result.elapsedMs).toFixed(1)
        : '?'
    console.log(
      [
        '',
        `BENCH COMPARE ${target.postId}`,
        `  current  ${prior.elapsedMs}ms, ${prior.replyFetches} reply fetches, tl=${prior.topLevel}`,
        `  parallel ${result.elapsedMs}ms, ${result.replyFetches} reply fetches, tl=${result.topLevel}`,
        `  speedup  ${speedup}x`,
        `  COUNTS   ${agree ? 'IDENTICAL - parallel is a safe swap' : 'DIFFER - parallel is NOT a safe swap'}`,
        ...(agree
          ? []
          : [
              `    current fingerprint: ${prior.fingerprint.slice(0, 400)}`,
              `    depth2  fingerprint: ${result.fingerprint.slice(0, 400)}`,
            ]),
        '',
      ].join('\n'),
    )
  }

  await scheduler.runJob({
    name: JOB_BENCH,
    data: {index: data.index + 1, variant: 'current'},
    runAt: new Date(),
  })
}
