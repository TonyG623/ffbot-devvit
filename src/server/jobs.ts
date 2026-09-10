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
  emptyAccumulator,
  fillRowCounts,
  mergeCounts,
  walkThread,
} from './comments.ts'
import {NO_WIKI_FOUND, getWiki, loadConfig} from './config.ts'
import {
  daysSinceMonday,
  squashWhitespace,
  threadDate,
  threadZone,
} from './dates.ts'
import {
  type RunState,
  type RunThread,
  loadAccumulator,
  loadRun,
  saveAccumulator,
  saveRun,
} from './state.ts'
import {leaderTable, overallLeaderTable, unansweredTable} from './tables.ts'

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
let flairCache: {sub: string; templates: {id: string; text: string}[]} | undefined

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
      console.warn(`WARN: could not read flair templates for r/${sub}: ${String(err)}`)
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
    config.posts_per_day ?? opts.postsPerDay,
    td.hour,
  ).trim()

  const existing = await currentBotPosts(sub, 1000)
  const byTitle = new Map(existing.map(p => [p.title, p]))

  const enabled = config.threads
    .filter(t => t.enabled !== false)
    .filter(t => !t.day || t.day === td.dayFull)
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))

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

  const run: RunState = {
    runId: `${td.date.replaceAll('/', '')}-${zone || 'all'}-${Date.now()}`,
    date: td.date,
    day: td.day,
    zone,
    threads,
    cursor: 0,
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
    runAt: new Date(Date.now() + 5_000),
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

  const thread = run.threads[data.cursor]
  if (!thread) {
    // Phase complete.
    if (data.phase === 'walk') {
      run.cursor = 0
      await saveRun(run)
      await chain('render', 0)
    } else {
      await scheduler.runJob({
        name: JOB_INDEX,
        runAt: new Date(Date.now() + 5_000),
      })
    }
    return
  }

  if (data.phase === 'walk') {
    await walkOne(run, thread, data.cursor, data.skip)
  } else {
    await renderOne(run, thread, data.cursor)
  }
}

async function walkOne(
  run: RunState,
  thread: RunThread,
  cursor: number,
  skip: number,
): Promise<void> {
  const deadline = Date.now() + BUDGET_MS
  const walked = await walkThread(thread.postId, deadline, skip)

  const acc = (await loadAccumulator(run.runId, thread.postId)) ??
    emptyAccumulator(thread.postId)
  mergeCounts(acc.helpCount, walked.substantive)
  acc.unanswered.push(...walked.unanswered)
  acc.topLevelSeen += walked.topLevelSeen
  acc.partial = walked.partial
  await saveAccumulator(run.runId, acc)

  mergeCounts(run.helpCountAll, walked.allReplies)
  await saveRun(run)

  if (walked.partial) {
    console.log(
      `Thread ${thread.postId} hit the time budget after ${skip + walked.topLevelSeen} comments; continuing`,
    )
    await chain('walk', cursor, skip + walked.topLevelSeen)
  } else {
    run.cursor = cursor + 1
    await saveRun(run)
    await chain('walk', cursor + 1)
  }
}

async function renderOne(
  run: RunState,
  thread: RunThread,
  cursor: number,
): Promise<void> {
  if (!thread.config.no_table) {
    const acc = await loadAccumulator(run.runId, thread.postId)
    if (acc) {
      const rows = fillRowCounts(acc.unanswered, acc.helpCount, run.helpCountAll)
      let body = thread.body
      body += leaderTable(acc.helpCount)
      body += unansweredTable({
        rows,
        topLevelCount: acc.topLevelSeen,
        length: 40,
        text: true,
        showPercents: false,
      })
      console.log(`EDITING THREAD ${thread.postId}`)
      const post = await reddit.getPostById(thread.postId as `t3_${string}`)
      await post.edit({text: body})
    }
  }
  run.cursor = cursor + 1
  await saveRun(run)
  await chain('render', cursor + 1)
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
      const acc = await loadAccumulator(run.runId, thread.postId)
      if (!acc) continue
      const rows = fillRowCounts(acc.unanswered, acc.helpCount, run.helpCountAll)
      const post = await reddit.getPostById(thread.postId as `t3_${string}`)
      body += '\n --- \n\n'
      body += `#[${post.title}](${post.permalink})`
      body += unansweredTable({
        rows,
        topLevelCount: acc.topLevelSeen,
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
