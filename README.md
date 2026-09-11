# FFBot

FFBot runs a subreddit's daily discussion threads. It posts them on a schedule,
keeps them organised, and — the part people actually notice — nudges the
community to answer questions that nobody has replied to yet.

It has run r/fantasyfootball's daily threads for years. This is that bot,
rebuilt to run on Reddit's Developer Platform.

## What it does

Every day, FFBot posts a set of discussion threads defined by the moderators —
on r/fantasyfootball that's around fourteen of them, things like
"Official: [Trade]" and "Official: [Who Do I Start?]". Each thread has a title,
a flair, and an opening post written by the mods.

Then, every fifteen minutes, it updates each thread with two tables:

- **Who has helped the most people in this thread.** A leaderboard of the users
  writing the most replies.
- **Questions nobody has answered yet.** Every top-level comment with fewer than
  two substantial replies, linked directly, sorted so that people who have
  helped others appear at the top.

That second table is the point of the bot. A daily thread with hundreds of
comments buries the people who asked late or asked quietly. The table pulls them
back out, and sorting it by who has helped others rewards people for answering
rather than only asking.

It also posts a stickied **Index** thread linking every thread for the day, so
the community has one place to start.

A reply only counts as "answering" a question if it is longer than 20
characters. Short replies still count toward the leaderboard, but they do not
clear a question off the unanswered list — otherwise a one-word reply would hide
someone who still needs help.

## Who it is for

Moderators of large discussion subreddits that run recurring daily threads and
want them posted, organised, and kept useful without anyone doing it by hand.

## Configuring it

**Everything is configured on your subreddit's wiki. There is nothing to
redeploy and no code to edit.** Changes take effect on the next cycle, within
fifteen minutes.

### 1. The main config page

Create a wiki page at `r/<yoursubreddit>/wiki/ffbot` containing YAML. It can be
inside a fenced code block or indented by four spaces, so the page stays
readable to humans.

```yaml
subreddit: yoursubreddit
posts_per_day: 1
index: true
news_and_discussion: false
show_percents: false
wdis_replace: true

threads:
  - title:      "Trade"
    flair_text: "Daily Thread"
    flair_css:  "daily"
    wiki:       "trade"
    sticky:     true

  - title:      "Monday Miracle"
    wiki:       "monday"
    flair_text: "Daily Thread"
    flair_css:  "daily"
    day:        "monday"
```

Global settings:

| Setting | What it does |
| --- | --- |
| `subreddit` | The subreddit to post in |
| `posts_per_day` | `1`, `2` or `3`. Above 1, titles gain a Morning/Afternoon/Evening label so each day's threads stay distinct |
| `index` | Post the stickied Index thread linking all of the day's threads |
| `news_and_discussion` | Also post a "News and Discussions" round-up of recent flaired posts |
| `show_percents` | Show "N% of users have been helped in this thread" under the table |
| `wdis_replace` | In any thread whose body page is `wdis`, replace `<REPLACE>` with the position from the title, so one page serves every "Who Do I Start?" thread |

Per-thread settings:

| Setting | What it does |
| --- | --- |
| `title` | Goes into the title as `Official: [title] - Day Date` |
| `flair_text` | Post flair. Must match an existing flair template on your subreddit |
| `flair_css` | Flair CSS class, used only if no flair template matches |
| `wiki` | Which body page to use, at `r/<sub>/wiki/ffbot/<name>` |
| `day` | Optional. Only post on this weekday, e.g. `monday` |
| `sticky` | Optional. Pin to the second sticky slot |
| `no_table` | Optional. Skip the tables for this thread |
| `enabled` | Optional. Set `false` to keep the entry but stop posting it |

### 2. A body page per thread

For each thread, create `r/<yoursubreddit>/wiki/ffbot/<wiki>` holding the
opening post. If the page is missing the thread still posts, with the body
`No Wiki Found`, so a typo is visible rather than silently breaking the day.

If `index` is on, also create `r/<yoursubreddit>/wiki/ffbot/index` for the text
at the top of the Index thread.

### 3. Flair

If your subreddit requires post flair, make sure a flair template exists whose
text matches each `flair_text`. FFBot applies flair as it submits, because a
subreddit that requires flair will otherwise reject the post outright.

### If the config breaks

If the wiki page stops parsing — a stray character in the YAML, usually — FFBot
keeps posting from the last configuration that worked and sends the mod team one
modmail explaining what broke. It sends **one** message per change of state, not
one every fifteen minutes. When the page is fixed, it sends a single "restored"
message.

## Installing it

1. Install the app on your subreddit. You must be a moderator.
2. Create the wiki pages described above.
3. Wait for the next cycle, or use the moderator menu item
   **[FFBot] Run cycle now** from the subreddit's three-dot menu to start one
   immediately.

Threads are posted by the app's own account, not by a moderator account.

Optional settings are available in the app's configuration screen for the
timezone used to date threads, the hour the date rolls over, and a fallback
posts-per-day used only when the wiki does not specify one.

## Interacting with it

There is nothing for ordinary users to do — they comment on the threads as
normal and the tables update around them.

For moderators:

- **[FFBot] Run cycle now** — post or refresh today's threads immediately
  instead of waiting for the next fifteen-minute cycle.
- **Edit the wiki config** — change which threads post, their titles, flair, and
  bodies. Live within fifteen minutes.

## What it stores, and for how long

FFBot keeps running counts so it does not have to re-read an entire thread every
fifteen minutes, which on a busy day is not possible within the platform's
limits. For each thread it stores the commenters' usernames, a link to each
top-level comment, and reply counts. It does not store comment text.

Everything expires automatically after three days.

If a comment is deleted, FFBot removes what it stored about that comment
immediately, including the author's username. If a post is deleted, it removes
everything stored about that post. Deleted accounts stop being named on the
tables once the thread is next reconciled.

## Support

Problems, questions, or anything the bot gets wrong: message the moderators of
the subreddit it is running on, or open an issue at
https://github.com/TonyG623/ffbot-devvit/issues

## For developers

```bash
npm install
npm test        # lint + types + unit tests + bundle
npx devvit playtest r/yourtestsub
```

The counting rules are in `src/server/comment-counting.ts` and are the part
worth understanding. Counts are maintained incrementally from comment triggers
rather than by walking threads, because the Reddit API is rate limited to around
four requests per second and a full walk of a 500-comment thread does not fit in
a job's execution budget. A bounded reconciliation walk repairs drift.

`HANDOFF.md` documents the measurements behind that decision, the counting rules
in detail, and the gotchas worth knowing before changing anything.
