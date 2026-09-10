/**
 * Trigger handlers. This is the hot path: on a busy thread it runs once per
 * comment posted to the subreddit, so it stays cheap and never touches the
 * Reddit API — the payload already carries everything the counters need.
 */
import {isTracked, recordComment} from './comment-store.ts'
import {parseCommentCreate} from './trigger-payload.ts'

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
