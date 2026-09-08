/**
 * Redis-backed state. Replaces the droplet's /opt/ffbot/state directory
 * (config_status.json + wiki_config_cache.yaml) and adds the run state the
 * chained scheduler jobs need, since a Devvit job cannot hold anything in
 * memory between invocations.
 */
import {redis} from '@devvit/web/server'
import type {
  FfbotConfig,
  ThreadAccumulator,
  ThreadConfig,
} from '../shared/types.ts'

const KEY_CONFIG_STATUS = 'ffbot:config:status'
const KEY_CONFIG_CACHE = 'ffbot:config:cache'
const KEY_RUN = 'ffbot:run:current'

/** One thread inside the current run. */
export type RunThread = {
  postId: string
  /** The thread's wiki body, fetched once at the start of the run. */
  body: string
  config: ThreadConfig
}

export type RunState = {
  runId: string
  date: string
  day: string
  zone: string
  threads: RunThread[]
  /** Index of the next thread to process. */
  cursor: number
  /** Cross-thread helper counts, accumulated as threads are processed. */
  helpCountAll: Record<string, number>
  /** Permalink of the News and Discussions thread, when one was posted. */
  newsLink?: string
}

export type ConfigStatus = 'ok' | 'failed' | 'unknown'

export async function getConfigStatus(): Promise<ConfigStatus> {
  const raw = await redis.get(KEY_CONFIG_STATUS)
  if (raw === 'ok' || raw === 'failed') return raw
  return 'unknown'
}

export async function setConfigStatus(status: ConfigStatus): Promise<void> {
  await redis.set(KEY_CONFIG_STATUS, status)
}

export async function cacheConfig(config: FfbotConfig): Promise<void> {
  await redis.set(KEY_CONFIG_CACHE, JSON.stringify(config))
}

export async function loadCachedConfig(): Promise<FfbotConfig | undefined> {
  const raw = await redis.get(KEY_CONFIG_CACHE)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as FfbotConfig
  } catch {
    return undefined
  }
}

export async function saveRun(run: RunState): Promise<void> {
  await redis.set(KEY_RUN, JSON.stringify(run))
}

export async function loadRun(): Promise<RunState | undefined> {
  const raw = await redis.get(KEY_RUN)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as RunState
  } catch {
    return undefined
  }
}

function accKey(runId: string, postId: string): string {
  return `ffbot:acc:${runId}:${postId}`
}

export async function saveAccumulator(
  runId: string,
  acc: ThreadAccumulator,
): Promise<void> {
  await redis.set(accKey(runId, acc.postId), JSON.stringify(acc))
  // Accumulators are per-run scratch; let them fall out on their own.
  await redis.expire(accKey(runId, acc.postId), 60 * 60 * 24 * 2)
}

export async function loadAccumulator(
  runId: string,
  postId: string,
): Promise<ThreadAccumulator | undefined> {
  const raw = await redis.get(accKey(runId, postId))
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as ThreadAccumulator
  } catch {
    return undefined
  }
}
