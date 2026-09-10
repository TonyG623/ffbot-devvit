/**
 * HANDOFF "Still to test" items 2 and 3, as tests rather than as a week of
 * waiting to see whether Monday's thread turns up on Monday.
 */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {DEFAULT_CONFIG, type ThreadConfig} from '../shared/types.ts'
import {threadZone} from './dates.ts'
import {postsOnDay, resolvePostsPerDay, selectThreads} from './threads.ts'

function thread(over: Partial<ThreadConfig> = {}): ThreadConfig {
  return {
    title: 'Trade',
    flair_text: 'Daily Thread',
    flair_css: 'daily',
    wiki: 'trade',
    ...over,
  }
}

// ------------------------------------------------- item 2: day restriction

test('an unrestricted thread posts every day', () => {
  const t = thread()
  for (const day of ['monday', 'thursday', 'sunday']) {
    assert.equal(postsOnDay(t, day), true)
  }
})

test('a day-restricted thread posts ONLY on its day', () => {
  const monday = thread({title: 'Monday Miracle', day: 'monday'})
  assert.equal(postsOnDay(monday, 'monday'), true)
  for (const day of [
    'sunday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ]) {
    assert.equal(postsOnDay(monday, day), false, `must not post on ${day}`)
  }
})

test('day matching is case-insensitive (deliberate divergence)', () => {
  // The Python compares against strftime('%A').lower(), so `day: "Monday"` in
  // the wiki matches nothing and that thread silently never posts, ever, with
  // no error raised anywhere. This is the one place the port is more forgiving.
  assert.equal(postsOnDay(thread({day: 'Monday'}), 'monday'), true)
  assert.equal(postsOnDay(thread({day: ' MONDAY '}), 'monday'), true)
  // Still not a match for a different day, obviously.
  assert.equal(postsOnDay(thread({day: 'Monday'}), 'tuesday'), false)
})

test('selectThreads drops disabled threads and sorts by title', () => {
  const threads = [
    thread({title: 'Trade'}),
    thread({title: 'Add/Drop'}),
    thread({title: 'Turned Off', enabled: false}),
    thread({title: 'Keeper'}),
  ]
  const picked = selectThreads(threads, 'thursday').map(t => t.title)
  assert.deepEqual(picked, ['Add/Drop', 'Keeper', 'Trade'])
})

test('selectThreads applies enabled AND day together', () => {
  const threads = [
    thread({title: 'Daily'}),
    thread({title: 'Monday Miracle', day: 'monday'}),
    thread({title: 'Free Talk Friday', day: 'friday'}),
    thread({title: 'Monday Off', day: 'monday', enabled: false}),
  ]
  assert.deepEqual(
    selectThreads(threads, 'monday').map(t => t.title),
    ['Daily', 'Monday Miracle'],
  )
  assert.deepEqual(
    selectThreads(threads, 'friday').map(t => t.title),
    ['Daily', 'Free Talk Friday'],
  )
  assert.deepEqual(
    selectThreads(threads, 'sunday').map(t => t.title),
    ['Daily'],
  )
})

// ------------------------------------------------- item 3: posts per day

test('posts_per_day 2 and 3 produce the documented zones', () => {
  // 1 post/day has no zone at all; the title collapses the empty gap.
  assert.equal(threadZone(1, 9), '')

  // 2/day splits at 08:00 and 16:00.
  assert.equal(threadZone(2, 7), 'Evening ')
  assert.equal(threadZone(2, 8), 'Morning ')
  assert.equal(threadZone(2, 15), 'Morning ')
  assert.equal(threadZone(2, 16), 'Evening ')

  // 3/day splits at 06:00, 11:00 and 18:00.
  assert.equal(threadZone(3, 5), 'Evening ')
  assert.equal(threadZone(3, 6), 'Morning ')
  assert.equal(threadZone(3, 10), 'Morning ')
  assert.equal(threadZone(3, 11), 'Afternoon ')
  assert.equal(threadZone(3, 17), 'Afternoon ')
  assert.equal(threadZone(3, 18), 'Evening ')
})

test('REGRESSION: the postsPerDay subreddit setting is reachable', () => {
  // It was not. DEFAULT_CONFIG supplied posts_per_day: 1, so
  // `config.posts_per_day ?? setting` never fell through and the setting in
  // devvit.json did nothing at all.
  assert.equal(
    'posts_per_day' in DEFAULT_CONFIG,
    false,
    'a default here shadows the subreddit setting',
  )

  // Wiki omits it -> the setting wins.
  assert.equal(resolvePostsPerDay({}, 3), 3)
  // Wiki sets it -> the wiki wins, because the wiki is the source of truth.
  assert.equal(resolvePostsPerDay({posts_per_day: 2}, 3), 2)
  // And a wiki value of 1 is a real value, not an absent one.
  assert.equal(resolvePostsPerDay({posts_per_day: 1}, 3), 1)
})
