# FFBot Devvit port: handoff

Paste this into a coding session with terminal access, run from
`C:\Users\tgrol\repos\ffbot-devvit`.

---

## What this is

FFBot is a Reddit bot that has run r/fantasyfootball's daily threads for years:
Python + PRAW on a DigitalOcean droplet, driven by cron. Reddit offered a $1,000
bounty to port it onto Devvit (their Developer Platform, where Reddit hosts the
app). The modmail arrived **2026-09-07** and gives 60 days, so the deadline is
**2026-11-06**. (An earlier draft of this file said Sep 8 / Nov 7; the modmail
screenshot is dated Sep 7, so the real deadline is a day earlier.)

The port is written and **running live on r/ffbottest**. It is not on
r/fantasyfootball yet.

- Original Python: `C:\Users\tgrol\repos\FFBotPrivate` (a ZIP snapshot, not a
  git clone; the real repo is github.com/TonyG623/FFBotPrivate, private)
- Port: this folder, and github.com/TonyG623/ffbot-devvit (public)
- Devvit app name: **`ffbot-app`** (`ffbot` was taken by the existing u/FFBot
  account). App account is u/ffbot-app.
- Reddit accounts: u/tonyg623 (developer) and u/FFBot (the old bot). Both
  moderate r/fantasyfootball.

## How to run it

```
playtest.cmd          # installs to r/ffbottest and streams logs, leave open
```

Or by hand: `npm install`, `npm test`, `npx devvit login`, `npx devvit playtest r/ffbottest`.

Trigger a cycle from the subreddit three dot menu, item "[FFBot] Run cycle now".
**Devvit menu actions only render on new Reddit**, and tonyg623 is opted out of
the redesign, so use `https://sh.reddit.com/r/ffbottest/?playtest=ffbot-app`.
Otherwise wait up to 15 minutes for the cron.

## Architecture, and the one decision that drove it

Devvit jobs have a **30 second execution limit**, and the Devvit Reddit API is
rate limited to roughly **4 requests per second**. The second constraint turned
out to matter far more than the first.

The port originally walked every comment of every thread each cycle. That was
measured against live r/fantasyfootball threads and **it does not survive the
season** — a 541-comment thread took 19.6s of a 20s budget, and the next one up
timed out. See "Still to test" item 1 for the full numbers.

So the counting is now **incremental, driven by the comment trigger**:

```
onCommentCreate  ->  fold one comment into Redis counters   (0 Reddit API calls)

cycle (cron */15)   ensure today's threads exist  -> chain
  reconcile   repair ONE thread per cycle, rotating (bounded, ~20s of API)
  render      edit every thread body FROM REDIS    (1 edit each, no walking)
  index       build and post the stickied Index thread
```

The trigger payload already carries author, body, `parentId` and permalink, so
maintaining the counters costs no Reddit API calls at all. Cost is O(new
comments) instead of O(all comments) every fifteen minutes, which is flat as
threads grow into the thousands.

Key files:

| file | role |
|---|---|
| `comment-counting.ts` | the counting rules; takes a Redis handle explicitly so it is unit testable |
| `comment-store.ts` | thin binding of those rules to the real Devvit client; holds no logic |
| `trigger-payload.ts` | parses the trigger body; the wire shape is INFERRED, see below |
| `triggers.ts` | the hot path, once per comment in the subreddit |
| `comments.ts` | `walkThread`, now only the reconciliation reader |

**Every counter write is a single atomic Redis field op** (`hSetNX`/`hIncrBy`).
Comment triggers fire concurrently, and read-modify-write on a shared JSON blob
would lose updates under exactly the load a busy thread produces.

`recordComment` is **idempotent** — it claims each comment id via `hSetNX`
before counting. That is what makes redelivered triggers safe, and what lets the
reconciliation walk re-read comments already counted without double counting.

### Reconciliation, and why it is rotated

