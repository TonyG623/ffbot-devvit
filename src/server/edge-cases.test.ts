/**
 * HANDOFF "Still to test" item 6, plus regressions for two counting bugs found
 * while working through it.
 *
 * These are the cases that are invisible in review and wrong on every thread:
 * the exact boundary of the reply-length test, removed comments, and authors
 * who deleted their account between the bot's runs.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import type {ThreadAccumulator} from '../shared/types.ts'
import {
  accumulate,
  DELETED_AUTHOR,
  fillRowCounts,
  isRealAuthor,
  type RawComment,
  SUBSTANTIVE_REPLY_LENGTH,
} from './comments.ts'
import {composeThreadBody, leaderTable, unansweredTable} from './tables.ts'

function comment(over: Partial<RawComment> = {}): RawComment {
  return {
    authorName: 'asker',
    removed: false,
    createdAtMs: 1_700_000_000_000,
    permalink: '/c/x',
    replies: [],
    ...over,
  }
}

function reply(authorName: string, length: number) {
  return {authorName, body: 'x'.repeat(length)}
}

// ---------------------------------------------------------------- boundary

test('a reply of exactly 20 characters is NOT substantive', () => {
  assert.equal(SUBSTANTIVE_REPLY_LENGTH, 20)
  const acc = accumulate([comment({replies: [reply('helper', 20)]})])
  // Counts for the leaderboard...
  assert.equal(acc.allReplies['helper'], 1)
  // ...but not as a real answer, so it never reaches the filtered counter.
  assert.equal(acc.substantive['helper'], undefined)
  // And the question is still unanswered.
  assert.equal(acc.unanswered.length, 1)
})

test('a reply of exactly 21 characters IS substantive', () => {
  const acc = accumulate([comment({replies: [reply('helper', 21)]})])
  assert.equal(acc.allReplies['helper'], 1)
  assert.equal(acc.substantive['helper'], 1)
  // One substantive reply is still <= UNANSWERED_MAX, so it stays listed.
  assert.equal(acc.unanswered.length, 1)
})

test('two substantive replies clear a comment off the unanswered list', () => {
  const acc = accumulate([comment({replies: [reply('a', 21), reply('b', 21)]})])
  assert.equal(acc.unanswered.length, 0)
  // Two 20-character replies do not, because neither one counts.
  const acc20 = accumulate([
    comment({replies: [reply('a', 20), reply('b', 20)]}),
  ])
  assert.equal(acc20.unanswered.length, 1)
})

// ---------------------------------------------------------------- removed

test('a removed comment gets no unanswered row but still feeds the counts', () => {
  const acc = accumulate([
    comment({removed: true, replies: [reply('helper', 50)]}),
  ])
  assert.equal(acc.unanswered.length, 0)
  assert.equal(acc.unansweredTotal, 0)
  // The reply still happened, so the helper still gets credit for it.
  assert.equal(acc.allReplies['helper'], 1)
  assert.equal(acc.substantive['helper'], 1)
  // And it still counts toward the thread's comment total.
  assert.equal(acc.topLevelSeen, 1)
})

// ---------------------------------------------------------------- deleted

test('isRealAuthor rejects the deleted sentinel and the empty string', () => {
  assert.equal(DELETED_AUTHOR, '[deleted]')
  assert.equal(isRealAuthor('someone'), true)
  assert.equal(isRealAuthor(DELETED_AUTHOR), false)
  assert.equal(isRealAuthor(''), false)
})

test('a deleted reply author never reaches the leaderboards', () => {
  const acc = accumulate([
    comment({replies: [reply(DELETED_AUTHOR, 50), reply('helper', 50)]}),
  ])
  // "[deleted]" is a truthy string in Devvit where PRAW gave the Python None,
  // so without the guard it would climb the table as if it were a user.
  assert.equal(acc.allReplies[DELETED_AUTHOR], undefined)
  assert.equal(acc.substantive[DELETED_AUTHOR], undefined)
  assert.equal(acc.allReplies['helper'], 1)
  assert.doesNotMatch(leaderTable(acc.allReplies), /\[deleted\]/)
})

test('a long reply from a deleted author still answers the question', () => {
  // The Python's length test never touched .author, so the reply counts toward
  // "is this answered" even though nobody can be credited for it.
  const acc = accumulate([
    comment({replies: [reply(DELETED_AUTHOR, 50), reply('helper', 50)]}),
  ])
  assert.equal(acc.unanswered.length, 0)
})

test('a deleted-author comment counts in "% helped" but gets no row', () => {
  const acc = accumulate([
    comment({authorName: DELETED_AUTHOR, permalink: '/c/gone'}),
    comment({authorName: 'visible', permalink: '/c/here'}),
  ])
  // No row for the deleted author...
  assert.equal(acc.unanswered.length, 1)
  assert.equal(acc.unanswered[0]?.author, 'visible')
  // ...but the Python's percentage counts it, so this must be 2, not 1.
  assert.equal(acc.unansweredTotal, 2)

  const table = unansweredTable({
    rows: fillRowCounts(acc.unanswered, acc.substantive, acc.allReplies),
    topLevelCount: acc.topLevelSeen,
    unansweredTotal: acc.unansweredTotal,
    length: 40,
    text: false,
    showPercents: true,
  })
  assert.doesNotMatch(table, /\[deleted\]/)
  // 2 unanswered of 2 comments -> 0% helped. Using rows.length would say 50%.
  assert.match(table, /\*\*0% of users have been helped in this thread\*\*/)
})

