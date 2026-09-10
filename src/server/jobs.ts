/**
 * The scheduled work, split into phases so no single invocation approaches
 * Devvit's 30-second execution limit.
 *
 *   cycle    (cron)   ensure today's threads exist, then chain into:
 *   walk     (1/job)  read one thread's comments into a Redis accumulator
 *   render   (1/job)  edit one thread's body from the accumulators
 *   index    (1 job)  build and post/edit the stickied Index thread
 *
 * The Python did all of this in one long-running process with a time.sleep(10)
 * between edits. That shape cannot survive a 30s ceiling, which is why the run
 * state lives in Redis and each phase re-enters through the scheduler.
 */
import {context, reddit, scheduler, settings} from '@devvit/web/server'
import type {FfbotConfig, ThreadConfig} from '../shared/types.ts'
import {
  clearRemoved,
  isSeeded,
  markRemoved,
  markSeeded,
  readThreadState,
  recordComment,
  trackPost,
} from './comment-store.ts'
import {fillRowCounts, mergeCounts, walkThread} from './comments.ts'
import {getWiki, loadConfig, NO_WIKI_FOUND} from './config.ts'
import {
  daysSinceMonday,
  squashWhitespace,
  threadDate,
  threadZone,
} from './dates.ts'
import {
  loadRun,
  nextReconcileCursor,
  type RunState,
  type RunThread,
  saveRun,
} from './state.ts'
import {
  composeThreadBody,
  overallLeaderTable,
  unansweredTable,
} from './tables.ts'
import {resolvePostsPerDay, selectThreads} from './threads.ts'

/** Stop working at this point and hand off to the next job. */
const BUDGET_MS = 20_000
/** Index bodies above this are rebuilt with fewer rows, as the Python did. */
const MAX_INDEX_LENGTH = 15_000

const JOB_PROCESS = 'ffbot-process-thread'
const JOB_INDEX = 'ffbot-build-index'

type Phase = 'walk' | 'render'

async function subredditName(): Promise<string> {
  const name = context.subredditName
  if (!name) throw new Error('no subredditName in context')
  return name
}

async function readSettings(): Promise<{
  postsPerDay: number
  timezone: string
  rolloverHour: number
}> {
  const all = await settings.getAll<{
    postsPerDay?: number
    timezone?: string
    rolloverHour?: number
  }>()
  return {
    postsPerDay: all.postsPerDay ?? 1,
    timezone: all.timezone ?? 'America/Chicago',
    rolloverHour: all.rolloverHour ?? 6,
  }
}

/** Port of get_current_threads: this app account's recent posts. */
async function currentBotPosts(
  sub: string,
  limit = 200,
): Promise<{id: string; title: string; stickied: boolean}[]> {
  const me = context.appSlug
  const seen = new Map<string, {id: string; title: string; stickied: boolean}>()
  for (const listing of [
    reddit.getHotPosts({subredditName: sub, limit, pageSize: 100}),
    reddit.getNewPosts({subredditName: sub, limit, pageSize: 100}),
  ]) {
    for (const post of await listing.all()) {
      if (post.authorName !== me) continue
      seen.set(post.id, {
        id: post.id,
        title: post.title,
        stickied: post.stickied,
      })
    }
  }
  return [...seen.values()]
}

/**
 * Reddit rejects a submit that carries flair TEXT without a flair ID
 * ("Can't set flair_text without a flair_id"), so resolve the subreddit's
 * flair template by its text and submit the id instead.
 *
 * Templates are fetched once per subreddit per warm process.
 */
let flairCache:
  | {sub: string; templates: {id: string; text: string}[]}
  | undefined

async function flairIdForText(
  sub: string,
  text: string,
): Promise<string | undefined> {
  if (flairCache?.sub !== sub) {
    try {
      const templates = await reddit.getPostFlairTemplates(sub)
      flairCache = {
        sub,
        templates: templates.map(t => ({id: t.id, text: t.text})),
      }
      console.log(
        `Flair templates on r/${sub}: ${flairCache.templates.map(t => `"${t.text}"`).join(', ') || '(none)'}`,
      )
    } catch (err) {
      console.warn(
        `WARN: could not read flair templates for r/${sub}: ${String(err)}`,
      )
      flairCache = {sub, templates: []}
    }
  }
  const hit = flairCache.templates.find(t => t.text === text)
  if (!hit) {
    console.warn(
      `WARN: no post flair template matching "${text}" on r/${sub}; submitting without flair`,
    )
  }
  return hit?.id
}

function threadTitle(
  cfg: ThreadConfig,
  day: string,
  zone: string,
  date: string,
): string {
  return squashWhitespace(`Official: [${cfg.title}] - ${day} ${zone} ${date}`)
}