Triggers drift four ways: comments posted while the app was down, mod removals
(no create event fires), events Devvit simply does not deliver, and **comments
their author deleted** -- nothing fires for that either, and the trigger path
only ever ADDS. So a bounded walk repairs **one thread per cycle, rotating**
via a Redis counter.

Deletion repair is the subtle one. `pruneMissing` reverses exactly what a
vanished comment contributed, which is why every counted reply is recorded
individually: aggregate counts cannot be un-done, because they do not remember
who contributed what. Pruning runs ONLY after a complete walk (a partial pass
has not seen the whole thread, so absence proves nothing) and ONLY for comments
older than the moment the walk began (anything newer cannot be expected in what
the walk saw, and pruning it would delete what the trigger had just correctly
counted).
Reconciling every thread every cycle would re-incur the exact rate-limited cost
the trigger design exists to avoid. Rotating gives a flat ~20s of API time per
cycle regardless of thread count; each thread gets repaired every N cycles.

Config lives on the subreddit wiki at `r/<sub>/wiki/ffbot` (YAML in a 4-space
indented block), with per-thread body pages at `r/<sub>/wiki/ffbot/<name>`.
Config is re-read every cycle, so wiki edits take effect with no redeploy.

## Trigger payloads: CONTRACTED, and mostly verified

**Correction to an earlier claim in this file.** It said `@devvit/web` exports
no type for a trigger body and that the shapes were inferred from protobufs.
That was wrong. `@devvit/web/shared` re-exports `OnCommentCreateRequest`,
`OnCommentDeleteRequest` and `OnPostDeleteRequest` from
`@devvit/shared/types/triggers.d.ts`. They are named `On*Request`, not after the
proto messages, which is why searching for the message names found nothing.
`trigger-payload.ts` now uses them, so the shapes are contracted rather than
guessed. They are still TypeScript types over unvalidated JSON, so fields are
read defensively.

### onCommentCreate: VERIFIED live

Confirmed against a real delivered event. One trap, which the live payload
exposed:

**`comment.author` is a USER ID, not a username.** The live payload carried
`"author":"t2_2mjbzpp4by"`. The username is on the SIBLING `author` object as
`.name`. Reading `comment.author` puts raw `t2_` ids on the leaderboards.

**TRIGGERS ARE NOT ORDERED.** Observed twice: a comment and a reply posted a
second apart, and the REPLY's event was delivered first both times. See
`drainPending`; a `RESCUED n out-of-order replies` log line is it happening.

### onCommentDelete / onPostDelete: WIRED, NOT YET OBSERVED

Required by the Devvit Rules, handled, and unit tested — but no delete event has
ever been seen arrive.

A self-test had the app post a comment and then delete it via the API. **No
event fired.** That test was not representative, and the reason is in the types:
`EventSource` is `USER | ADMIN | MODERATOR` with no APP value, and the triggers
doc says triggers respond to "a user's or moderator's action". An app deleting
its own comment is none of those.

So the open question is narrow: does a REAL user deleting their own comment fire
it? To settle it, comment on an r/ffbottest daily thread from a normal account,
delete the comment, and watch for `FORGOT top-level …`. The log line includes
`source=` and `reason=` to confirm provenance.

If it turns out not to fire at all, the fallback is the reconciliation walk,
which already prunes vanished comments and refreshes tombstoned authors (both
verified live) — but it visits one thread per cycle, so it is slower than the
rules intend, and the submission should say so rather than claim a trigger path
that does not fire.

## Verified live on r/ffbottest

- Wiki config load and YAML parse
- Date, thread zone and title generation. Titles were diffed against the LIVE
  Python bot's real r/fantasyfootball output for 2026-09-08: all 14 matched
  exactly (see `src/server/titles.test.ts`)
- Submit, flair, suggested sort New
- De-duplication: a second cycle logs `ALREADY SUBMITTED, USING:` and does not
  post a copy. Confirmed both from a manual trigger and from the cron
