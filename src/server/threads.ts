/**
 * Which threads post today, and under which zone. Pure — no Reddit client, no
 * Redis — so the rules are unit tested rather than waited on for a week to see
 * whether Monday's thread shows up.
 *
 * Port of the selection block in post_daily_threads.py:
 *
 *     thread_configs = sorted(config['threads'], key=lambda k: k['title'])
 *     thread_configs = [t for t in thread_configs if t.get('enabled', True)]
 *     for thread_config in thread_configs:
 *         if 'day' in thread_config and thread_config['day'] != current_day_full:
 *             continue
 */
import type {FfbotConfig, ThreadConfig} from '../shared/types.ts'

/**
 * True when `cfg` may post on `dayFull` ("monday", lowercase).
 *
 * DELIBERATE DIVERGENCE from the Python: the comparison is case-insensitive and
 * trimmed. The Python compares against `strftime('%A').lower()`, so a wiki entry
 * written `day: "Monday"` matches nothing and that thread silently never posts,
 * with no error anywhere. Nobody means that. Lowercase configs behave
 * identically either way, so this only ever rescues a typo.
 */
export function postsOnDay(cfg: ThreadConfig, dayFull: string): boolean {
  if (cfg.day === undefined) return true
  return cfg.day.trim().toLowerCase() === dayFull.trim().toLowerCase()
}

/**
 * The threads to post today, in the Python's order: sorted by title, enabled
 * only, day-restricted ones only on their day.
 */
export function selectThreads(
  threads: ThreadConfig[],
  dayFull: string,
): ThreadConfig[] {
  return threads
    .filter(t => t.enabled !== false)
    .filter(t => postsOnDay(t, dayFull))
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
}

/**
 * Posts per day, wiki config first, then the subreddit setting.
 *
 * The wiki is the source of truth, so a value there wins. When the wiki omits
 * it the subreddit setting applies — which requires `posts_per_day` to be
 * genuinely absent from the parsed config rather than defaulted to 1, or the
 * setting is unreachable and the dropdown in the app's settings does nothing.
 */
export function resolvePostsPerDay(
  config: Pick<FfbotConfig, 'posts_per_day'>,
  settingValue: number,
): number {
  return config.posts_per_day ?? settingValue
}