/** cycle: ensure today's threads exist, then start the walk chain. */
export async function runCycle(): Promise<void> {
  const sub = await subredditName()
  const opts = await readSettings()

  const loaded = await loadConfig(sub)
  if (!loaded.ok) return
  const config = loaded.config

  const td = threadDate(new Date(), opts.timezone, opts.rolloverHour)
  const zone = threadZone(
    resolvePostsPerDay(config, opts.postsPerDay),
    td.hour,
  ).trim()

  const existing = await currentBotPosts(sub, 1000)
  const byTitle = new Map(existing.map(p => [p.title, p]))

  const enabled = selectThreads(config.threads, td.dayFull)

  const threads: RunThread[] = []
  for (const cfg of enabled) {
    let body = (await getWiki(sub, `ffbot/${cfg.wiki}`)) ?? NO_WIKI_FOUND
    if (config.wdis_replace && cfg.wiki === 'wdis') {
      const position = cfg.title.split(' ')[1] ?? ''
      body = body.replaceAll('<REPLACE>', position)
    }

    const title = threadTitle(cfg, td.day, zone, td.date)
    const found = byTitle.get(title)

    if (found) {
      console.log(`ALREADY SUBMITTED, USING: ${title}`)
      threads.push({postId: found.id, body, config: cfg})
      continue
    }

    console.log(`SUBMITTING THREAD ${title}`)
    // Flair goes on AT SUBMIT. Subreddits can require post flair (r/ffbottest
    // does), and a bare submit is rejected outright there, so the Python's
    // submit-then-flair ordering would never post at all.
    const flairId = await flairIdForText(sub, cfg.flair_text)
    const post = await reddit.submitPost({
      subredditName: sub,
      title,
      text: body,
      ...(flairId ? {flairId} : {}),
    })
    await post.setSuggestedCommentSort('NEW')
    if (!flairId) {
      // No template matched. Fall back to setting flair directly, as the
      // Python did. This fails on subreddits that require a template.
      try {
        await reddit.setPostFlair({
          subredditName: sub,
          postId: post.id,
          text: cfg.flair_text,
          cssClass: cfg.flair_css,
        })
      } catch (err) {
        console.warn(`WARN: could not set flair on ${post.id}: ${String(err)}`)
      }
    }
    if (cfg.sticky) await post.sticky(2)
    threads.push({postId: post.id, body, config: cfg})
  }

  // The comment trigger fires for the whole subreddit; this is what tells it
  // which posts to count. Register BEFORE saving the run so no comment posted
  // between submit and save is missed.
  for (const t of threads) await trackPost(t.postId)

  const reconcileIndex =
    threads.length > 0 ? (await nextReconcileCursor()) % threads.length : 0

  const run: RunState = {
    runId: `${td.date.replaceAll('/', '')}-${zone || 'all'}-${Date.now()}`,
    date: td.date,
    day: td.day,
    zone,
    threads,
    cursor: 0,
    reconcileIndex,
    helpCountAll: {},
  }
  await saveRun(run)
  await chain('walk', 0)
}

/** Schedule the next phase step a few seconds out. */
async function chain(phase: Phase, cursor: number, skip = 0): Promise<void> {
  await scheduler.runJob({
    name: JOB_PROCESS,
    data: {phase, cursor, skip},
    // No delay. Each hop may already cost up to a minute of scheduler
    // granularity, so adding sleep on top is pure latency.
    runAt: new Date(),
  })
}