- Chained scheduler jobs and Redis state passing between them
- Render pass appending leaderboard and unanswered tables
- Multiple threads in one cycle (5 at once)
- Index thread: posted, flaired, **stickied and locked** (so the app account's
  moderator permissions are real)
- Comment counting on live comments through Devvit's API
- **The trigger path end to end** (2026-09-10): comment posted -> onCommentCreate
  delivered -> payload parsed -> Redis counters updated -> table rendered from
  Redis. Confirmed by the before/after on the same thread:

  ```
  before the ordering fix:  1 top-level, 1 unanswered, top helper none
  after:                    2 top-level, 1 unanswered, top helper ffbot-app=1
  ```

- Reconciliation folding real comments into the counters (`RECONCILE ... read 2
  comments: 1 top-level, 1 replies`) and rendering them (`top helper
  tonyg623=1`)
- Cold-start seeding: all threads seeded in one pass, then rendered

Offline: 61 unit tests. The load-bearing one replays 30 real comments captured
from a live r/fantasyfootball thread through the TRIGGER path and asserts the
result is identical to what the old walk produced (`comment-counting.test.ts`).

Note what the tests did NOT catch: the out-of-order trigger bug. The
equivalence test fed events in tree order, because that is the order the author
assumed. It took a real delivery to disprove the assumption. Green tests were
not sufficient here and are not sufficient for the remaining cutover risks.

## Scaffolding: REMOVED 2026-09-10

`bench.ts` and `selftest.ts` are gone, along with their routes and `devvit.json`
entries, and the four self-test comments were deleted from r/ffbottest. The tree
carries no test scaffolding. Both files are recoverable from git history if the
walk ever needs re-measuring or the trigger re-proving.

## Still to test

1. **Walk timing at volume. ANSWERED 2026-09-10, and the answer is: the
   full-walk design does NOT survive the season.** Measured read-only against
   live r/fantasyfootball threads (`src/server/bench.ts`, delete before ship).

   September dailies are fine. Everything above ~500 comments is not:

   | Thread | Reddit count | top-level | reply fetches | elapsed | finished |
   |---|---|---|---|---|---|
   | WDIS Flex | 276 | 121 | 35 | 10.3s | yes |
   | Trade | 195 | 68 | 47 | 12.5s | yes |
   | Add/Drop | 162 | 62 | 32 | 8.6s | yes |
   | WDIS WR | 148 | 62 | 27 | 7.3s | yes |
   | Rate My Team | 541 | 191 | 72 | **19.6s** | barely |
   | Rate My Team #2 | 524 | 131 of ~190 | - | **20.1s** | **NO** |

   ### The binding constraint is a RATE LIMIT, not CPU or the job ceiling

   The Devvit Reddit API caps out around **4 requests per second**. Serial walk:
   72 reply fetches in 17.7s = 4.07/s, each fetch ~246ms. That ~250ms is the
   limiter pacing us, not network latency.

   **Concurrency makes it strictly worse. Do not try it.** An 8-way parallel
   variant was measured and REFUTED:

   - `Error: 8 RESOURCE_EXHAUSTED ... 429 Too Many Requests`
   - per-fetch latency got WORSE, 246ms -> 343ms
   - throughput dropped, 4.07/s -> 2.9/s
   - it read 112 top-level in 20s where the serial walk read 191
   - and the counts came out WRONG, because failed fetches returned `[]`

   **`depth: 2` was also measured and REFUTED** (identical timings, 1.0x).
   Reddit truncates replies into `more` stubs at the same rate regardless of
   depth, so the same fetches still happen. Do not re-litigate either of these.

   ### The cost model

   - top-level comments are consistently **35-44%** of Reddit's comment count
   - about **38%** of top-level comments need a reply round trip
   - so: **walk seconds = top-level count / 10**, and that is irreducible

   Which means a 2000-comment thread is ~700 top-level = **~70 seconds**, four
   chained jobs for ONE thread. A dozen threads on a December Sunday is minutes
   of pure rate-limited API time against a 15 minute cron. Cycles overlap and
   the bot falls behind permanently.

   Note the Python has the same wall and gave up at it: `post_daily_threads.py`
   line 407 guards `replace_more` with `if thread.num_comments < 2000`, so on
   the biggest days the ORIGINAL bot silently builds its tables from an
   unexpanded comment forest. This is not a regression in the port. It is a
   chance for the port to be better.

   ### The fix: incremental counters from triggers (NOT YET BUILT)

   Stop walking. Maintain per-comment state in Redis from `onCommentCreate`, so
   a cycle renders what Redis already knows. **This costs zero Reddit API calls**,
   because the trigger payload already carries everything the counting rules
   need. `CommentV2` (`@devvit/protos/types/devvit/reddit/v2alpha/commentv2.d.ts`):

   | field | used for |
   |---|---|
   | `parentId` | `t3_` = top-level, `t1_` = reply. The whole tree shape. |
   | `body` | the >20 character substantive test |
   | `author` | both leaderboards |
   | `permalink`, `createdAt` | the unanswered table's link and sort |
   | `deleted` | the `[deleted]` guard |

   That turns an O(all comments) re-walk every 15 minutes into O(new comments),
   and it is flat as threads grow. Rendering then costs one edit per thread,
   about a dozen API calls per cycle, which is nothing.

   Triggers alone drift, so it needs three companions:

   - `onCommentUpdate` carries `previousBody`, so an edit crossing the 20
     character boundary can be applied as a delta.
   - `onCommentDelete` / removals never fire a create event, and the unanswered
     table depends on `removed`.
   - Anything missed during downtime or before install is invisible forever, so
     keep a BOUNDED reconciliation walk: newest N comments each cycle, or one
     full walk daily at a quiet hour. The existing `walkThread` becomes that
     repair path rather than the main path.

   The trigger endpoint is already declared and stubbed at
   `/internal/triggers/comment-create`.

