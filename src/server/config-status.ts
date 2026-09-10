/**
 * The config-health state machine, kept pure and separate from config.ts so it
 * can be tested without a Reddit client or Redis.
 *
 * The requirement it exists to guarantee: the moderators get EXACTLY ONE
 * modmail per state change, not one per run. The bot wakes up every 15 minutes,
 * so a broken wiki page that alerted on every cycle would send 96 modmails a
 * day and get the app muted.
 */

export type ConfigStatus = 'ok' | 'failed' | 'unknown'

/** What happened when we tried to load the wiki config this run. */
export type ConfigOutcome =
  /** The wiki page parsed. */
  | 'parsed'
  /** The wiki page did not parse, but a last-known-good copy is cached. */
  | 'failed-with-cache'
  /** The wiki page did not parse and there is nothing to fall back on. */
  | 'failed-no-cache'

export type ConfigAlert = 'restored' | 'broken-cached' | 'broken-no-cache'

export type ConfigAction = {
  /** The modmail to send, or undefined to stay quiet. */
  alert: ConfigAlert | undefined
  nextStatus: ConfigStatus
}

/**
 * Decide what to do given the previously recorded status and this run's
 * outcome. `unknown` is the cold-start state (nothing in Redis yet) and is
 * treated as "not currently failed", so the first broken run does alert.
 */
export function decideConfigAction(
  previous: ConfigStatus,
  outcome: ConfigOutcome,
): ConfigAction {
  const wasFailed = previous === 'failed'

  if (outcome === 'parsed') {
    // Only worth telling anyone if it was previously broken.
    return {alert: wasFailed ? 'restored' : undefined, nextStatus: 'ok'}
  }

  const alert: ConfigAlert =
    outcome === 'failed-with-cache' ? 'broken-cached' : 'broken-no-cache'
  return {alert: wasFailed ? undefined : alert, nextStatus: 'failed'}
}
