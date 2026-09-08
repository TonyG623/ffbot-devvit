# FFBot self-service configuration

This page controls the daily threads FFBot posts. Mods can edit it here on Reddit;
changes take effect within ~10 minutes (the next cron run).

&#8226; **Thread body wiki pages:** [r/ffbottest/wiki/ffbot/threads](https://www.reddit.com/r/ffbottest/wiki/ffbot/threads)

## How to edit

- The config is the 4-space-indented block below. Keep every config line indented.
- Toggle `enabled: true` / `false` at the bottom of each thread block to turn it on/off.
- Add or remove threads by copying an existing block and editing it.
- If you make a typo and the bot can't parse the page, the bot keeps using the
  previous good config and you'll get a modmail. Fix the typo and you'll get
  another modmail confirming.

## Thread fields

- **`title`** &mdash; The post title that appears on Reddit (before the date suffix).
- **`wiki`** &mdash; Name of the wiki subpage under `ffbot/...` whose content becomes the body of the post. See the [threads directory](https://www.reddit.com/r/ffbottest/wiki/ffbot/threads).
- **`flair_text`** &mdash; Flair text applied to the new post.
- **`flair_css`** &mdash; Flair CSS class. Must match a CSS class defined in the sub's flair templates.
- **`day`** *(optional)* &mdash; Only post on this weekday. Lowercase: `monday`, `tuesday`, etc.
- **`sticky`** *(optional)* &mdash; `true` stickies the post when it's first created.
- **`no_table`** *(optional)* &mdash; `true` skips the "unanswered comments" table at the bottom.
- **`enabled`** &mdash; Master toggle. `true` to post this thread, `false` to skip it.

&nbsp;

    threads:

      # ==========================================================
      #   ALWAYS-ON THREADS
      # ==========================================================

      - title:      "League, Commissioner, and Platform Issues"
        wiki:       "commish"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    true

      - title:      "Keeper"
        wiki:       "keeper"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "Playoff Fantasy"
        wiki:       "dynasty"
        flair_text: "Daily Thread"
        flair_css:  "Daily Thread"
        enabled:    false


      # ==========================================================
      #   WDIS - Who Do I Start (turn on for football season)
      # ==========================================================

      - title:      "WDIS QB"
        wiki:       "wdis"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "WDIS WR"
        wiki:       "wdis"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "WDIS RB"
        wiki:       "wdis"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "WDIS Flex"
        wiki:       "wdis"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "WDIS K/TE/DEF"
        wiki:       "wdis"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false


      # ==========================================================
      #   TRADES, WAIVERS, DRAFTS
      # ==========================================================

      - title:      "Trade"
        wiki:       "trade"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "Add/Drop"
        wiki:       "ww"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "Who Do I Draft?"
        wiki:       "wdid"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "Rate My Team"
        wiki:       "rmt"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "Fix My Team"
        wiki:       "fixmyteam"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false

      - title:      "Mock Draft"
        wiki:       "mockdraft"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false


      # ==========================================================
      #   WEEKLY STICKIES (only post on their named day)
      # ==========================================================

      - title:      "Monday Miracle"
        wiki:       "monday"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        day:        "monday"
        sticky:     true
        enabled:    false

      - title:      "Tuesday Waiver Wire"
        wiki:       "tuesday"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        day:        "tuesday"
        sticky:     true
        enabled:    false

      - title:      "Wednesday Weekly Trade Value"
        wiki:       "wednesday"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        day:        "wednesday"
        sticky:     true
        enabled:    false

      - title:      "Thursday Throwdown"
        wiki:       "thursday"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        day:        "thursday"
        sticky:     true
        enabled:    false

      - title:      "Free Talk Friday"
        wiki:       "friday"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        day:        "friday"
        sticky:     true
        no_table:   true
        enabled:    false

      - title:      "Last Minute Advice"
        wiki:       "saturday"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        day:        "saturday"
        sticky:     true
        enabled:    false


      # ==========================================================
      #   OTHER
      # ==========================================================

      - title:      "Dynasty, Best Ball, and Guillotine Strategy"
        wiki:       "dynasty"
        flair_text: "Daily Thread"
        flair_css:  "daily"
        enabled:    false


    # ==========================================================
    #   GLOBAL SETTINGS
    # ==========================================================

    # Post a sticky "Index" thread linking to every daily thread above.
    # true/false
    index:           false

    # How many times per day each enabled thread gets posted.
    # Allowed values:
    #   1 = once a day, no time-of-day label
    #   2 = twice a day, labeled "Morning" / "Evening"
    #   3 = three times a day, labeled "Morning" / "Afternoon" / "Evening"
    posts_per_day:   1

    # Show a "% of users have been helped in this thread" line at the bottom
    # of the unanswered-comments table.
    # true/false
    show_percents:   false

    # For WDIS threads only: replaces the literal text <REPLACE> in the wiki body
    # with the position name pulled from the title (QB, WR, RB, etc).
    # Keep true during football season so one wiki body works for all positions.
    # true/false
    wdis_replace:    true