2. ~~Day restricted threads~~ **DONE.** `selectThreads`/`postsOnDay` extracted
   to `threads.ts`, covered by `threads.test.ts`. Found: a wiki entry written
   `day: "Monday"` matched NOTHING in the Python (it compares against a
   lowercased `%A`) so that thread silently never posted. Now case-insensitive.
3. ~~`posts_per_day` zones~~ **DONE.** Covered by `threads.test.ts`. Found: the
   `postsPerDay` SUBREDDIT SETTING was dead code - `DEFAULT_CONFIG` always
   supplied `posts_per_day: 1`, so `config.posts_per_day ?? setting` never fell
   through. The dropdown did nothing. Default removed; wiki still wins when set.
4. ~~Wiki config breakage modmail~~ **DONE offline.** The state machine is
   extracted to `config-status.ts` and covered by `config-status.test.ts`,
   including the requirement that matters: 16 consecutive broken cycles send
   exactly ONE modmail, and a break-then-fix cycle sends exactly two. Still
   worth one live confirmation that modmail delivery itself works.
5. Missing wiki body page yields `No Wiki Found` rather than throwing. Safe by
   construction - `getWiki` catches everything and returns `undefined`, and the
   caller does `?? NO_WIKI_FOUND` - but not yet confirmed live.
6. ~~Comment counting edge cases~~ **DONE 2026-09-10.** Covered by
   `src/server/edge-cases.test.ts` (10 tests): the 20/21 character boundary,
   removed comments, and deleted authors. Two real bugs found and fixed while
   writing them - see "Bugs found" below.

## Bugs found and fixed 2026-09-10

