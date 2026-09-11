/**
 * Trigger handlers. This is the hot path: on a busy thread it runs once per
 * comment posted to the subreddit, so it stays cheap and never touches the
 * Reddit API — the payload already carries everything the counters need.
 */
import {
  clearThreadState,
  forgetComment,
  isTracked,
  recordComment,
  untrackPost,
} from './comment-store.ts'
import {parseCommentCreate, parseDelete} from './trigger-payload.ts'

/**
 * The wire format is inferred from the protobufs rather than contracted by the
 * SDK, so the first payload of each process is logged in full. If the counters
 * ever look wrong, this log line is the first thing to read: it shows what
 * Devvit actually sent versus what trigger-payload.ts expected.
 */
let loggedSample = false

export async function onCommentCreate(raw: unknown): Promise<void> {
  const parsed = parseCommentCreate(raw)

  if (!loggedSample) {
    loggedSample = true
    console.log(
      `TRIGGER first payload sample: ${JSON.stringify(raw).slice(0, 1500)}`,
    )
    console.log(`TRIGGER parsed as: ${JSON.stringify(parsed)}`)
  }

  if (!parsed) {
    console.warn('WARN: could not parse comment-create payload; ignoring')
    return
  }

  // The trigger fires for EVERY comment in the subreddit. Most are not on a
  // bot thread, and this is the cheap gate that drops them: one Redis get.
  if (!(await isTracked(parsed.postId))) return

  const kind = await recordComment(parsed)
  if (kind === 'top-level' || kind === 'direct-reply') {
    console.log(
      `COUNTED ${kind} ${parsed.commentId} on ${parsed.postId} by ${parsed.author}`,
    )
  }
}

/**
 * REQUIRED BY THE DEVVIT RULES. "On PostDelete and CommentDelete event
 * triggers, you must delete all content related to the post and/or comment ...
 * from your app. This includes data that is in the Redis/KVstore."
 *
 * This app stores usernames in its counters and an author plus permalink per
 * top-level comment, so a deletion has to reach Redis promptly. The
 * reconciliation walk also prunes vanished comments, but it only visits one
 * thread per cycle -- far too slow to rely on for a deletion request.
 */
export async function onCommentDelete(raw: unknown): Promise<void> {
  const parsed = parseDelete(raw)
  if (!parsed?.commentId || !parsed.postId) {
    console.warn('WARN: could not parse comment-delete payload; ignoring')
    return
  }
  if (!(await isTracked(parsed.postId))) return

  const what = await forgetComment(parsed.postId, parsed.commentId)
  console.log(
    `FORGOT ${what} ${parsed.commentId} on ${parsed.postId} (deleted)`,
  )
}

/** Same requirement, for a whole post: drop everything stored about it. */
export async function onPostDelete(raw: unknown): Promise<void> {
  const parsed = parseDelete(raw)
  if (!parsed?.postId) {
    console.warn('WARN: could not parse post-delete payload; ignoring')
    return
  }
  if (!(await isTracked(parsed.postId))) return

  await clearThreadState(parsed.postId)
  await untrackPost(parsed.postId)
  console.log(`FORGOT everything stored for ${parsed.postId} (post deleted)`)
}
