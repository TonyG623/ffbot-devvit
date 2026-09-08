# FFBot — Devvit port

A TypeScript port of FFBot (`FFBotPrivate`) onto Reddit's Developer Platform,
for the App Migration Program.

## Status — read this first

**The Devvit app has never run against Reddit.** It was written from the source
Python and the official Devvit 0.14.2 docs, and has never been uploaded,
installed, or playtested — that needs the `devvit` CLI, which requires network
access to reddit.com that the authoring environment did not have.

What HAS been checked against live Reddit: the wiki config parses, the generated
titles match the production bot's exactly, and the counting rules were run over a
real thread's comments. Those are real checks on real data — but every call that
writes to Reddit through Devvit is still unproven.

What *is* verified:

| Check | Result |
| --- | --- |
| `tsc --build` against real `@devvit/web` types | passes |
| 26 unit tests over the pure logic | pass |
| `esbuild` bundle to CJS | succeeds |
| Config parse of the real live wiki page on r/ffbottest | 21 threads, 1 enabled, globals correct |
| Titles vs the LIVE Python bot's output, 2026-09-08 | all 14 reproduced exactly |
| Counting rules vs a real r/fantasyfootball thread | 30 comments, both counters verified |

See `RUN.md` for the playtest checklist and pre-generated wiki page content.

What is **not** verified: every call that touches Reddit. Whether the app has the
permissions it needs, whether a comment walk fits in the execution budget on a
real thread, whether flair CSS classes apply, whether the sticky slots behave.
That is what playtest is for.

## Run it

Needs Node 24.18.0+ (`.nvmrc` pins it; this port was type-checked on Node 22, so
run `npm test` again on 24 before trusting it).

```bash
npm install
npm run test        # types + unit tests + bundle
npx devvit login
npx devvit playtest r/ffbottest
```

`playtest` installs the app on the subreddit and streams logs. The cron runs
every 15 minutes; use the moderator menu item **[FFBot] Run cycle now** to
trigger a cycle immediately instead of waiting.

The r/ffbottest wiki is already set up — `ffbot` (the config) and
`ffbot/commish` (the body for the one enabled thread) both exist. See `RUN.md`.

## The one design decision that matters

**Devvit jobs get 30 seconds.** The Python ran as a single long process on a
droplet: load config, post threads, walk every comment of every thread, edit
everything, `time.sleep(10)` between edits. That shape cannot survive a 30-second
ceiling on r/fantasyfootball-sized threads.

So the run is split into phases that each re-enter through the scheduler, with
state in Redis instead of memory:

```
cycle (cron */15)  ensure today's threads exist        -> chain
  walk   (1 job per thread)  read comments into a Redis accumulator
  render (1 job per thread)  edit the thread body from the accumulator
  index  (1 job)             build + post/edit the stickied Index thread
```

`walk` carries a 20-second budget. If a thread's comments don't fit, it saves
progress and re-schedules itself with a skip offset.

**This is the part most likely to be wrong.** Resuming re-reads the skipped pages,
so a thread that needs many passes burns API calls quadratically. Measure it on a
real thread first. If daily threads routinely need more than one or two passes,
the answer is not a bigger budget — it's to stop re-walking entirely and maintain
the counters incrementally from an `onCommentCreate` trigger, so the cron job only
renders what Redis already knows. The trigger endpoint is declared and stubbed at
`/internal/triggers/comment-create` for exactly that.

## Deliberate differences from the Python

1. **No credentials.** Devvit authenticates apps automatically — there is no
   `client_id`, `client_secret`, or bot password anywhere in this port. The
   hardcoded credentials in `post_daily_threads.py` have no equivalent here.
   (Rotate them anyway — they're in the old repo's git history.)

2. **The overall leaderboard bug is fixed.** In the Python,
   `calculate_overall_leader_index` builds its table from a `defaultdict(int)`
   that is created empty and never populated, so it always renders as a bare
   header with no rows. `overallLeaderTable()` here takes the real cross-thread
   counts. **If you want byte-identical output, pass `{}`.** Decide which you
   want before submitting the port.

3. **Both reply counters are preserved.** The Python keeps two counts that are
   easy to mistake for one: length-filtered replies (`len(body) > 20`) drive the
   "# Helped in thread" column, and unfiltered replies drive the leaderboards
   and "# Helped in all threads". Collapsing them would change published
   numbers, so `comments.ts` tracks both. This is not theoretical — on the real
   thread captured in `fixtures/`, `headfullofmangos` scores 12 substantive vs
   13 total because one reply was 19 characters. See `counting.test.ts`.

4. **Flair is set at submit time**, via `submitPost({flairText})`, not only
   afterwards with `setPostFlair`. Subreddits can require post flair — r/ffbottest
   does — and a bare submit is rejected outright there, so the Python's
   submit-then-flair ordering would never post at all. `setPostFlair` still runs
   afterwards to attach the stylesheet CSS class, which `submitPost` can't set.

5. **Timezone, posts-per-day and rollover hour are subreddit settings**, not
   `pytz.timezone('US/Central')` hardcoded in the module body.

6. **State moved** from `/opt/ffbot/state/*.json` to Redis. The wiki-config
   fallback and the "config broken / config restored" modmail alerts behave the
   same, including only alerting once per state change.

## Known gaps

- `common.pyc` and the `fantasybball.yaml` / `fantasyhockey.yaml` configs were
  not ported; this targets one subreddit per installation, which is how Devvit
  apps are scoped. Multi-sport means installing the app per subreddit with
  different wiki configs.
- The Python's `replace_more(limit=None)` has no direct equivalent. Devvit's
  `Listing` paginates on its own; whether it reaches every comment on a large
  thread is unverified.
- The live wiki config has `flair_css: "Daily Thread"` on the Playoff Fantasy
  entry where every other entry uses `daily` — looks like a typo in the original,
  carried over as-is. That thread is disabled, so it has not bitten yet.
- r/ffbottest now has `Daily Thread`/`daily` and `Index`/`index` link flair
  templates, created 2026-09-08 to match the config.
- No retry/backoff around Reddit calls. The Python had none either, but a
  droplet retried on the next cron tick; here a thrown job just fails.

## Layout

```
devvit.json           app config: permissions, scheduler tasks, settings, menu
src/shared/types.ts   config + accumulator types
src/server/
  index.ts            server entry
  server.ts           routes /internal/* endpoints to jobs
  jobs.ts             cycle / walk / render / index phases
  comments.ts         comment walking, the two reply counters
  tables.ts           markdown table builders (pure)
  dates.ts            thread date, zone, days-since-monday (pure)
  config.ts           wiki config load, cache fallback, modmail alerts
  state.ts            Redis accessors
  yaml-extract.ts     port of _extract_yaml (pure)
  ffbot.test.ts       unit tests for dates, tables, YAML extraction
  titles.test.ts      port titles vs the live Python bot's real output
  counting.test.ts    counting rules vs a real r/fantasyfootball thread
  fixtures/           captured real thread data backing counting.test.ts
```

The pure modules (`tables`, `dates`, `yaml-extract`) hold the logic that was
worth testing without a Reddit connection — the string formats and sort orders
where a silent difference would quietly change what gets published.