// ------------------------------------------------- leaderboard regression

test('REGRESSION: the thread leaderboard uses UNFILTERED counts', () => {
  // calculate_leader_index in post_daily_threads.py counts every reply with no
  // length test. The port was feeding it the length-filtered counter, which
  // published a number one too low for anyone who had written a short reply.
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/ff-trade-2026-09-08.json', import.meta.url),
      'utf8',
    ),
  ) as {comments: [string, number, number, string, [string, number][]][]}

  const comments: RawComment[] = fixture.comments.map(c => ({
    authorName: c[0],
    removed: !!c[1],
    createdAtMs: c[2] * 1000,
    permalink: `/c/${c[3]}`,
    replies: c[4].map(r => ({authorName: r[0], body: 'x'.repeat(r[1])})),
  }))

  const acc = accumulate(comments)
  // On this real thread the two counters genuinely disagree for this user.
  assert.equal(acc.substantive['headfullofmangos'], 12)
  assert.equal(acc.allReplies['headfullofmangos'], 13)

  // The leaderboard must show 13. Feeding it the filtered counter shows 12.
  assert.match(leaderTable(acc.allReplies), /\nheadfullofmangos\|13/)
  assert.match(leaderTable(acc.substantive), /\nheadfullofmangos\|12/)

  // Which proves the two are not interchangeable at this call site: whichever
  // accumulator jobs.ts passes to leaderTable decides what gets published.
  assert.notEqual(
    leaderTable(acc.allReplies),
    leaderTable(acc.substantive),
    'the two counters must produce different tables, or this test proves nothing',
  )
})

test('REGRESSION: composeThreadBody wires each counter to the right table', () => {
  // The bug this guards: renderOne passed the LENGTH-FILTERED counter to
  // leaderTable, so the thread leaderboard published one-too-low numbers for
  // anyone who had written a short reply. Asserting on the composed body means
  // re-introducing that swap fails here rather than in production.
  const acc: ThreadAccumulator = {
    postId: 't3_x',
    // shorty wrote 3 replies but only 1 was over 20 characters.
    helpCount: {shorty: 1, steady: 2},
    allCount: {shorty: 3, steady: 2},
    unanswered: [
      {
        author: 'shorty',
        helpedHere: 0,
        helpedAll: 0,
        createdSort: -5,
        permalink: '/c/a',
      },
    ],
    topLevelSeen: 4,
    unansweredTotal: 1,
    partial: false,
  }
  const body = composeThreadBody('WIKI', acc, {shorty: 9, steady: 4})

  assert.match(body, /^WIKI/)
  // Leaderboard: unfiltered, so shorty is 3 and leads steady's 2.
  assert.match(body, /\nshorty\|3/)
  assert.doesNotMatch(body, /\nshorty\|1/)
  // Row columns: filtered for this thread (1), unfiltered across the run (9).
  assert.match(body, /\nshorty \| 1 \| 9 \| \[Comment\]\(\/c\/a\)/)
})
