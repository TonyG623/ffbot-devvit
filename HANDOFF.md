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

Devvit jobs have a **30 second execution limit**. The Python ran as one long
process: load config, post threads, walk every comment of every thread, edit
everything, `time.sleep(10)` between edits. That cannot survive the ceiling.

So a cycle is split into phases that re-enter through Devvit's scheduler, with
state in Redis instead of memory:

```
cycle (cron */15)   ensure today's threads exist  -> chain
  walk    read comments into a Redis accumulator
  render  edit each thread body from the accumulator
  index   build and post the stickied Index thread
```

Config lives on the subreddit wiki at `r/<sub>/wiki/ffbot` (YAML in a 4-space
indented block), with per-thread body pages at `r/<sub>/wiki/ffbot/<name>`.
Config is re-read every cycle, so wiki edits take effect with no redeploy.

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

Offline: 26 unit tests, including the counting rules run against 30 real
comments captured from a live r/fantasyfootball thread (`counting.test.ts`).

## Still to test

1. **Walk timing at volume.** THE open question. r/ffbottest threads are nearly
   empty, so the walk finishes instantly and proves nothing. r/fantasyfootball
   daily threads run 100-150 comments across a dozen threads. If a walk cannot
   finish inside its 20 second budget, it chains with a skip offset and re-reads
   the skipped pages, which is quadratic. If that happens routinely, the fix is
   NOT a bigger budget: maintain counters incrementally from an
   `onCommentCreate` trigger so the cron only renders what Redis already knows.
   The trigger endpoint is declared and stubbed at
   `/internal/triggers/comment-create` for exactly this.
2. Day restricted threads (`day: monday` etc) post only on their named weekday.
3. `posts_per_day: 2` or `3` produces Morning/Afternoon/Evening in titles.
4. Wiki config breakage: put a stray `:` in the YAML, confirm modmail
   "FFBot wiki config broken - using cached version", confirm it keeps posting
   from cache, fix it, confirm the "restored" modmail. Exactly one modmail per
   state change, not one per run. Ported but never exercised.
5. Missing wiki body page yields `No Wiki Found` rather than throwing.
6. Comment counting edge cases: replies of exactly 20 and 21 characters,
   removed comments, deleted authors.

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
