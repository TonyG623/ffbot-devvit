/**
 * TEMPORARY. Delete this file, its call in runCycle, and its two Redis keys
 * once the trigger payload shape is confirmed.
 *
 * Why it exists: `trigger-payload.ts` is written against the protobuf
 * definitions because @devvit/web exports no type for a trigger POST body, so
 * the wire shape is inferred rather than contracted. The only thing that
 * exercises it is a real comment arriving on a tracked thread — and the
 * reconciliation walk does NOT exercise it, because that path builds its own
 * objects from the Reddit API instead of parsing an event.
 *
 * So this posts one top-level comment and one reply to it, as the app account,
 * which should fire onCommentCreate twice and cover both parentId branches
 * (`t3_` = top-level, `t1_` = direct reply).
 *
 * SAFETY. This writes to Reddit, so it is fenced three ways:
 *   1. It refuses to run anywhere except the subreddit named below. There is no
 *      config or parameter that can point it at r/fantasyfootball.
 *   2. It runs AT MOST ONCE, guarded by a Redis key.
 *   3. Both comments are clearly labelled as bot self-tests.
 */
import {reddit, redis} from '@devvit/web/server'

/** Hardcoded. Not configurable, not derived from context. */
const ONLY_SUBREDDIT = 'ffbottest'

/**
 * Bumped to re-run after the out-of-order fix. Run 1 proved triggers fire and
 * the payload parses, and exposed that a reply's event can be delivered before
 * its parent's. Run 2 verifies the pending-reply rescue against that.
 */
const KEY_DONE = 'ffbot:selftest:done:2'

/** Long enough to clear the >20 character substantive-reply threshold. */
const REPLY_TEXT =
  'FFBot self-test reply. This exists to verify the onCommentCreate trigger ' +
  'payload parses correctly, and is long enough to count as a substantive ' +
  'reply. Safe to delete.'

const TOP_TEXT =
  'FFBot self-test comment. Verifying that the comment trigger fires and that ' +
  'its payload parses. Safe to delete.'

export async function maybeRunSelfTest(
  subredditName: string,
  postIds: string[],
): Promise<void> {
  if (subredditName.toLowerCase() !== ONLY_SUBREDDIT) return
  if (postIds.length === 0) return
  if (await redis.get(KEY_DONE)) return

  // Claim before posting, not after: a crash mid-post must not leave this
  // looping and spraying comments on every cron tick.
  await redis.set(KEY_DONE, '1')

  const postId = postIds[0]
  if (!postId) return

  try {
    console.log(`SELFTEST posting a test comment on ${postId}`)
    const top = await reddit.submitComment({
      id: postId as `t3_${string}`,
      text: TOP_TEXT,
    })
    console.log(`SELFTEST posted top-level ${top.id}`)

    const reply = await reddit.submitComment({
      id: top.id,
      text: REPLY_TEXT,
    })
    console.log(`SELFTEST posted reply ${reply.id} to ${top.id}`)
    console.log(
      'SELFTEST done. Watch for COUNTED lines for BOTH comments. If the reply ' +
        'event again beats the parent it should log orphan-reply first and ' +
        'then be rescued when the parent lands; the thread must end up with a ' +
        'top helper rather than none.',
    )
  } catch (err) {
    console.warn(`SELFTEST failed: ${String(err)}`)
  }
}