export async function processThread(data: {
  phase: Phase
  cursor: number
  skip: number
}): Promise<void> {
  const run = await loadRun()
  if (!run) {
    console.warn('WARN: no run state; skipping')
    return
  }

  const deadline = Date.now() + BUDGET_MS
  let phase = data.phase
  let cursor = data.cursor
  let skip = data.skip

  // RECONCILE PHASE: exactly ONE thread per cycle, rotating.
  //
  // The counters are kept current by the comment trigger, so this pass only
  // repairs drift (missed events, mod removals, downtime). Repairing every
  // thread every cycle would re-incur the full rate-limited walk cost that the
  // trigger design exists to avoid — measured at up to 20s for a single
  // 541-comment thread. Rotating means every thread is repaired every N cycles
  // instead, for a flat ~20s of API time per cycle no matter how many threads
  // there are.
  if (phase === 'walk') {
    // An UNSEEDED thread jumps the queue. Rendering a thread whose counters
    // have never been populated publishes an empty leaderboard and an empty
    // unanswered table over real content, so a cold start (first deploy, or
    // after the counters expire) must seed before it renders. A genuinely
    // empty thread is seeded with zero counts and does not keep jumping.
    let targetIndex = run.reconcileIndex
    for (const [i, t] of run.threads.entries()) {
      if (!(await isSeeded(t.postId))) {
        targetIndex = i
        break
      }
    }

    const target = run.threads[targetIndex]
    if (target) {
      const result = await reconcileOne(target, deadline, skip)
      if (result.hitBudget) {
        await chain('walk', cursor, result.nextSkip)
        return
      }
      // Only a COMPLETE pass counts as seeded; a truncated one leaves it
      // unseeded so the next cycle finishes the job before rendering it.
      await markSeeded(target.postId)
    }
    phase = 'render'
    cursor = 0
    skip = 0
    run.cursor = 0

    // "# Helped in all threads" spans the whole run, so it is summed from every
    // thread's store once repairs are done. Redis only; no API calls.
    run.helpCountAll = {}
    for (const t of run.threads) {
      const acc = await readThreadState(t.postId)
      mergeCounts(run.helpCountAll, acc.allCount)
    }
    await saveRun(run)
  }

  // RENDER PHASE: every thread, every cycle. One Redis read and one edit each,
  // so this stays cheap however big the threads get.
  for (;;) {
    const thread = run.threads[cursor]
    if (!thread) {
      console.log('All threads rendered; building index')
      await scheduler.runJob({name: JOB_INDEX, runAt: new Date()})
      return
    }

    if (Date.now() > deadline) {
      console.log(`Budget spent; continuing at render cursor ${cursor}`)
      await chain('render', cursor, 0)
      return
    }

    await renderOne(run, thread)
    cursor++
    run.cursor = cursor
    await saveRun(run)
  }
}

/**
 * Reconciliation, NOT the main counting path.
 *
 * The counters are maintained by the onCommentCreate trigger. This exists to
 * repair the three ways triggers drift:
 *
 *   - comments posted while the app was down, or before it was installed
 *   - a comment removed by a mod after the fact (no create event fires)
 *   - a trigger Devvit simply did not deliver
 *
 * It re-reads the thread and folds anything missing into the SAME counters.
 * `recordComment` is idempotent, so re-reading a comment already counted is a
 * no-op rather than a double count — which is what makes it safe to run this
 * as often as the budget allows.
 *
 * It is bounded by `deadline` like the old walk was, but running out of time is
 * now harmless: it just means less repair this cycle, not missing numbers.
 */
async function reconcileOne(
  thread: RunThread,
  deadline: number,
  skip: number,
): Promise<{hitBudget: boolean; nextSkip: number}> {
  const walked = await walkThread(thread.postId, deadline, skip)

  let repaired = 0
  for (const c of walked.comments) {
    const kind = await recordComment({
      commentId: c.commentId,
      postId: thread.postId,
      parentId: c.parentId,
      author: c.authorName,
      body: c.body,
      permalink: c.permalink,
      createdAtMs: c.createdAtMs,
      removed: c.removed,
    })
    if (kind !== 'duplicate') repaired++
    // A mod removal never fires a create event, so it can only be seen here.
    if (c.isTopLevel) {
      if (c.removed) await markRemoved(thread.postId, c.commentId)
      else await clearRemoved(thread.postId, c.commentId)
    }
  }

  if (repaired > 0) {
    console.log(`RECONCILE ${thread.postId} repaired ${repaired} comments`)
  }

  if (walked.partial) {
    const nextSkip = skip + walked.topLevelSeen
    console.log(
      `Reconcile of ${thread.postId} paused at ${nextSkip}; resuming next job`,
    )
    return {hitBudget: true, nextSkip}
  }
  return {hitBudget: false, nextSkip: 0}
}

async function renderOne(run: RunState, thread: RunThread): Promise<void> {
  if (thread.config.no_table) return
  const acc = await readThreadState(thread.postId)
  const body = composeThreadBody(thread.body, acc, run.helpCountAll)
  console.log(`EDITING THREAD ${thread.postId}`)
  const post = await reddit.getPostById(thread.postId as `t3_${string}`)
  await post.edit({text: body})
}