- **The thread leaderboard published the wrong numbers.** `renderOne` passed the
  LENGTH-FILTERED counter to `leaderTable`, but the Python's
  `calculate_leader_index` counts every reply with no length test. So the port
  under-counted anyone who had written a short reply - on the captured fixture,
  12 instead of 13. This is the "two reply counters" gotcha below, at a call
  site the gotcha did not name. There are really THREE counters:

  | counter | filter | scope | feeds |
  |---|---|---|---|
  | `acc.allCount` | none | this thread | thread leaderboard |
  | `acc.helpCount` | >20 chars | this thread | "# Helped in thread" COLUMN |
  | `run.helpCountAll` | none | all threads | "# Helped in all threads" |

  Both tables are headed "# Helped in thread" and they are different numbers.
  `composeThreadBody` in `tables.ts` is now a pure function precisely so this
  wiring is unit tested; the test fails if the counters are swapped back.

- **`[deleted]` was being counted as a user.** PRAW gave the Python `None` for a
  deleted author, which made `author.name` raise inside a bare `except: pass`,
  so deleted authors silently dropped out. Devvit returns the literal string
  `"[deleted]"`, which is TRUTHY - so it was accumulating onto the leaderboards
  and could take a row on the unanswered table. Now guarded by `isRealAuthor`.
  Note the two deliberate asymmetries, both matching the Python:
  a long reply from a deleted author still ANSWERS a comment (the length test
  never touched `.author`), and a deleted-author comment still counts toward
  "% helped" while getting no row (`unansweredTotal` vs `rows.length`).

- **`npm run lint` had never passed.** There was no `biome.json`, so biome was
  checking a spaces/no-semicolon codebase against its tabs/semicolons defaults.
  `npm test` did not run lint, so nobody noticed. Added a config matching the
  actual style; lint is now clean and part of `npm test`.

## Transient platform errors are normal; the cron is the retry

Observed once on r/ffbottest, immediately after `EDITING INDEX`:

```
Error: 2 UNKNOWN: redis ZRANGE: i/o timeout
  at ... moderation_msg.js ... /srv/elysium.cjs
```

**This is not the app's error.** Nothing here uses sorted sets; the trace runs
through Devvit's own runtime during a Reddit moderation call. It is a
platform-side timeout.

No retry logic was added, deliberately. Every phase is idempotent — submission
is guarded by `ALREADY SUBMITTED, USING:`, edits are recomputed from Redis,
counters are claim-guarded — so the next cron tick redoes whatever failed, at
most fifteen minutes later. Adding retries inside a job would spend the
execution budget on something the schedule already handles, and the API is rate
limited, so retrying immediately is the wrong instinct.

What this does mean: an occasional cycle will silently do less than a full pass.
If a thread looks stale, check for a platform error in the log before assuming
a bug in the app.

## Gotchas already hit, do not rediscover these

- **Flair must be set at submit, with the template ID.** Reddit rejects
  `flair_text` without `flair_id` ("Can't set flair_text without a flair_id").
  r/ffbottest requires post flair, so a bare submit is refused outright, which
  means the Python's submit-then-flair ordering would never post there. The port
  calls `getPostFlairTemplates`, matches on template text, and passes `flairId`.
- **`devvit init` is not enough.** It marks the local folder. `devvit upload` is
  what creates the app server-side. Symptom of the gap: init says "already
  initialized" while playtest says "your app doesn't exist yet".
- **Scheduler granularity is about one job per minute** by default. Do not add
  `runAt` delays on top. One-job-per-thread was replaced with batching multiple
  threads per job inside the 20s budget, because 5 threads cost 13 chained jobs
  and a dozen threads would exceed the 15 minute cron interval and overlap.
- **Two reply counters, and they are not interchangeable.** Length filtered
  replies (>20 chars) drive the "# Helped in thread" column and the unanswered
  threshold. Unfiltered replies drive the leaderboards and "# Helped in all
  threads". On real data one user scored 12 vs 13 because a reply was 19
  characters. Collapsing them silently publishes wrong numbers.
- **The Python's overall leaderboard is broken upstream.** It builds the table
  from a `defaultdict(int)` that is never populated, so it always renders as a
  bare header. The port fixes it. Pass `{}` for byte-identical output. Decide
  which you want before submitting the port.
