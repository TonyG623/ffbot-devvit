import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {UnansweredRow} from '../shared/types.ts'
import {
  daysSinceMonday,
  squashWhitespace,
  threadDate,
  threadZone,
} from './dates.ts'
import {
  compareUnanswered,
  leaderTable,
  overallLeaderTable,
  unansweredTable,
} from './tables.ts'
import {extractYaml} from './yaml-extract.ts'

test('extractYaml: fenced block returns content between first and last fence', () => {
  const input = ['intro text', '```', 'threads:', '  - title: A', '```', 'outro'].join(
    '\n',
  )
  assert.equal(extractYaml(input), 'threads:\n  - title: A')
})

test('extractYaml: indented block strips exactly four spaces', () => {
  const input = ['Some prose', '', '    threads:', '    - title: A', 'trailing'].join(
    '\n',
  )
  assert.equal(extractYaml(input), 'threads:\n- title: A')
})

test('extractYaml: raw YAML passes through untouched', () => {
  const input = 'threads:\n  - title: A\nindex: true'
  assert.equal(extractYaml(input), input)
})

test('extractYaml: blank lines inside an indented block are preserved', () => {
  const input = ['    a: 1', '', '    b: 2', 'stop'].join('\n')
  assert.equal(extractYaml(input), 'a: 1\n\nb: 2')
})

test('threadZone: one post per day has no zone', () => {
  for (const hour of [0, 7, 13, 23]) assert.equal(threadZone(1, hour), '')
})

test('threadZone: two posts per day split at 08:00 and 16:00', () => {
  assert.equal(threadZone(2, 7), 'Evening ')
  assert.equal(threadZone(2, 8), 'Morning ')
  assert.equal(threadZone(2, 15), 'Morning ')
  assert.equal(threadZone(2, 16), 'Evening ')
})

test('threadZone: three posts per day split at 06:00, 11:00 and 18:00', () => {
  assert.equal(threadZone(3, 5), 'Evening ')
  assert.equal(threadZone(3, 6), 'Morning ')
  assert.equal(threadZone(3, 10), 'Morning ')
  assert.equal(threadZone(3, 11), 'Afternoon ')
  assert.equal(threadZone(3, 17), 'Afternoon ')
  assert.equal(threadZone(3, 18), 'Evening ')
})

test('daysSinceMonday: Monday returns 7, other days count back', () => {
  const tz = 'UTC'
  // 2026-09-07 is a Monday.
  assert.equal(daysSinceMonday(new Date('2026-09-07T12:00:00Z'), tz), 7)
  assert.equal(daysSinceMonday(new Date('2026-09-08T12:00:00Z'), tz), 2)
  assert.equal(daysSinceMonday(new Date('2026-09-09T12:00:00Z'), tz), 3)
  assert.equal(daysSinceMonday(new Date('2026-09-13T12:00:00Z'), tz), 7)
})

test('threadDate: before the rollover hour the previous day is used', () => {
  const tz = 'America/Chicago'
  // 03:00 Chicago on Tue 2026-09-08 -> still Monday's threads.
  const early = threadDate(new Date('2026-09-08T08:00:00Z'), tz, 6)
  assert.equal(early.date, '09/07/2026')
  assert.equal(early.day, 'Mon')
  assert.equal(early.dayFull, 'monday')
  assert.equal(early.hour, 3)

  // 09:00 Chicago the same day -> Tuesday.
  const later = threadDate(new Date('2026-09-08T14:00:00Z'), tz, 6)
  assert.equal(later.date, '09/08/2026')
  assert.equal(later.day, 'Tue')
  assert.equal(later.hour, 9)
})

test('threadDate: rollover across a month boundary', () => {
  const tz = 'UTC'
  const d = threadDate(new Date('2026-10-01T02:00:00Z'), tz, 6)
  assert.equal(d.date, '09/30/2026')
})

test('squashWhitespace: collapses the gap left by an empty thread zone', () => {
  assert.equal(
    squashWhitespace('Official: [Keeper] - Tue  09/08/2026'),
    'Official: [Keeper] - Tue 09/08/2026',
  )
})

test('leaderTable: ranks descending and caps at the limit', () => {
  const table = leaderTable({alice: 5, bob: 9, carol: 1}, 2)
  assert.equal(
    table,
    '\n----\n**The following users have helped the most people in this thread:**' +
      '\n\nUser | # Helped in thread\n-------|:-----:' +
      '\nbob|9' +
      '\nalice|5',
  )
})

test('overallLeaderTable: empty counts render header only (Python parity)', () => {
  const table = overallLeaderTable({})
  assert.equal(
    table,
    '\n----\n**The following users have helped the most people in all of the threads:**' +
      '\n\nUser | # Helped in thread\n-------|:-----:',
  )
})

function row(over: Partial<UnansweredRow>): UnansweredRow {
  return {
    author: 'u1',
    helpedHere: 0,
    helpedAll: 0,
    createdSort: 0,
    permalink: '/r/x/1',
    ...over,
  }
}

test('unansweredTable: returns empty string when there is nothing to list', () => {
  assert.equal(
    unansweredTable({
      rows: [],
      topLevelCount: 10,
      length: 20,
      text: true,
      showPercents: true,
    }),
    '',
  )
})

test('unansweredTable: renders rows, overflow note and the update footer', () => {
  const rows = [
    row({author: 'a', helpedHere: 1, helpedAll: 2, permalink: '/a'}),
    row({author: 'b', helpedHere: 3, helpedAll: 1, permalink: '/b'}),
    row({author: 'c', helpedHere: 0, helpedAll: 0, permalink: '/c'}),
  ]
  const table = unansweredTable({
    rows,
    topLevelCount: 6,
    length: 2,
    text: false,
    showPercents: true,
  })

  // Sorted by helpedHere desc: b, a, then overflow note for c.
  assert.match(table, /\nb \| 3 \| 1 \| \[Comment\]\(\/b\)/)
  assert.match(table, /\na \| 1 \| 2 \| \[Comment\]\(\/a\)/)
  assert.match(table, /\n\*\*and 1 others\.\*\*\| \| /)
  assert.match(table, /\^\(This table will be updated every ~15 minutes\.\)/)
  // 3 unanswered of 6 top-level comments -> 50% helped.
  assert.match(table, /\*\*50% of users have been helped in this thread\*\*/)
  assert.doesNotMatch(table, /Would you like your post/)
})

test('unansweredTable: text=true includes the explanatory preamble', () => {
  const table = unansweredTable({
    rows: [row({})],
    topLevelCount: 1,
    length: 20,
    text: true,
    showPercents: false,
  })
  assert.match(table, /The following posts have less than two replies/)
  assert.doesNotMatch(table, /% of users have been helped/)
})

test('compareUnanswered: tuple ordering matches Python sort+reverse', () => {
  const a = row({author: 'a', helpedHere: 1, helpedAll: 1, createdSort: -100})
  const b = row({author: 'b', helpedHere: 1, helpedAll: 1, createdSort: -50})
  // createdSort is negated epoch, so descending puts the OLDER comment first.
  assert.deepEqual([a, b].sort(compareUnanswered)[0], b)
})
