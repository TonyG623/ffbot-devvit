# Playtest checklist — r/ffbottest

Everything here needs your Reddit login, which is why it's a checklist and not
something already done. Should take about five minutes, most of it wiki pasting.

## 1. Install and verify locally (no login needed)

```bash
cd C:\Users\tgrol\repos\ffbot-devvit
npm install
npm test          # types + 17 unit tests + bundle
```

Node 24.18.0+ required (`.nvmrc` pins it).

## 2. Wiki on r/ffbottest — ALREADY DONE

Checked 2026-09-08. Nothing to paste:

- `r/ffbottest/wiki/ffbot` — the config page already exists (revision by FFBot,
  ~3 months ago, so `seed_wiki.py` was run against this sub at some point).
  Verified it parses: 21 threads, exactly 1 enabled.
- `r/ffbottest/wiki/ffbot/commish` — created 2026-09-08, the body page for the
  one enabled thread.

`index: false` in the live config, so the Index thread is off for the first run.
Turn it on later and create `ffbot/index` before you do.

The pre-generated copies in `wiki-seed/` are kept for reference and for seeding
a different subreddit.

## 3. Check the flair CSS class exists

The seeded config uses `flair_css: "daily"`. If r/ffbottest has no flair template
with that CSS class, `setPostFlair` will fail. Either create one or blank the
`flair_css` values before the first run.

## 4. Playtest

```bash
npx devvit login          # browser OAuth, your developer account
npx devvit playtest r/ffbottest
```

Then trigger a run immediately from the subreddit menu: **[FFBot] Run cycle now**.
Otherwise the cron fires at the next 15-minute boundary.

## What a first successful run looks like

1. One post appears: `Official: [League, Commissioner, and Platform Issues] - <Day> <date>`
2. Body is whatever you put on the `ffbot/commish` wiki page
3. Logs show `SUBMITTING THREAD ...`, then a `walk` job, then a `render` job
4. On the render pass the post body gains the leaderboard and unanswered tables
   (both will be near-empty on a fresh thread — that's correct)

## What to watch for

- **Timing.** Note how long the `walk` job takes with a handful of comments,
  then extrapolate. It has a 20-second budget against a 30-second hard limit.
  If a near-empty thread is already slow, the design needs the trigger-based
  rewrite described in README.md before it goes near r/fantasyfootball.
- **`partial: true` in the logs** means the walk hit its budget and re-scheduled.
  Fine occasionally, a red flag if it happens on small threads.
- **Modmail.** Break the wiki YAML on purpose once (add a stray `:`) and confirm
  you get the "config broken - using cached version" modmail, then fix it and
  confirm the "restored" one. That path is ported but unproven.
- **Date rollover.** The bot uses the previous day's date before 06:00 local.
  If you test late at night, that's expected, not a bug.
