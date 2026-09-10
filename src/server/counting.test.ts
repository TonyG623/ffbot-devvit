/**
 * Counting rules exercised against REAL data.
 *
 * The fixture is 30 top-level comments and their direct replies, captured from
 * a live FFBot thread on r/fantasyfootball (Official: [Trade] - Tue 09/08/2026)
 * while the original Python bot was running. Reply bodies are reduced to their
 * lengths, since length is all the rules look at.
 *
 * This is the test that matters most: the numbers here get published to a large
 * subreddit, and a silent off-by-one in the reply counters would be invisible
 * in review but wrong on every thread.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {accumulate, fillRowCounts, type RawComment} from './comments.ts'
import {leaderTable, unansweredTable} from './tables.ts'

type FixtureRow = [string, number, number, string, [string, number][]]

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/ff-trade-2026-09-08.json', import.meta.url),
    'utf8',
  ),
) as {comments: FixtureRow[]}

const comments: RawComment[] = fixture.comments.map(c => ({
  authorName: c[0],
  removed: !!c[1],
  createdAtMs: c[2] * 1000,
  permalink: `/c/${c[3]}`,
  replies: c[4].map(r => ({authorName: r[0], body: 'x'.repeat(r[1])})),
}))

test('walks every top-level comment in the real thread', () => {
  const acc = accumulate(comments)
  assert.equal(acc.topLevelSeen, 30)
})

test('THE important one: the two reply counters genuinely diverge', () => {
  const acc = accumulate(comments)
  // headfullofmangos wrote 13 direct replies, but one was 19 characters — under
  // the >20 threshold — so only 12 count as substantive. Collapsing these two
  // counters into one would publish 13 in the "# Helped in thread" column.
  assert.equal(acc.substantive['headfullofmangos'], 12)
  assert.equal(acc.allReplies['headfullofmangos'], 13)

  // Same divergence, different author: an 18-character reply.
  assert.equal(acc.substantive['Professor_Finn'], 2)
  assert.equal(acc.allReplies['Professor_Finn'], 3)

  // And a 5-character one.
  assert.equal(acc.substantive['alienco'], 1)
  assert.equal(acc.allReplies['alienco'], 2)
})

test('the >20 character boundary decides whether a comment is answered', () => {
  const acc = accumulate(comments)
  const unansweredAuthors = acc.unanswered.map(r => r.author)

  // ChinoDemamp11 has TWO replies (24 and 18 chars) but only the 24 is
  // substantive, so it has <= 1 real answer and stays on the unanswered list.
  assert.ok(unansweredAuthors.includes('ChinoDemamp11'))

  // HomerThompson_ has five replies, three of them over 20 chars, so it is
  // answered and must NOT appear.
  assert.ok(!unansweredAuthors.includes('HomerThompson_'))
})

test('each author is listed at most once on the unanswered table', () => {
  const acc = accumulate(comments)
  const authors = acc.unanswered.map(r => r.author)
  assert.equal(authors.length, new Set(authors).size)
  assert.equal(acc.unanswered.length, 18)
})

test('rendered tables match what the real thread would publish', () => {
  const acc = accumulate(comments)
  const rows = fillRowCounts(acc.unanswered, acc.substantive, acc.allReplies)

  const leaders = leaderTable(acc.allReplies)
  // Top helper by unfiltered reply count.
  assert.match(leaders, /\nheadfullofmangos\|13/)

  const table = unansweredTable({
    rows,
    topLevelCount: acc.topLevelSeen,
    length: 6,
    text: false,
    showPercents: true,
  })
  // Sorted by helpedHere desc, so the busiest helper's own unanswered comment
  // leads, showing 12 (substantive) and 13 (all) in the two columns.
  assert.match(
    table,
    /\nheadfullofmangos \| 12 \| 13 \| \[Comment\]\(\/c\/p8k8lu7\)/,
  )
  // 18 unanswered of 30 top-level comments -> 40% helped.
  assert.match(table, /\*\*40% of users have been helped in this thread\*\*/)
  assert.match(table, /\n\*\*and 12 others\.\*\*\| \| /)
})
