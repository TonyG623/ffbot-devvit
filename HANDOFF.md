# FFBot Devvit port: handoff

Paste this into a coding session with terminal access, run from
`C:\Users\tgrol\repos\ffbot-devvit`.

---

## What this is

FFBot is a Reddit bot that has run r/fantasyfootball's daily threads for years:
Python + PRAW on a DigitalOcean droplet, driven by cron. Reddit offered a $1,000
bounty to port it onto Devvit (their Developer Platform, where Reddit hosts the
app). The modmail arrived 2026-09-08 and gives 60 days, so the deadline is
roughly 2026-11-07.

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

## Trigger payload: VERIFIED 2026-09-10

`@devvit/web` exports no type for a trigger POST body, so `trigger-payload.ts`
was written against the protobufs and the wire shape was inferred. It has now
been confirmed against a real delivered event on r/ffbottest. Every field the
counting rules need parses correctly.

Two things that came out of that verification, both load-bearing:

- **`comment.author` is a USER ID, not a username.** The live payload carried
  `"author":"t2_2mjbzpp4by"`. The correct name is on the SIBLING `author`
  object as `.name`. The parser already preferred that object, so this was
  never a bug — but do not "simplify" it to read `comment.author`, or raw `t2_`
  ids go on the leaderboards.

- **TRIGGERS ARE NOT ORDERED.** Observed twice: a comment and a reply were
  posted a second apart, and Devvit delivered the REPLY's event first, both
  times. Anything that assumes a parent is already known when its reply arrives
  is wrong. See `drainPending` in `comment-counting.ts`; a `RESCUED n
  out-of-order replies` log line is that reordering caught in the act.

`triggers.ts` still logs the first payload of each process
(`TRIGGER first payload sample:` / `TRIGGER parsed as:`), which is the fastest
way to re-check this if counts ever look wrong.

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
- Bounty admin, separate from the code: enroll the app in the migration portal,
  complete Reddit Earn onboarding (payment gate, has external turnaround, start
  early), then file the Port Submission form.
