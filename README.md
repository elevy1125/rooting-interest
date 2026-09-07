# Rooting Interest

See every player starting in your [Sleeper](https://sleeper.com) matchups this week — across all of your
leagues at once — split into who's starting **for** you and who's starting **against** you.

**Live:** https://elevy1125.github.io/rooting-interest/

Type in a Sleeper username. The app finds every NFL league that account is in for the season, pulls the
current week's matchup in each one, and tallies each starter:

- **For me** — the player is in your starting lineup in *n* leagues
- **Against me** — the player is in an opponent's starting lineup in *n* leagues
- **Both sides** — a yellow tag on players who show up in both tables, because you're rooting for and
  against them at the same time

Click any row to expand the details: which league, which team is starting them, and the manager. On the
"For me" side it also shows who that team is facing.

Leagues that didn't contribute a matchup this week aren't counted in the league total — an asterisk on
that number lists them on hover or click.

## Features

- Side-by-side **For me / Against me** tables
- **Grouped by position** (QB → RB → WR → TE → K → DEF, then everything else) — toggleable
- Every column sortable, independently per table; counts are **starts** (one per league a player starts in)
- Filter by position, search across players/NFL teams/league names
- "Both sides only" view
- CSV export of whatever is currently on screen
- Auto-detects the current NFL season and week; both are editable
- Handles co-owned rosters, empty starter slots, and leagues with no matchup posted yet

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

Everything runs in the browser against Sleeper's public read-only API — there's no backend, no API key,
and no account data leaves your machine.

| Step | Endpoint |
| --- | --- |
| Current season & week | `GET /v1/state/nfl` |
| Username → user id | `GET /v1/user/<username>` |
| That user's leagues | `GET /v1/user/<user_id>/leagues/nfl/<season>` |
| Rosters, managers, matchups | `GET /v1/league/<league_id>/{rosters,users,matchups/<week>}` |
| Player id → name/position/team | `GET /v1/players/nfl` |

Your roster in each league is matched by `owner_id` (falling back to `co_owners`). Your opponent is the
other roster sharing your `matchup_id`. Requests run five leagues at a time to stay well under Sleeper's
1000-calls-per-minute guidance.

The player database is ~5 MB, so it's trimmed to name/position/team/injury and cached in `localStorage`
for 24 hours. "Refresh players" clears it. If storage is unavailable the app just re-fetches per session.

## Structure

```
index.html        markup
css/styles.css    styling
js/app.js         API calls, aggregation, rendering
```

## Notes

Not affiliated with Sleeper. Uses their public API per the
[documentation](https://docs.sleeper.com/).
