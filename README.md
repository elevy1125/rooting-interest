# Rooting Interest

Every player starting in your fantasy football matchups this week, across all your leagues at once,
on both [Sleeper](https://sleeper.com) and ESPN, split into who's starting **for** you and who's
starting **against** you.

**Live:** https://elevy1125.github.io/rooting-interest/

## Using it

Enter a Sleeper username, set the week, and hit **Load matchups**. The season is always the current
one, and the week defaults to it.

ESPN has no username lookup, so add those leagues by the numeric ID in the league URL
(`…leagueId=1234567890`) and pick your team once. Both are remembered. Public leagues only.

You can run ESPN-only by leaving the username blank.

## The tables

- **For me**: the player is in your starting lineup in *n* leagues.
- **Against me**: the player is in an opponent's starting lineup in *n* leagues.
- **Both sides**: a yellow tag on players in both tables, because you're rooting for and against them
  at once.

**Starts** counts one per league. Click a row for the per-league breakdown: league, team, manager,
and that league's points. The "For me" side also shows who the team is facing.

Leagues with no matchup this week are ignored entirely and don't appear in the **Leagues** list.

## Modes

Three modes, one key each, held for half a second rather than tapped so a stray letter can't flip the
page out from under you. Nothing fires while you're typing in the search box or the username field.
Hold the same key again to leave, or hold **X** to reset the view from wherever you are. The keys are
listed in the footer, which is the only place they live, so the footer stays on screen in every mode.

| Key | Mode | Instead of the two tables you get |
| --- | --- | --- |
| R | Roster view | one full-width list of everyone you roster, bench included |
| G | Group by games | one card per NFL game, with your stake in it underneath |
| T | TV mode | the same screen, larger, with the setup bar and filters out of the way |
| X | Reset view | the two tables back |

Roster view and Group by games are two layouts of the same week, so turning one on turns the other
off, and the layout arriving fades up rather than snapping in, since it's a different shape of page
each time. TV mode sits over whichever of them is up, so `G` then `T` gives you game cards at
across-the-room size, and pressing `T` again leaves the cards where they were. Each key only ever touches its
own mode; `X` is the one that clears everything. An error drops you out of TV mode, so the load bar
carrying the message is on screen.

### Roster view

Every player you roster, bench included. "Against me" slides off, since none of it applies to your
own bench. Two columns count instead of one:

- **Starts**: lineups you actually have him in, the same number the normal table shows.
- **Shares**: leagues you roster him in at all, starting or not.

A player you're carrying on the bench everywhere shows 0 starts, and shows up nowhere else in the
app. Expanding a row tags each league `starting` or `bench`, so you can see where he's in the lineup
and where he's sitting.

Pts, filters, sorting and search work the same, and both columns sort. Pts still follows league
priority, now counting the leagues he's benched in.

**Both sides** has no meaning here, since there's only one table, so the tag and the filter chip both
go away while you're in the view. The chip comes back set the way you left it.

### Group by games

One card per NFL game, ordered the way the Status column sorts: what's on now, then what's next
soonest first, then what just finished, with byes at the bottom. Games you have nobody in don't get a
card.

The card header is the game itself, both teams with their logos, the score with the leader's side in
white, and the quarter or the kickoff time. Underneath it, the players you have a stake in, split
into "For me" and "Against me". A card with only one side fills the width. Rows still expand to the
per-league breakdown.

Position grouping doesn't apply here, since the game is doing the grouping, and the filter chips
change with it. **Positions** and **Both sides only** go away, **Leagues** stays, and **Status** is
replaced by two chips of its own.

**Game status** asks two things at once:

- **Days**: the days this week's games actually fall on, Thursday before Sunday rather than in
  alphabetical order.
- **Game state**: any combination of yet to play, playing and finished.

Both are multi-selects with select all and none, and the chip names what's left on (`Game status:
MON`, `Game status: SUN, MON · Playing`). Game state is the same setting the Status chip holds in the
other views, so a choice made in one shows up in the other.

**Games** is the list of this week's games, one row each, and works like the Leagues list: the
checkbox keeps a game in the cards, and the order sets where its card sits. Drag or use the arrows to
reorder.

Cards sort themselves by game status until you move one, and after that they stay where you put them,
with any game that turns up later landing at the end. **Reset order** hands them back to sorting
themselves.

A game already hidden by Game status is greyed out in the list with its checkbox disabled, since
there's nothing left to decide about it, but it keeps its position, so the order you set is still
there when the game comes back. Its own checkbox is remembered separately, so a game you unchecked
stays unchecked through a day filter coming and going.

The chips that go away leave their filters inert while they're gone, the way Both sides does in
Roster view, and hand them back on the way out. The search box and the sort you had still apply.

### TV mode

Bigger type, bigger logos, and the subheading, setup bar, search and filter chips all hidden. The
footer stays, since it's where the keys are. Nothing is filtered
out, so it won't go blank midweek, and the status sort already keeps live games near the top. Scores
keep auto-refreshing every two minutes.

## Points

The **Pts** column shows what the player scored this week. Sleeper's matchup payload carries
`players_points`, already computed under that league's scoring rules, so no scoring math happens here
and no extra requests are made.

Leagues score the same player differently, so Pts shows one league's number. The **Leagues** dropdown
controls which: the checkbox includes a league in the tables, the order sets scoring priority. Pts
uses the highest checked league the player appears in, tagged `scoring` in the panel. Uncheck the top
league and the next one takes over. Drag or use the arrows to reorder; the order persists in
`localStorage`.

Commissioner adjustments (`custom_points`) apply to team totals rather than per-player values, so
they aren't reflected. Stat corrections can restate points days later.

### Projections

Before kickoff there are no real points, so Pts shows a projection instead.

| Game state | Pts shows | Tag |
| --- | --- | --- |
| Not started | projection | `proj` |
| In progress | points so far | `live` |
| Final | final points | none |

A player whose team is on bye is tagged `bye`.

Sleeper projections arrive as **raw stats**, so they're multiplied through each league's own
`scoring_settings`, the same dot product Sleeper does server-side. That keeps projections and actuals
in the same units, so a league with 6-point passing TDs projects differently from one with 4. ESPN
returns projections already scored under league rules, so those are used as-is.

The two platforms use different forecasters (Sleeper's from Rotowire, ESPN's their own), so a player
you hold on both projects differently depending on which league sits highest.

## Status column

Where that player's NFL game is, with his own team's score first:

| Game state | Shows |
| --- | --- |
| Not started | day and kickoff in your zone, `SUN 8:20 PM` |
| In progress | score and quarter, `17-14 Q3` (`OT` past the fourth) |
| Final | final score, `24-20 F` |
| Bye | `BYE` |

Sorting goes by game progress first: in progress, then upcoming, then final. Within each, upcoming
games run soonest-first and finished ones most-recent-first, keeping players in the same game
together. Byes pin to the bottom in both directions.

Grouping by position outranks any column sort, so turn it off to get live games at the very top.

## Filters

**Positions**, **Leagues** and **Status** are multi-selects with select all / none, each labelled
with what's currently on. Group by games swaps this set out, see [Modes](#modes).

More than one panel can be open at a time, and they stack in the order you opened them, newest at the
top, so the one you just clicked is the one under your cursor. Closing one leaves the rest where they
are. Positions lists the codes outright (`RB, WR, TE`) since they're short. **Both sides only** carries its own count. **Group by position**
(QB, RB, WR, TE, K, DEF, then the rest) sits inside the Positions panel.

The search box matches players, NFL teams and league names. Every column sorts, independently per
table.

**Hide setup** folds the username and league bar away once the tables are up, for a cleaner view on
a second screen. It starts open every visit, and reappears on its own if a refresh errors, since the
error surfaces there.

## Refreshing

Scores auto-refresh every two minutes while the tab is visible, and immediately on **Refresh
scores**. That re-pulls matchups, game states and projections only, leaving the player database,
league list and rosters cached. Last update sits above the button.

## Running it

Static site, no build step, no dependencies.

```bash
open index.html

# or serve it, which avoids browser CORS restrictions on file:// URLs
python3 -m http.server 8000
```

## How it works

Everything runs in the browser against read-only endpoints. No backend, no API key, and no account
data leaves your machine.

**Sleeper** (`api.sleeper.app/v1`)

| Step | Endpoint |
| --- | --- |
| Current season & week | `GET /state/nfl` |
| Username → user id | `GET /user/<username>` |
| That user's leagues | `GET /user/<user_id>/leagues/nfl/<season>` |
| Rosters, managers, matchups | `GET /league/<league_id>/{rosters,users,matchups/<week>}` |
| Player id → name/position/team | `GET /players/nfl` |

Your roster matches on `owner_id`, falling back to `co_owners`; your opponent is the other roster
sharing your `matchup_id`. A matchup carries `players` as well as `starters`, so your bench is the
difference between the two and costs no extra request. Requests run five leagues at a time, well under Sleeper's
1000-per-minute guidance.

**ESPN** (`lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<season>/segments/0/leagues/<id>`)

| Step | View |
| --- | --- |
| League name, teams, managers | `?view=mTeam&view=mSettings` |
| Matchups, lineups, points, projections | `?view=mBoxscore&scoringPeriodId=<week>` |

Starters are entries whose `lineupSlotId` isn't bench (20) or IR (21), and those two slots are the
bench Roster view shows. Points come from
`appliedStatTotal`, projections from the `statSourceId: 1` row, both already scored under league
rules.

ESPN players match to Sleeper's via `espn_id`, so one player from both platforms lands on one row.
Team defenses go through the team code instead, since ESPN uses negative ids and a different name
("Chiefs D/ST" vs "Kansas City Chiefs").

Sleeper leaves `espn_id` empty for a lot of players, so the fallback is name plus position. Sleeper
drops generational suffixes and ESPN keeps them ("Kenneth Walker" against "Kenneth Walker III"), so
both sides are also matched with the suffix removed. Where that makes two players ambiguous, as with
a father and son who both played, the one currently on a roster wins; if both are, no match is made
rather than guessing. Unmatched players still show, under ESPN's name.

Game states, kickoff times, quarters, scores, home and away, and the team logos the game cards use
all come from ESPN's public scoreboard (`site.api.espn.com`), since Sleeper has no game-status
endpoint. Taking the logo from the scoreboard beats guessing at ESPN's image CDN, which names files
by their own abbreviations rather than the ones used here. If it fails, Pts falls back to
actual points and Status goes blank.

ESPN's `/nfl/teams` endpoint isn't CORS-accessible cross-origin, so the `proTeamId` to abbreviation
map is baked in and topped up each week from the scoreboard.

The player database is ~5 MB, so it's trimmed to name/position/team/injury and cached in
`localStorage` for 24 hours. **Refresh players** clears it. Without storage, it refetches per session.

## Structure

```
index.html            markup
css/styles.css        styling
js/app.js             API calls, aggregation, rendering
favicon.svg           football icon (favicon.png / apple-touch-icon.png are rasterized from it)
```

## ESPN limitations

- **Public leagues only.** Private leagues return 401 and can't be read from a browser at all: the
  `Cookie` header is forbidden to scripts and ESPN's session cookies are `SameSite=Lax`.
- **No account lookup.** Hence adding each league by ID.
- **Unofficial API.** No documentation, terms, or versioning, and it has changed without notice
  before (the base host moved in April 2024). Most likely thing to break.
- **Playoff matchups** spanning multiple weeks, where `matchupPeriodId` and `scoringPeriodId`
  diverge, aren't handled specially yet.

## To do

Nothing queued.

## Notes

Not affiliated with Sleeper or ESPN. Sleeper's API is used per its
[documentation](https://docs.sleeper.com/); ESPN's fantasy endpoints are undocumented and public.