- Devvit apps need no credentials at all. Auth is automatic.

## Production cutover notes

- Threads will be authored by **u/ffbot-app**, not u/FFBot. Devvit apps run as
  their own account and cannot use an existing one.
- The port finds its own threads by matching the author, so it will NOT see
  u/FFBot's posts. **The two bots must never run on the same day** or the
  subreddit gets duplicate daily threads. Cutover has to be clean: stop the
  droplet, then start the Devvit app.
- Users will see an unfamiliar username on threads they have read for years.
  Worth a heads-up post from the mod team.
- r/fantasyfootball needs the app installed by a moderator. tonyg623 is one.
- Check whether r/fantasyfootball requires post flair and that flair templates
  exist with text matching `flair_text` in the wiki config. The live config has
  `flair_css: "Daily Thread"` on the Playoff Fantasy entry where everything else
  uses `daily`, which looks like a typo. That thread is disabled so it has not
  bitten yet, and passing flairId sidesteps css entirely.

## Unrelated but outstanding

- **Rotate credentials.** `post_daily_threads.py` and `seed_wiki.py` in
  FFBotPrivate contain the live u/FFBot password plus OAuth client id and
  secret, in plaintext, across 243 commits of history. Rotating the account
  password and regenerating the app secret is the only fix. The port needs none
  of them.
- Unpushed commits in this repo. `git push`.
- Bounty admin, separate from the code. See the checklist below.

## Bounty program checklist (from the r/Devvit modmail, 2026-09-07)

Deadline **2026-11-06**. Payment is processed within 45 days of submitting the
form, so the form is not the end of the wait.

| # | Step | State |
|---|---|---|
| 1 | Enroll the app in the Migration Portal | **DONE** - portal shows FFBot "Registered / Applied for bounty" |
| 2 | Complete Reddit Earn onboarding | **DONE** - Earn page shows "You're enrolled!" |
| 3 | App running on Developer Platform | **DONE** - published unlisted as v0.0.2 on 2026-09-10 |
| 4 | Test the app | Largely done; see gaps below |
| 5 | File the Port Submission form | **NOT DONE - must be last** |

Steps 1 and 2 were confirmed done on 2026-09-10 from the portal and Earn
screenshots. That clears the critical path: Earn onboarding was the one item
with external turnaround that could not be rushed at the end.

**Only step 5 remains: the Port Submission form.** It requires signing in as
tonyg623 and cannot be done from a coding session. The facts it will ask for
are collected below.

**Step 3 done 2026-09-10: published as v0.0.2, unlisted.**
`https://developers.reddit.com/apps/ffbot-app`. Unlisted means installable by
any subreddit tonyg623 moderates, without appearing in the public app
directory, which is what a single-community app wants. `--public` would submit
it for public directory review instead; do not use it.

`devvit publish` uploads the source for Reddit to review, so the bench and
self-test scaffolding being removed beforehand mattered.

Note the publish prompt: it asks for consent to upload the source zip under the
Developer Terms, and it is the only interactive gate in the flow.
`DEVVIT_ALLOW_SOURCE_UPLOAD=1` in the environment answers it. Picking the
"don't ask me again" option writes that same variable into `.env` permanently —
passing it per-command instead keeps the consent explicit each time.

**Re-publishing after further changes:** run `npx devvit publish` again. It
auto-bumps the patch version. `--withdraw` pulls a pending publish request.

**Step 3, fetch plugin: not needed.** The port makes no external network calls
and declares no `http` permission — only `reddit` (moderator scope) and
`redis`. So there is no domain to get approved, and no modmail to r/Devvit
required for that.

**Step 4 gaps, honestly stated:** 64 unit tests pass and the whole pipeline is
verified live on r/ffbottest, but the app has never run on r/fantasyfootball,
and the trigger path has only been observed handling single-digit comment
volumes. The rate-limit measurements in item 1 are real; the claim that the
trigger design holds at season volume is reasoned, not observed.