/** Port of post_index_thread + calculate_index_length. */
export async function buildIndex(): Promise<void> {
  const run = await loadRun()
  if (!run) return
  const sub = await subredditName()

  const loaded = await loadConfig(sub)
  if (!loaded.ok) return
  const config: FfbotConfig = loaded.config
  if (!config.index) return

  const wikiIndex = (await getWiki(sub, 'ffbot/index')) ?? NO_WIKI_FOUND

  if (config.news_and_discussion && !run.newsLink) {
    run.newsLink = await postNewsAndDiscussions()
    await saveRun(run)
  }

  let body = ''
  let rowLimit = 20
  do {
    body = wikiIndex
    if (run.newsLink) {
      body += `\n#[Please checkout our current News And Discussions](${run.newsLink})\n\n`
    }
    body += overallLeaderTable(run.helpCountAll)
    for (const thread of run.threads) {
      const acc = await readThreadState(thread.postId)
      const rows = fillRowCounts(
        acc.unanswered,
        acc.helpCount,
        run.helpCountAll,
      )
      const post = await reddit.getPostById(thread.postId as `t3_${string}`)
      body += '\n --- \n\n'
      body += `#[${post.title}](${post.permalink})`
      body += unansweredTable({
        rows,
        topLevelCount: acc.topLevelSeen,
        unansweredTotal: acc.unansweredTotal,
        length: rowLimit,
        text: false,
        showPercents: config.show_percents,
      })
    }
    rowLimit--
  } while (body.length > MAX_INDEX_LENGTH && rowLimit > 0)

  const title = squashWhitespace(
    `Official: [Index] - For All Your Team/League Questions - ${run.day} ${run.zone} ${run.date}`,
  )

  const posts = await currentBotPosts(sub, 200)
  const found = posts.find(p => p.title === title)

  for (const post of posts) {
    if (post.title.includes('Index') && !post.title.includes(run.date)) {
      const stale = await reddit.getPostById(post.id as `t3_${string}`)
      await stale.unsticky()
    }
  }

  if (found) {
    console.log(`EDITING INDEX ${title}`)
    const post = await reddit.getPostById(found.id as `t3_${string}`)
    await post.edit({text: body})
    return
  }

  console.log(`SUBMITTING THREAD ${title}`)
  const indexFlairId = await flairIdForText(sub, 'Index')
  const post = await reddit.submitPost({
    subredditName: sub,
    title,
    text: body,
    ...(indexFlairId ? {flairId: indexFlairId} : {}),
  })
  if (!indexFlairId) {
    try {
      await reddit.setPostFlair({
        subredditName: sub,
        postId: post.id,
        text: 'Index',
        cssClass: 'index',
      })
    } catch (err) {
      console.warn(`WARN: could not set Index flair: ${String(err)}`)
    }
  }
  await post.sticky(1)
  await post.lock()
}

/** Port of post_news_and_discussions / get_threads_by_flair. */
export async function postNewsAndDiscussions(): Promise<string | undefined> {
  const run = await loadRun()
  if (!run) return undefined
  const sub = await subredditName()
  const opts = await readSettings()

  const sinceMonday = daysSinceMonday(new Date(), opts.timezone)
  const sections: [string, string, number][] = [
    ['flair:mod', 'Mod Posts', sinceMonday],
    ['flair:quality', 'Quality Posts', sinceMonday],
    ['flair:news', 'News', 2],
    ['flair:player', 'Player Discussions', 2],
  ]

  let body = ''
  for (const [query, label, days] of sections) {
    body += await threadsByFlair(sub, query, days, label)
  }

  const title = `News and Discussions - ${run.day} ${run.date}`
  const posts = await currentBotPosts(sub, 200)
  const found = posts.find(p => p.title === title)

  if (found) {
    console.log(`EDITING: ${title}`)
    const post = await reddit.getPostById(found.id as `t3_${string}`)
    await post.edit({text: body})
    return post.permalink
  }

  console.log(`SUBMITTING: ${title}`)
  const newsFlairId = await flairIdForText(sub, 'Daily Thread')
  const post = await reddit.submitPost({
    subredditName: sub,
    title,
    text: body,
    ...(newsFlairId ? {flairId: newsFlairId} : {}),
  })
  if (!newsFlairId) {
    try {
      await reddit.setPostFlair({
        subredditName: sub,
        postId: post.id,
        text: 'Daily Thread',
        cssClass: 'daily',
      })
    } catch (err) {
      console.warn(`WARN: could not set news flair: ${String(err)}`)
    }
  }
  await post.lock()
  return post.permalink
}

async function threadsByFlair(
  sub: string,
  query: string,
  days: number,
  label: string,
): Promise<string> {
  const now = Date.now() / 1000
  const results = await reddit
    .searchPosts({subredditName: sub, query, timeframe: 'week', sort: 'new'})
    .all()

  const hits = results.filter(post => {
    const ageDays = (now - post.createdAt.getTime() / 1000) / 60 / 60 / 24
    return ageDays < days
  })

  if (hits.length === 0) return ''
  let html = `\n\n#Recent ${label}\n`
  for (const post of hits) html += `\n* [${post.title}](${post.permalink})`
  return html
}
