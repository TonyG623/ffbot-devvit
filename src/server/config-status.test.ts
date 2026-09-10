/**
 * HANDOFF "Still to test" item 4: the wiki-config-breakage modmail.
 *
 * The requirement that actually matters is "exactly one modmail per state
 * change, not one per run". The bot wakes every 15 minutes, so getting this
 * wrong means 96 modmails a day and a muted app. That is a property of the
 * state machine, so it is tested as one rather than by breaking the live wiki
 * and watching an inbox.
 */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  type ConfigOutcome,
  type ConfigStatus,
  decideConfigAction,
} from './config-status.ts'

/** Run a sequence of outcomes, returning the alerts actually sent. */
function runSequence(outcomes: ConfigOutcome[]): {
  alerts: (string | undefined)[]
  finalStatus: ConfigStatus
} {
  let status: ConfigStatus = 'unknown'
  const alerts: (string | undefined)[] = []
  for (const outcome of outcomes) {
    const action = decideConfigAction(status, outcome)
    alerts.push(action.alert)
    status = action.nextStatus
  }
  return {alerts, finalStatus: status}
}

test('a healthy bot never modmails anyone', () => {
  const {alerts, finalStatus} = runSequence([
    'parsed',
    'parsed',
    'parsed',
    'parsed',
  ])
  assert.deepEqual(alerts, [undefined, undefined, undefined, undefined])
  assert.equal(finalStatus, 'ok')
})

test('THE requirement: a persistently broken wiki alerts exactly ONCE', () => {
  // Sixteen cycles is four hours of a broken wiki page.
  const {alerts, finalStatus} = runSequence([
    'parsed',
    ...Array<ConfigOutcome>(16).fill('failed-with-cache'),
  ])
  assert.equal(alerts[0], undefined)
  assert.equal(alerts[1], 'broken-cached', 'the first failure must alert')
  assert.deepEqual(
    alerts.slice(2),
    Array(15).fill(undefined),
    'every later failure must stay silent',
  )
  assert.equal(finalStatus, 'failed')
})

test('the full break-then-fix cycle sends exactly two modmails', () => {
  const {alerts} = runSequence([
    'parsed', // healthy
    'failed-with-cache', // breaks -> alert
    'failed-with-cache', // still broken -> silent
    'failed-with-cache', // still broken -> silent
    'parsed', // fixed -> alert
    'parsed', // healthy -> silent
  ])
  assert.deepEqual(alerts, [
    undefined,
    'broken-cached',
    undefined,
    undefined,
    'restored',
    undefined,
  ])
})

test('a cold start on a broken wiki still alerts', () => {
  // "unknown" is the state before Redis has ever been written. Treating it as
  // already-failed would swallow the very first alert.
  const action = decideConfigAction('unknown', 'failed-no-cache')
  assert.equal(action.alert, 'broken-no-cache')
  assert.equal(action.nextStatus, 'failed')
})

test('a cold start on a healthy wiki says nothing', () => {
  const action = decideConfigAction('unknown', 'parsed')
  assert.equal(action.alert, undefined)
  assert.equal(action.nextStatus, 'ok')
})

test('the no-cache alert is distinct from the cached one', () => {
  // They say different things: one means "still posting from cache", the other
  // means "not posting at all". Collapsing them would misinform the mods.
  assert.equal(
    decideConfigAction('ok', 'failed-with-cache').alert,
    'broken-cached',
  )
  assert.equal(
    decideConfigAction('ok', 'failed-no-cache').alert,
    'broken-no-cache',
  )
})

test('recovery alerts even if the break happened before this process started', () => {
  assert.equal(decideConfigAction('failed', 'parsed').alert, 'restored')
})

test('flapping alerts on each transition, not on each run', () => {
  const {alerts} = runSequence([
    'parsed',
    'failed-with-cache',
    'parsed',
    'failed-with-cache',
    'parsed',
  ])
  assert.deepEqual(alerts, [
    undefined,
    'broken-cached',
    'restored',
    'broken-cached',
    'restored',
  ])
})