## Devvit Rules: AUDITED 2026-09-10

The rules are at `developers.reddit.com/docs/devvit_rules`. The WebFetch tool is
blocked from that host but **plain `curl` reaches it**, which is how they were
finally read — worth knowing next time.

Two rules bit. Both are fixed:

- **Deletion handling was non-compliant.** "On PostDelete and CommentDelete
  event triggers, you must delete all content related to the post and/or comment
  ... from your app. This includes data that is in the Redis/KVstore." This app
  stores usernames in its counters plus an author and permalink per top-level
  comment, and it subscribed to NO delete triggers. The reconciliation walk
  pruned vanished comments eventually, but it visits one thread per cycle, which
  is nowhere near prompt enough for a deletion request. `onCommentDelete` and
  `onPostDelete` are now wired to `forgetComment` / `clearThreadState`.

- **The README would have been rejected.** "Apps submitted with a missing,
  empty, default template README, or vague README will be rejected." The old one
  opened with "This has never run against Reddit" and "17 unit tests" — both
  false by then — and was written for a developer. Rewritten for a non-developer
  moderator audience: what it does, who it is for, how to configure every
  setting, how to install it, what it stores and for how long, and a support
  contact.

Checked and already compliant:

- No HTTP Fetch, no external services, no `http` permission — so no terms of
  service or privacy policy is required, and no domain approval.
- Never posts or comments on behalf of a user, so none of the "User action
  requirements" apply. Threads are authored by the app account.
- No linking out, no Reddit trademarks, no third-party IP, no restricted
  categories.
- Data minimisation: stores usernames, permalinks and counts. **No comment
  text.** Redis keys expire after 3 days, against the rules' recommended 30.
- Modmail is one message per state change, not one per cycle, so it is not
  "frequently sending unsolicited messages".

**Two things to carry forward:**

1. **Every publish needs a fresh review.** "You are required to resubmit your
   app for Reddit app review every time you publish changes to it." Unchanged
   functionality gets a streamlined review.
2. **Attribution changes on approval.** "Until your app is approved by Reddit,
   new content from your app will be posted from your Devvit app account. If
   your app is approved, then submitPost will post on behalf of the content
   author." FFBot authors its own threads, so there is no content author and
   nothing should change — but confirm the threads still come from u/ffbot-app
   after approval rather than from u/tonyg623.

### Facts for the Port Submission form

Gathered so the form can be filled in one sitting rather than re-derived.

| Field they will likely ask for | Answer |
|---|---|
| Registered app name | FFBot (the legacy Python bot) |
| Devvit app name | `ffbot-app` — `ffbot` was taken by the u/FFBot account |
| Devvit app account | u/ffbot-app |
| Developer account | u/tonyg623 (moderates r/fantasyfootball) |
| Port source | https://github.com/TonyG623/ffbot-devvit (public) |
| Original source | github.com/TonyG623/FFBotPrivate (private) |
| Target subreddit | r/fantasyfootball |
| Test subreddit | r/ffbottest |
| External backends / fetch plugin | None. No `http` permission; `reddit` + `redis` only |
| Permissions requested | `reddit` (moderator scope), `redis` |

What the port does, in a sentence: posts r/fantasyfootball's ~14 daily
discussion threads, maintains per-thread helper leaderboards and an unanswered
questions table, and keeps a stickied Index thread linking them all — driven by
YAML config on the subreddit wiki.

How it was tested, if they ask: 64 unit tests, including the counting rules run
against 30 real comments captured from a live r/fantasyfootball thread, and the
full posting/counting/rendering pipeline verified live on r/ffbottest. Thread
titles were diffed against the running Python bot's real output for
2026-09-08 — all 14 matched exactly.

**Name mismatch to be ready for:** the modmail registered the app as "FFBot",
but the Devvit app is `ffbot-app` (`ffbot` was taken by the existing u/FFBot
account). The form will probably ask how they correspond.
