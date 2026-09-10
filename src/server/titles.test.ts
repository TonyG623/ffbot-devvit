/**
 * Oracle test: the live Python FFBot's real titles from r/fantasyfootball,
 * captured 2026-09-08, versus the titles this port generates for the same day.
 *
 * These strings were read from https://www.reddit.com/user/FFBot/submitted.json
 * while the original bot was running in production. If the port's title
 * construction drifts from the Python's, this test fails.
 */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {squashWhitespace, threadDate, threadZone} from './dates.ts'

/** Verbatim from the live bot, 2026-09-08. */
const LIVE_TITLES = [
  'Official: [Index] - For All Your Team/League Questions - Tue 09/08/2026',
  'Official: [Who Do I Draft?] - Tue 09/08/2026',
  'Official: [WDIS WR] - Tue 09/08/2026',
  'Official: [WDIS RB] - Tue 09/08/2026',
  'Official: [WDIS QB] - Tue 09/08/2026',
  'Official: [WDIS K/TE/DEF] - Tue 09/08/2026',
  'Official: [WDIS Flex] - Tue 09/08/2026',
  'Official: [Trade] - Tue 09/08/2026',
  'Official: [Rate My Team] - Tue 09/08/2026',
  'Official: [Mock Draft] - Tue 09/08/2026',
  'Official: [League, Commissioner, and Platform Issues] - Tue 09/08/2026',
  'Official: [Keeper] - Tue 09/08/2026',
  'Official: [Dynasty, Best Ball, and Guillotine Strategy] - Tue 09/08/2026',
  'Official: [Add/Drop] - Tue 09/08/2026',
]

// 2026-09-08 15:00 UTC == 10:00 America/Chicago, past the 6am rollover.
const NOW = new Date('2026-09-08T15:00:00Z')
const TZ = 'America/Chicago'

function generate(configTitle: string): string {
  const td = threadDate(NOW, TZ, 6)
  const zone = threadZone(1, td.hour).trim()
  return squashWhitespace(
    `Official: [${configTitle}] - ${td.day} ${zone} ${td.date}`,
  )
}

function generateIndex(): string {
  const td = threadDate(NOW, TZ, 6)
  const zone = threadZone(1, td.hour).trim()
  return squashWhitespace(
    `Official: [Index] - For All Your Team/League Questions - ${td.day} ${zone} ${td.date}`,
  )
}

test('port reproduces the live bot title for every daily thread', () => {
  for (const live of LIVE_TITLES) {
    if (live.startsWith('Official: [Index]')) continue
    const configTitle = live.slice('Official: ['.length, live.indexOf('] - '))
    assert.equal(generate(configTitle), live, `mismatch for "${configTitle}"`)
  }
})

test('port reproduces the live bot Index title', () => {
  assert.equal(
    generateIndex(),
    'Official: [Index] - For All Your Team/League Questions - Tue 09/08/2026',
  )
})

test('titles containing brackets, slashes and commas survive unchanged', () => {
  // These are the awkward ones: a "?" title, a "/" title, and a comma-heavy one.
  assert.equal(
    generate('Who Do I Draft?'),
    'Official: [Who Do I Draft?] - Tue 09/08/2026',
  )
  assert.equal(
    generate('WDIS K/TE/DEF'),
    'Official: [WDIS K/TE/DEF] - Tue 09/08/2026',
  )
  assert.equal(
    generate('Dynasty, Best Ball, and Guillotine Strategy'),
    'Official: [Dynasty, Best Ball, and Guillotine Strategy] - Tue 09/08/2026',
  )
})

test('the empty thread zone leaves exactly one space, not two', () => {
  // posts_per_day=1 yields an empty zone; the Python relied on re.sub to
  // collapse the resulting double space. Verify no "Tue  09/08" slips through.
  for (const live of LIVE_TITLES) assert.ok(!live.includes('  '))
  assert.ok(!generate('Trade').includes('  '))
})
