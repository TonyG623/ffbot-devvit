/**
 * The counting rules, exercised through the TRIGGER path.
 *
 * This is the test that matters most now. The walk used to be the source of
 * truth and was covered by counting.test.ts against a real captured thread.
 * The trigger-fed Redis counters replaced it. So the load-bearing question is
 * no longer "are the rules right" but "does the new path produce EXACTLY what
 * the old path produced" — because the numbers go on a large subreddit and a
 * silent divergence would be invisible in review and wrong on every thread.
 *
 * So: replay the same captured r/fantasyfootball thread through the real
 * `recordComment`/`readThreadState` code against an in-memory Redis, and assert
 * the result equals what `accumulate` (the old walk) produces.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {
  type IncomingComment,
  isSeeded,
  markSeeded,
  type RedisLike,
  readThreadState,
  recordComment,
  trackPost,
} from './comment-counting.ts'
import {accumulate, DELETED_AUTHOR, type RawComment} from './comments.ts'

/** Enough of Redis to run the counters. Hash ops are per-field, as in Redis. */
function fakeRedis(): RedisLike & {dump(): Record<string, unknown>} {
  const strings = new Map<string, string>()
  const hashes = new Map<string, Map<string, string>>()
  const hash = (key: string): Map<string, string> => {
    const existing = hashes.get(key)
    if (existing) return existing
    const created = new Map<string, string>()
    hashes.set(key, created)
    return created
  }
  return {
    get: async key => strings.get(key),
    set: async (key, value) => strings.set(key, value),
    expire: async () => undefined,
    del: async key => {
      strings.delete(key)
      hashes.delete(key)
    },
    hGet: async (key, field) => hash(key).get(field),
    hSet: async (key, values) => {
      for (const [f, v] of Object.entries(values)) hash(key).set(f, v)
    },
    hSetNX: async (key, field, value) => {
      const h = hash(key)
      if (h.has(field)) return 0
      h.set(field, value)
      return 1
    },
    hIncrBy: async (key, field, by) => {
      const h = hash(key)
      const next = Number(h.get(field) ?? 0) + by
      h.set(field, String(next))
      return next
    },
    hDel: async (key, fields) => {
      for (const f of fields) hash(key).delete(f)
    },
    hGetAll: async key => Object.fromEntries(hash(key)),
    dump: () => Object.fromEntries(hashes),
  }
}

const POST = 't3_test'

/** Turn a walk-shaped thread into the stream of events a trigger would send. */
function asEvents(comments: RawComment[]): IncomingComment[] {
  const events: IncomingComment[] = []
  comments.forEach((c, i) => {
    const id = `t1_c${i}`
    events.push({
      commentId: id,
      postId: POST,
      parentId: POST, // top-level: parent is the post
      author: c.authorName,
      body: 'top level body',
      permalink: c.permalink,
      createdAtMs: c.createdAtMs,
      removed: c.removed,
    })
    c.replies.forEach((r, j) => {
      events.push({
        commentId: `t1_c${i}r${j}`,
        postId: POST,
        parentId: id, // a direct reply: parent is the top-level comment
        author: r.authorName,
        body: r.body,
        permalink: `${c.permalink}/r${j}`,
        // Replies land after their parent.
        createdAtMs: c.createdAtMs + 1000 * (j + 1),
      })
    })
  })
  return events
}

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/ff-trade-2026-09-08.json', import.meta.url),
    'utf8',
  ),
) as {comments: [string, number, number, string, [string, number][]][]}

const realThread: RawComment[] = fixture.comments.map(c => ({
  authorName: c[0],
  removed: !!c[1],
  createdAtMs: c[2] * 1000,
  permalink: `/c/${c[3]}`,
  replies: c[4].map(r => ({authorName: r[0], body: 'x'.repeat(r[1])})),
}))

async function replay(
  comments: RawComment[],
): Promise<ReturnType<typeof readThreadState>> {
  const db = fakeRedis()
  await trackPost(db, POST)
  for (const ev of asEvents(comments)) await recordComment(db, ev)
  return readThreadState(db, POST)
}

test('THE one that matters: trigger counters match the walk on a real thread', async () => {
  const viaTrigger = await replay(realThread)
  const viaWalk = accumulate(realThread)

  assert.equal(viaTrigger.topLevelSeen, viaWalk.topLevelSeen)
  assert.equal(viaTrigger.unansweredTotal, viaWalk.unansweredTotal)
  assert.deepEqual(viaTrigger.helpCount, viaWalk.substantive)
  assert.deepEqual(viaTrigger.allCount, viaWalk.allReplies)

  // Same authors on the unanswered table, in the same order.
  assert.deepEqual(
    viaTrigger.unanswered.map(r => r.author),
    viaWalk.unanswered.map(r => r.author),
  )
  // And the same permalink and sort key per row, so the table renders the same.
  assert.deepEqual(
    viaTrigger.unanswered.map(r => [r.permalink, r.createdSort]),
    viaWalk.unanswered.map(r => [r.permalink, r.createdSort]),
  )
})

