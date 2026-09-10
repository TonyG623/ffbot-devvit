/**
 * TEMPORARY SCAFFOLDING. This whole file is deleted before the port ships.
 *
 * Phase 1 (done) posted self-test comments to prove the onCommentCreate
 * trigger fires and that trigger-payload.ts parses a real payload. It did, and
 * it caught trigger reordering -- see HANDOFF.md.
 *
 * Phase 2 (this) removes those comments again, so r/ffbottest is not left
 * carrying bot test chatter. Deletion of a Reddit comment is NOT reversible,
 * which is fine here: every id below was authored by this app minutes ago as
 * test scaffolding, and nothing else is touched.
 *
 * SAFETY, unchanged from phase 1:
 *   1. Refuses to run anywhere except the hardcoded subreddit.
 *   2. Runs at most once, guarded by a Redis key claimed BEFORE acting.
 *   3. Operates only on this explicit id list -- it cannot walk a thread and
 *      delete something it merely believes to be a self-test.
 */
import {reddit, redis} from '@devvit/web/server'

/** Hardcoded. Not configurable, not derived from context. */
const ONLY_SUBREDDIT = 'ffbottest'

const KEY_DONE = 'ffbot:selftest:cleanup'

/** The exact comments the self-test created, in both runs. Nothing else. */
const SELF_TEST_COMMENTS = [
  't1_p91wycx', // run 1 top-level
  't1_p91wydt', // run 1 reply (the one the ordering bug lost)
  't1_p91zoxx', // run 2 top-level
  't1_p91zoyz', // run 2 reply (the one the fix rescued)
] as const

export async function maybeRunSelfTest(
  subredditName: string,
  _postIds: string[],
): Promise<void> {
  if (subredditName.toLowerCase() !== ONLY_SUBREDDIT) return
  if (await redis.get(KEY_DONE)) return
  await redis.set(KEY_DONE, '1')

  for (const id of SELF_TEST_COMMENTS) {
    try {
      const comment = await reddit.getCommentById(id)
      await comment.delete()
      console.log(`CLEANUP deleted self-test comment ${id}`)
    } catch (err) {
      // Already gone, or never existed. Not worth failing a cycle over.
      console.warn(`CLEANUP could not delete ${id}: ${String(err)}`)
    }
  }
  console.log('CLEANUP done; selftest.ts can now be removed from the tree')
}
