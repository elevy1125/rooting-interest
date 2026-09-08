# Rooting Interest

See every player starting in your fantasy football matchups this week — across all of your leagues
at once, on both [Sleeper](https://sleeper.com) and ESPN — split into who's starting **for** you and
who's starting **against** you.

**Live:** https://elevy1125.github.io/rooting-interest/

Type in a Sleeper username and/or add ESPN leagues by ID. The app finds every league you're in for
the season, pulls the current week's matchup in each one, and tallies each starter across all of
them together:

- **For me** — the player is in your starting lineup in *n* leagues
- **Against me** — the player is in an opponent's starting lineup in *n* leagues
- **Both sides** — a yellow tag on players who show up in both tables, because you're rooting for and
  against them at the same time

Click any row to expand the details: which league, which team is starting them, and the manager. On the
"For me" side it also shows who that team is facing.

Leagues that didn't post a matchup this week are ignored entirely. They don't appear in the
league filter and nothing is counted from them.

## Live scoring

Each table has a **Pts** column showing what the player has actually scored this week. Sleeper's
matchup payload carries `players_points` — points already computed under that league's own scoring
rules — so no scoring math happens here and no extra requests are made.

Leagues with different scoring settings can give the same player different point totals. The
**Scoring priority** panel lets you drag your leagues into an order; the Pts column uses the
highest-priority league that player appears in. Inside the expanded details every league's own points
are listed, with the priority league highlighted. The order is saved in `localStorage`.

### Projections

Before a player's game kicks off there are no real points yet, so the Pts column shows a projection
instead, tagged `proj` and dimmed. The column has three states:

| State | Shown | Source |
| --- | --- | --- |
| Game hasn't started | projection, tagged `proj` | league-scored projection |
| Game in progress | points so far, tagged `live` | live points |
| Game final | final points, untagged | final points |

A player whose team is on bye is tagged `bye`.

### Status column

The **Status** column shows where that player's NFL game is:

| State | Shown |
| --- | --- |
| Yet to play | day and kickoff time in your own zone, e.g. `SUN 8:20 PM` |
| Playing | live score and quarter, e.g. `17-14 Q3` (`OT` past the fourth) |
| Finished | final score with an `F`, e.g. `24-20` |
| Bye | `BYE` |

The player's own team is always the left-hand number. All of it comes from the same ESPN scoreboard
call the app already makes for game states, so live scores cost no extra requests and update with
**Refresh scores**.

Sorting the column goes by game progress first: playing, then yet to play, then finished. Within
each of those, games still ahead of you run forward in time (soonest kickoff first) while finished
ones run backward, so the game that just ended sits on top. Players in the same game always stay
together. Byes sort to the bottom in both directions, since they have no game to order by. The
**Game status** dropdown filters to any combination of these states.

Note that grouping by position takes precedence over any column sort, so leave it off if you want
live games at the very top of the table.

For Sleeper leagues, projections come from `api.sleeper.com/projections/nfl/<season>/<week>` as **raw
stats**, not points, so they're multiplied through each league's own `scoring_settings` — the same dot
product Sleeper does server-side. That keeps projections and actuals in the same units, so a league
with 6-point passing TDs projects differently from one with 4. ESPN returns projections already scored
under league rules, so those are used as-is.

Because the two platforms use different forecasters (Sleeper's come from Rotowire, ESPN's are their
own), a player you hold on both will project differently depending on which league sits highest in
your scoring priority.

Game states come from ESPN's public scoreboard (`site.api.espn.com`), since Sleeper has no
game-status endpoint. The same response carries kickoff time, quarter and score, which is what the
Status column renders. If either request fails the app falls back to actual points only, and the
Status column goes blank rather than guessing.

**Refresh scores** re-pulls matchups, game states and projections while leaving the player database,
league list and rosters cached, and the page auto-refreshes every two minutes while the tab is
visible (paused when it isn't). The last update time sits beside the button.

Commissioner adjustments (`custom_points`) apply to team totals, not per-player values, so they
aren't reflected here. Stat corrections can restate points days later.

## Features

- Side-by-side **For me / Against me** tables
- **Group by position** (QB → RB → WR → TE → K → DEF, then everything else), toggled from inside
  the Positions dropdown
- Every column sortable, independently per table; counts are **starts** (one per league a player starts in)
- **Positions**, **Leagues** and **Game status** dropdowns, each a multi-select with select all /
  select none; the button shows what's currently filtered for
- "Both sides only" view, with the count of those players on the button
- Search across players/NFL teams/league names
- Auto-detects the current NFL season and week; both are editable
- Sleeper and ESPN leagues merge into one view, each league tagged by platform
- Handles co-owned rosters and empty starter slots

## Running it

It's a static site with no build step and no dependencies.

```bash
# just open it
open index.html

# or serve it (avoids browser CORS restrictions on file:// URLs)
python3 -m http.server 8000
# then visit http://localhost:8000
```

## How it works

Everything runs in the browser against read-only endpoints — there's no backend, no API key, and no
account data leaves your machine.

**Sleeper** (`api.sleeper.app/v1`)

| Step | Endpoint |
| --- | --- |
| Current season & week | `GET /state/nfl` |
| Username → user id | `GET /user/<username>` |
| That user's leagues | `GET /user/<user_id>/leagues/nfl/<season>` |
| Rosters, managers, matchups | `GET /league/<league_id>/{rosters,users,matchups/<week>}` |
| Player id → name/position/team | `GET /players/nfl` |

Your roster is matched by `owner_id`, falling back to `co_owners`. Your opponent is the other roster
sharing your `matchup_id`. Requests run five leagues at a time to stay well under Sleeper's
1000-calls-per-minute guidance.

**ESPN** (`lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<season>/segments/0/leagues/<id>`)

| Step | View |
| --- | --- |
| League name, teams, managers | `?view=mTeam&view=mSettings` |
| Matchups, lineups, points, projections | `?view=mBoxscore&scoringPeriodId=<week>` |

Your matchup is the one for the week containing your team id. Starters are entries whose
`lineupSlotId` isn't bench (20) or IR (21). Points come from `appliedStatTotal`, projections from the
`statSourceId: 1` stat row — both already scored under league rules.

ESPN players are matched to Sleeper's via the `espn_id` field in the player database, so the same
player from both platforms lands on one row. Team defenses go through the team code instead, since
ESPN uses negative ids and a different name ("Chiefs D/ST" vs "Kansas City Chiefs"). Anything that
can't be matched still shows, using ESPN's own name.

ESPN's `/nfl/teams` endpoint isn't CORS-accessible from a third-party origin, so the numeric
`proTeamId` → abbreviation map is baked in and topped up each week from the scoreboard.

The player database is ~5 MB, so it's trimmed to name/position/team/injury and cached in `localStorage`
for 24 hours. "Refresh players" clears it. If storage is unavailable the app just re-fetches per session.

## Structure

```
index.html            markup
css/styles.css        styling
js/app.js             API calls, aggregation, rendering
favicon.svg           football icon (favicon.png / apple-touch-icon.png are rasterized from it)
```

## ESPN limitations

- **Public leagues only.** Private leagues return 401 and can't be read from a browser at all: the
  `Cookie` header is forbidden to scripts and ESPN's session cookies are `SameSite=Lax`. The app says
  so plainly rather than failing vaguely.
- **No account lookup.** ESPN has no username → leagues path, so each league is added by numeric ID
  and you pick your team from a dropdown once. Both are remembered.
- **Unofficial API.** ESPN publishes no documentation, terms, or versioning for these endpoints, and
  has changed them without notice before (the base host moved in April 2024). This is the part most
  likely to break on its own.
- Multi-week playoff matchups, where `matchupPeriodId` and `scoringPeriodId` diverge, aren't handled
  specially yet.

## To do

- **Fullscreen mode** — a distraction-free view of the two tables for leaving up on a second screen
  during games.
- **Game datetimes** — show each player's kickoff time, so it's clear what's already played, what's
  on now, and what's still to come.
- **Game statuses** — a per-player state of *yet to play*, *playing*, or *game finished*, surfaced on
  the row rather than inferred from the `proj` / `live` / untagged Pts tag.

## Notes

Not affiliated with Sleeper or ESPN. Sleeper's API is used per its
[documentation](https://docs.sleeper.com/); ESPN's fantasy endpoints are undocumented and public.