test('the two reply counters still diverge through the trigger path', async () => {
  const state = await replay(realThread)
  // The same user the walk tests pin: 13 replies, one of them 19 characters.
  assert.equal(state.helpCount['headfullofmangos'], 12)
  assert.equal(state.allCount['headfullofmangos'], 13)
})

test('a redelivered trigger does not double count', async () => {
  const db = fakeRedis()
  await trackPost(db, POST)
  const events = asEvents(realThread)

  for (const ev of events) await recordComment(db, ev)
  const once = await readThreadState(db, POST)

  // Devvit can redeliver, and the reconciliation walk deliberately re-reads.
  for (const ev of events) {
    assert.equal(await recordComment(db, ev), 'duplicate')
  }
  const twice = await readThreadState(db, POST)

  assert.deepEqual(twice, once, 'replaying every event must change nothing')
})

test('a reply to a reply is ignored, as the Python ignored it', async () => {
  const db = fakeRedis()
  await trackPost(db, POST)
  const base = {
    postId: POST,
    permalink: '/c/x',
    createdAtMs: 1_700_000_000_000,
  }
  assert.equal(
    await recordComment(db, {
      ...base,
      commentId: 't1_top',
      parentId: POST,
      author: 'asker',
      body: 'question',
    }),
    'top-level',
  )
  assert.equal(
    await recordComment(db, {
      ...base,
      commentId: 't1_reply',
      parentId: 't1_top',
      author: 'helper',
      body: 'a genuinely substantive answer',
    }),
    'direct-reply',
  )
  // Depth 2. The parent is not a top-level comment, so it must not count.
  assert.equal(
    await recordComment(db, {
      ...base,
      commentId: 't1_deep',
      parentId: 't1_reply',
      author: 'rando',
      body: 'a genuinely substantive follow up',
    }),
    'deeper-reply',
  )

  const state = await readThreadState(db, POST)
  assert.equal(state.allCount['rando'], undefined)
  assert.equal(state.allCount['helper'], 1)
  assert.equal(state.topLevelSeen, 1)
})

test('comments on untracked posts are the caller gate, not this module', async () => {
  const db = fakeRedis()
  // trackPost was never called for this post.
  assert.equal(await isTrackedHelper(db, POST), false)
  await trackPost(db, POST)
  assert.equal(await isTrackedHelper(db, POST), true)
})

async function isTrackedHelper(
  db: RedisLike,
  postId: string,
): Promise<boolean> {
  const {isTracked} = await import('./comment-counting.ts')
  return isTracked(db, postId)
}

test('deleted authors are excluded, but still answer and still count', async () => {
  const db = fakeRedis()
  await trackPost(db, POST)
  const base = {postId: POST, permalink: '/c/x', createdAtMs: 1_700_000_000_000}

  await recordComment(db, {
    ...base,
    commentId: 't1_a',
    parentId: POST,
    author: DELETED_AUTHOR,
    body: 'question from a since-deleted account',
  })
  await recordComment(db, {
    ...base,
    commentId: 't1_b',
    parentId: POST,
    author: 'visible',
    body: 'question',
  })
  await recordComment(db, {
    ...base,
    commentId: 't1_br',
    parentId: 't1_b',
    author: DELETED_AUTHOR,
    body: 'a substantive answer from a deleted account',
  })

  const state = await readThreadState(db, POST)
  // Never on a leaderboard, even though the reply was substantive.
  assert.equal(state.allCount[DELETED_AUTHOR], undefined)
  assert.equal(state.helpCount[DELETED_AUTHOR], undefined)
  // 'visible' has ONE substantive reply, and UNANSWERED_MAX is 1, so it is
  // still listed - one answer is not enough to clear a comment off the table.
  assert.deepEqual(
    state.unanswered.map(r => r.author),
    ['visible'],
  )
  // Both comments count toward "% helped": the deleted author's gets no row
  // but is still an unanswered comment on the thread.
  assert.equal(state.unansweredTotal, 2)
  assert.equal(state.topLevelSeen, 2)
})

test('a removed top-level comment drops off the table', async () => {
  const db = fakeRedis()
  await trackPost(db, POST)
  await recordComment(db, {
    commentId: 't1_gone',
    postId: POST,
    parentId: POST,
    author: 'spammer',
    body: 'spam',
    permalink: '/c/gone',
    createdAtMs: 1_700_000_000_000,
    removed: true,
  })
  const state = await readThreadState(db, POST)
  assert.equal(state.unanswered.length, 0)
  assert.equal(state.unansweredTotal, 0)
  assert.equal(state.topLevelSeen, 1, 'still counts as a comment on the thread')
})

test('seeded distinguishes "no comments yet" from "not counted yet"', async () => {
  const db = fakeRedis()
  await trackPost(db, POST)

  // A thread nobody has reconciled yet. Rendering it now would publish an
  // empty table over real content, so it must not look like a counted thread.
  assert.equal(await isSeeded(db, POST), false)

  await markSeeded(db, POST)
  assert.equal(await isSeeded(db, POST), true)

  // A genuinely empty thread is seeded AND has zero counts. That pair is what
  // lets the reconcile rotation move on instead of picking it forever.
  const state = await readThreadState(db, POST)
  assert.equal(state.topLevelSeen, 0)
})
