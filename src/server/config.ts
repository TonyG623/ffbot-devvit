/**
 * Config loading. Port of load_config / _save_cache / _load_cache /
 * _send_mod_alert from post_daily_threads.py.
 *
 * The wiki page `r/<sub>/wiki/ffbot` remains the source of truth. On a parse
 * failure the app falls back to the last-known-good config from Redis and
 * modmails the moderators exactly once per state change, as the Python did.
 */
import {context, reddit} from '@devvit/web/server'
import {parse as parseYaml} from 'yaml'
import {DEFAULT_CONFIG, type FfbotConfig} from '../shared/types.ts'
import {
  type ConfigAlert,
  type ConfigOutcome,
  decideConfigAction,
} from './config-status.ts'
import {
  cacheConfig,
  getConfigStatus,
  loadCachedConfig,
  setConfigStatus,
} from './state.ts'
import {extractYaml} from './yaml-extract.ts'

export const WIKI_CONFIG_PAGE = 'ffbot'

/** Send a modmail notification to the subreddit the app is installed in. */
export async function sendModAlert(
  subject: string,
  bodyMarkdown: string,
): Promise<void> {
  try {
    const subredditId = context.subredditId
    if (!subredditId) throw new Error('no subredditId in context')
    await reddit.modMail.createModNotification({
      subject,
      bodyMarkdown,
      subredditId,
    })
    console.log(`Sent modmail alert: ${subject}`)
  } catch (err) {
    console.warn(`WARN: modmail send failed: ${String(err)}`)
  }
}

/** Fetch a wiki page's markdown, or undefined when it does not exist. */
export async function getWiki(
  subredditName: string,
  page: string,
): Promise<string | undefined> {
  try {
    const wiki = await reddit.getWikiPage(subredditName, page)
    // The Python un-escaped these so raw HTML in wiki bodies survived.
    return wiki.content.replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  } catch {
    return undefined
  }
}

/** Body used when a thread's wiki page is missing — matches the Python. */
export const NO_WIKI_FOUND = 'No Wiki Found'

/** Render the modmail for an alert. Kept next to the state machine it serves. */
function alertBody(
  alert: ConfigAlert,
  subredditName: string,
  detail: string,
): {subject: string; body: string} {
  const wikiUrl = `https://www.reddit.com/r/${subredditName}/wiki/${WIKI_CONFIG_PAGE}`
  // Four leading spaces render `detail` as a markdown code block in modmail.
  const quoted = `\n\n    ${detail}\n\n`
  switch (alert) {
    case 'restored':
      return {
        subject: 'FFBot wiki config restored',
        body: 'The ffbot wiki page is parsing correctly again. The bot is back on the live config.',
      }
    case 'broken-cached':
      return {
        subject: 'FFBot wiki config broken - using cached version',
        body:
          `The ffbot wiki page at ${wikiUrl} could not be loaded:${quoted}` +
          'The bot is using the last-known-good wiki config. Posting will continue with ' +
          'the previous settings. Fix the wiki - you will get another modmail when the ' +
          'bot picks up the fix.',
      }
    case 'broken-no-cache':
      return {
        subject: 'FFBot wiki config broken - cannot post',
        body:
          `The ffbot wiki page at ${wikiUrl} could not be loaded and there is ` +
          `no cached config to fall back on:${quoted}` +
          'The bot will not post until the wiki is fixed.',
      }
  }
}

/**
 * Run one step of the config-health state machine: alert only on a transition,
 * then record the new status.
 */
async function applyConfigAction(
  previous: Awaited<ReturnType<typeof getConfigStatus>>,
  outcome: ConfigOutcome,
  subredditName: string,
  detail: string,
): Promise<void> {
  const {alert, nextStatus} = decideConfigAction(previous, outcome)
  if (alert) {
    const {subject, body} = alertBody(alert, subredditName, detail)
    await sendModAlert(subject, body)
  }
  await setConfigStatus(nextStatus)
}

export type LoadConfigResult =
  | {ok: true; config: FfbotConfig; source: 'wiki' | 'cache'}
  | {ok: false}

/**
 * Load config from the wiki, falling back to the cached last-known-good copy.
 * Returns `{ok: false}` when there is neither — the caller should stop without
 * posting, as the Python did with sys.exit(0).
 */
export async function loadConfig(
  subredditName: string,
): Promise<LoadConfigResult> {
  const status = await getConfigStatus()

  try {
    const raw = await getWiki(subredditName, WIKI_CONFIG_PAGE)
    if (raw === undefined)
      throw new Error(`wiki page ${WIKI_CONFIG_PAGE} not found`)

    const parsed = parseYaml(extractYaml(raw)) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('threads' in parsed) ||
      !Array.isArray((parsed as {threads: unknown}).threads)
    ) {
      throw new Error('wiki YAML must be a mapping with a "threads" key')
    }

    const config: FfbotConfig = {
      ...DEFAULT_CONFIG,
      ...(parsed as Partial<FfbotConfig>),
      threads: (parsed as FfbotConfig).threads,
      subreddit: subredditName,
    }

    await cacheConfig(config)
    await applyConfigAction(status, 'parsed', subredditName, '')
    console.log(
      `Loaded config from r/${subredditName}/wiki/${WIKI_CONFIG_PAGE}`,
    )
    return {ok: true, config, source: 'wiki'}
  } catch (err) {
    const detail =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.warn(`WARN: wiki config load failed (${detail})`)

    const cached = await loadCachedConfig()

    if (cached) {
      cached.subreddit = subredditName
      await applyConfigAction(
        status,
        'failed-with-cache',
        subredditName,
        detail,
      )
      console.log('Using cached wiki config')
      return {ok: true, config: cached, source: 'cache'}
    }

    await applyConfigAction(status, 'failed-no-cache', subredditName, detail)
    console.log('No cached config available - exiting without posting')
    return {ok: false}
  }
}
