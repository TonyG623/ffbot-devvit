/** Shape of the YAML config stored on the subreddit wiki (page: `ffbot`). */

export type ThreadConfig = {
  /** Human title fragment, e.g. "Keeper" -> "Official: [Keeper] - ..." */
  title: string
  /** Flair text applied to the submitted post. */
  flair_text: string
  /** Flair CSS class applied to the submitted post. */
  flair_css: string
  /** Wiki page under `ffbot/` holding this thread's body. */
  wiki: string
  /** Restrict posting to a single weekday, lowercase, e.g. "monday". */
  day?: string
  /** Pin the thread to the bottom sticky slot. */
  sticky?: boolean
  /** Skip the unanswered/leaderboard tables for this thread. */
  no_table?: boolean
  /** Defaults to true when absent. */
  enabled?: boolean
}

export type FfbotConfig = {
  threads: ThreadConfig[]
  subreddit: string
  index: boolean
  news_and_discussion: boolean
  posts_per_day: number
  show_percents: boolean
  wdis_replace: boolean
}

/** One row of the "unanswered questions" table. */
export type UnansweredRow = {
  author: string
  /** Replies this author has written in THIS thread. */
  helpedHere: number
  /** Replies this author has written across all of today's threads. */
  helpedAll: number
  /** Negative created-utc, so a plain descending sort puts newest last. */
  createdSort: number
  permalink: string
}

/** Per-thread accumulator persisted in Redis between chained job runs. */
export type ThreadAccumulator = {
  postId: string
  /** username -> number of substantive replies written in this thread. */
  helpCount: Record<string, number>
  /** Top-level comments with fewer than the reply threshold. */
  unanswered: UnansweredRow[]
  /** Total top-level comments seen, for the "% helped" figure. */
  topLevelSeen: number
  /** True when a run hit its time budget before finishing the listing. */
  partial: boolean
}

export const DEFAULT_CONFIG: Omit<FfbotConfig, 'threads' | 'subreddit'> = {
  index: true,
  news_and_discussion: false,
  posts_per_day: 1,
  show_percents: false,
  wdis_replace: true,
}
