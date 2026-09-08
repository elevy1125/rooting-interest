/* Rooting Interest
   Pulls your week's fantasy matchups across every league you're in — Sleeper
   by username, ESPN by league ID — and shows, side by side, which players are
   starting for you and which are starting against you. Pure client-side: both
   APIs are read-only and need no auth for the data used here.
*/
(function(){
"use strict";

var API = "https://api.sleeper.app/v1";
var ESPN = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";
var PKEY = "sleeper_players_slim_v3", PTS = "sleeper_players_ts_v3";
var EKEY = "ri_espn_leagues_v1", TKEY = "ri_espn_teams_v1";
var DAY = 86400000;
var POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

var el = function(id){ return document.getElementById(id); };
var statusBox, statusText, bar, errBox, results;

var state = {
  players: null,          // id -> [name, pos, team, injury]
  rows: [],               // aggregated player rows
  meta: null,
  sort: { "for": {key:"count", dir:-1}, "against": {key:"count", dir:-1} },
  group: true,
  bothOnly: false,
  rosterView: false,      // hold R: your whole roster, bench included, full width
  posOff: {},             // positions left out of the tables (default: none)
  statusOff: {},          // game states left out of the tables (default: none)
  search: "",
  open: {},               // "side:playerId" -> bool
  leagueOrder: [],        // league ids, highest scoring priority first
  orderIndex: {},         // league id -> position in leagueOrder
  leagueNames: {},
  byEspn: {},             // espn player id -> sleeper player id
  byName: {},             // "name|pos" -> sleeper player id
  byBase: {},             // same, with the generational suffix dropped
  espnPlayers: {},        // fallback info for players with no Sleeper match
  proTeams: null,         // espn pro team id -> abbreviation
  espnConfig: [],         // [{id, teamId, name, teams:[]}]
  ctx: null,              // user, leagues, rosters/managers — reused across refreshes
  scoring: {},            // league id -> scoring_settings
  gameState: {},          // NFL team -> pre | in | post
  projStats: {},          // player id -> projected raw stats
  projMemo: {},           // "playerId|leagueId" -> projected points
  excluded: {},           // league ids left out of the tables (default: none)
  season: null,           // current NFL season, from /state/nfl
  seasonType: "regular",
  updatedAt: null,
  autoTimer: null,
  refreshing: false
};

var AUTO_MS = 120000;     // auto-refresh cadence while the tab is visible

/* ---------------- helpers ---------------- */

function setStatus(msg, pct){
  statusBox.classList.add("on");
  statusText.textContent = msg;
  bar.style.width = (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + "%";
}
function clearStatus(){ statusBox.classList.remove("on"); bar.style.width = "0%"; }

function setSetupCollapsed(on){
  var box = el("setup"), btn = el("setupToggle");
  box.classList.toggle("collapsed", on);
  btn.textContent = on ? "Show setup" : "Hide setup";
  btn.setAttribute("aria-expanded", on ? "false" : "true");
}

// The error box lives inside the load bar, so a collapsed bar would swallow it.
function showError(msg){
  errBox.textContent = msg;
  errBox.classList.add("on");
  setSetupCollapsed(false);
}
function clearError(){ errBox.classList.remove("on"); errBox.textContent = ""; }
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

function getJSON(url){
  return fetch(url, {cache:"no-store"}).catch(function(){
    throw new Error("Couldn't reach the API. Check your connection. If you opened this file from " +
      "disk, serve the folder instead: run `python3 -m http.server 8000` in it, then open " +
      "http://localhost:8000.");
  }).then(function(r){
    if(r.status === 404) return null;
    if(!r.ok) throw new Error("API returned " + r.status + " for " + url);
    return r.text().then(function(t){
      if(!t || t === "null") return null;
      try { return JSON.parse(t); } catch(e){ throw new Error("Bad JSON from " + url); }
    });
  });
}

// Bounded concurrency — Sleeper asks callers to stay under 1000 requests/minute.
function pool(items, limit, worker, onProgress){
  var i = 0, done = 0, out = new Array(items.length), active = 0;
  return new Promise(function(resolve, reject){
    var failed = false;
    function next(){
      if(failed) return;
      if(done === items.length) return resolve(out);
      while(active < limit && i < items.length){
        (function(idx){
          active++; i++;
          Promise.resolve(worker(items[idx], idx)).then(function(v){
            out[idx] = v; active--; done++;
            if(onProgress) onProgress(done, items.length);
            next();
          }, function(e){ failed = true; reject(e); });
        })(i);
      }
    }
    next();
  });
}

function posRank(p){
  var i = POS_ORDER.indexOf(p);
  return i === -1 ? POS_ORDER.length : i;
}

/* ---------------- player database ---------------- */

function readCache(){
  try{
    var ts = parseInt(localStorage.getItem(PTS) || "0", 10);
    if(!ts || Date.now() - ts > DAY) return null;
    var raw = localStorage.getItem(PKEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function writeCache(slim){
  try{
    localStorage.setItem(PKEY, JSON.stringify(slim));
    localStorage.setItem(PTS, String(Date.now()));
  }catch(e){ /* storage unavailable or full — run from memory */ }
}

function indexPlayers(slim){
  state.players = slim;
  state.byEspn = {};
  state.byName = {};
  state.byBase = {};
  var id, p, base, cur;
  for(id in slim){
    p = slim[id];
    if(p[4]) state.byEspn[String(p[4])] = id;
    state.byName[nameKey(p[0], p[1])] = id;

    // Two players can share a base name once the suffix is gone (Marvin
    // Harrison and Marvin Harrison Jr.). Prefer the one on a roster, and if
    // both are, refuse to guess rather than put the wrong player on the row.
    base = baseNameKey(p[0], p[1]);
    cur = state.byBase[base];
    if(cur === undefined) state.byBase[base] = id;
    else if(cur !== null && onTeam(p)) state.byBase[base] = onTeam(slim[cur]) ? null : id;
  }
  return slim;
}

function onTeam(p){ return !!(p && p[2]); }

function nameKey(name, pos){
  return String(name || "").toLowerCase().replace(/[^a-z]/g, "") + "|" + (pos || "");
}

// Sleeper and ESPN disagree about generational suffixes ("Kenneth Walker III"
// against "Kenneth Walker"), and either side can be the one carrying it, so
// both go through this before falling back to a name match. Suffixes stack
// ("Jr. II"), and one is only dropped while a first and last name remain.
var SUFFIX = /[\s,]+(?:jr|sr|ii|iii|iv|v)\.?$/i;

function baseName(name){
  var s = String(name || "").trim(), m;
  while((m = s.match(SUFFIX)) && s.slice(0, m.index).trim().split(/\s+/).length > 1){
    s = s.slice(0, m.index).trim();
  }
  return s;
}

function baseNameKey(name, pos){ return nameKey(baseName(name), pos); }

function loadPlayers(){
  if(state.players) return Promise.resolve(state.players);
  var cached = readCache();
  if(cached) return Promise.resolve(indexPlayers(cached));
  setStatus("Downloading the player database (~5 MB, cached 24 hours)…", 5);
  return getJSON(API + "/players/nfl").then(function(all){
    if(!all) throw new Error("Could not load the NFL player database.");
    var slim = {}, id, p, name;
    for(id in all){
      p = all[id];
      if(!p) continue;
      name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id;
      slim[id] = [name, p.position || (p.fantasy_positions && p.fantasy_positions[0]) || "",
                  p.team || "", p.injury_status || "", p.espn_id || ""];
    }
    writeCache(slim);
    return indexPlayers(slim);
  });
}

function playerInfo(id){
  var p = state.players && state.players[id];
  if(p) return {name:p[0], pos:p[1] || "?", team:p[2] || "FA", inj:p[3] || ""};
  var ex = state.espnPlayers[id];
  if(ex) return ex;
  return {name:"Player " + id, pos:"?", team:"", inj:""};
}

/* ---------------- ESPN ---------------- */

var ESPN_POS = {1:"QB", 2:"RB", 3:"WR", 4:"TE", 5:"K", 16:"DEF"};
var BENCH_SLOTS = {20:1, 21:1};        // bench, IR — everything else is a starter

// ESPN identifies NFL teams by a numeric id. Their /teams endpoint is not
// CORS-accessible from a third-party origin (the scoreboard is), so this map is
// baked in — read off live scoreboards — and topped up each week from the
// scoreboard we already fetch, in case ESPN ever renumbers.
var PRO_TEAMS = {
  1:"ATL",  2:"BUF",  3:"CHI",  4:"CIN",  5:"CLE",  6:"DAL",  7:"DEN",  8:"DET",
  9:"GB",  10:"TEN", 11:"IND", 12:"KC",  13:"LV",  14:"LAR", 15:"MIA", 16:"MIN",
  17:"NE", 18:"NO",  19:"NYG", 20:"NYJ", 21:"PHI", 22:"ARI", 23:"PIT", 24:"LAC",
  25:"SF", 26:"SEA", 27:"TB",  28:"WAS", 29:"CAR", 30:"JAX", 33:"BAL", 34:"HOU"
};
function loadProTeams(){
  if(!state.proTeams){
    state.proTeams = {};
    for(var k in PRO_TEAMS) state.proTeams[k] = PRO_TEAMS[k];
    try{
      var cached = JSON.parse(localStorage.getItem(TKEY) || "null");
      if(cached) for(var c in cached) state.proTeams[c] = cached[c];
    }catch(e){}
  }
  return Promise.resolve(state.proTeams);
}
function noteProTeam(id, abbr){
  if(!id || !abbr) return;
  var a = normTeam(abbr);
  if(state.proTeams && state.proTeams[String(id)] !== a){
    state.proTeams[String(id)] = a;
    try{ localStorage.setItem(TKEY, JSON.stringify(state.proTeams)); }catch(e){}
  }
}

function espnLeagueURL(season, id, views, week){
  return ESPN + "/" + season + "/segments/0/leagues/" + encodeURIComponent(id) +
    "?" + views.map(function(v){ return "view=" + v; }).join("&") +
    (week ? "&scoringPeriodId=" + week : "");
}

function espnError(status){
  if(status === 401) return "that league is private. ESPN allows browser access to public leagues only";
  if(status === 404) return "no ESPN league with that ID this season";
  return "ESPN returned " + status;
}

// Team names and managers. Fetched once per load, not on every score refresh.
function fetchEspnTeams(season, id){
  return fetch(espnLeagueURL(season, id, ["mTeam", "mSettings"])).then(function(r){
    if(!r.ok) throw new Error(espnError(r.status));
    return r.json();
  }).then(function(j){
    var members = {};
    (j.members || []).forEach(function(m){ members[m.id] = m.displayName || ""; });
    return {
      name: (j.settings && j.settings.name) || ("ESPN league " + id),
      teams: (j.teams || []).map(function(t){
        return {
          id: t.id,
          name: t.name || ((t.location || "") + " " + (t.nickname || "")).trim() || ("Team " + t.id),
          manager: ((t.owners || []).map(function(o){ return members[o]; })
            .filter(Boolean)[0]) || ""
        };
      })
    };
  });
}

function fetchEspnBox(season, id, week){
  return fetch(espnLeagueURL(season, id, ["mBoxscore"], week)).then(function(r){
    if(!r.ok) throw new Error(espnError(r.status));
    return r.json();
  }).then(function(j){ return j.schedule || []; });
}

// Fold an ESPN roster entry into the shape the aggregator expects.
function espnEntry(entry){
  var ppe = entry.playerPoolEntry || {};
  var pl = ppe.player || {};
  var stats = pl.stats || [], i, actual = null, proj = null;
  for(i = 0; i < stats.length; i++){
    if(stats[i].statSplitTypeId !== 1) continue;
    if(stats[i].statSourceId === 0 && typeof stats[i].appliedTotal === "number") actual = stats[i].appliedTotal;
    if(stats[i].statSourceId === 1 && typeof stats[i].appliedTotal === "number") proj = stats[i].appliedTotal;
  }
  if(actual === null && typeof ppe.appliedStatTotal === "number") actual = ppe.appliedStatTotal;
  var pos = ESPN_POS[pl.defaultPositionId] || "?";
  var team = state.proTeams[String(pl.proTeamId)] || "";
  var espnId = String(ppe.id || pl.id || "");

  // Prefer Sleeper's id so ESPN and Sleeper leagues land on the same row.
  // Sleeper keys team defenses by abbreviation ("KC"), ESPN by a negative id,
  // and the names don't match ("Chiefs D/ST" vs "Kansas City Chiefs"), so
  // defenses have to go through the team code.
  var id = state.byEspn[espnId];
  if(!id && pos === "DEF" && team && state.players && state.players[team]) id = team;
  if(!id) id = state.byName[nameKey(pl.fullName, pos)];
  if(!id) id = state.byBase[baseNameKey(pl.fullName, pos)];
  if(!id){
    id = "espn:" + espnId;
    state.espnPlayers[id] = {name: pl.fullName || ("ESPN " + espnId), pos:pos, team:team || "FA", inj:""};
  }
  return {id:id, points:actual, proj:proj, slot:entry.lineupSlotId};
}

/* ---------------- fetch + aggregate ---------------- */

function teamNameFor(roster, usersById){
  if(!roster) return "Unknown team";
  var u = usersById[roster.owner_id];
  if(u){
    var meta = u.metadata || {};
    return meta.team_name || u.display_name || u.username || ("Roster " + roster.roster_id);
  }
  return "Roster " + roster.roster_id;
}

function myRoster(rosters, userId){
  var i, r;
  for(i = 0; i < rosters.length; i++){
    if(rosters[i].owner_id === userId) return rosters[i];
  }
  for(i = 0; i < rosters.length; i++){
    r = rosters[i];
    if(r.co_owners && r.co_owners.indexOf(userId) !== -1) return r;
  }
  return null;
}

/* ---------------- ESPN league config ---------------- */

function loadEspnConfig(){
  try{ state.espnConfig = JSON.parse(localStorage.getItem(EKEY) || "[]") || []; }
  catch(e){ state.espnConfig = []; }
  if(!Array.isArray(state.espnConfig)) state.espnConfig = [];
}
function saveEspnConfig(){
  try{ localStorage.setItem(EKEY, JSON.stringify(state.espnConfig)); }catch(e){}
}

/* ---------------- game state + projections ---------------- */

// ESPN spells a few teams differently than Sleeper does.
var TEAM_ALIAS = {WSH:"WAS", LA:"LAR", JAC:"JAX", ARZ:"ARI", BLT:"BAL", CLV:"CLE",
                  HST:"HOU", SD:"LAC", OAK:"LV", STL:"LAR"};
function normTeam(t){
  if(!t) return "";
  t = String(t).toUpperCase();
  return TEAM_ALIAS[t] || t;
}

function toScore(v){
  var n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// Which NFL teams have played, are playing, or haven't kicked off yet — plus
// kickoff time, quarter and score, which the Status column renders.
// Sleeper has no game-state endpoint; ESPN's public scoreboard does and is CORS-open.
function fetchGameStates(season, week, seasonType){
  loadProTeams();
  var st = seasonType === "post" ? 3 : (seasonType === "pre" ? 1 : 2);
  var url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard" +
    "?week=" + week + "&seasontype=" + st + "&dates=" + season;
  return getJSON(url).then(function(j){
    var map = {};
    (j && j.events || []).forEach(function(ev){
      var status = ev.status || {}, type = status.type || {};
      var comps = (ev.competitions && ev.competitions[0] && ev.competitions[0].competitors) || [];
      var kick = Date.parse(ev.date || "");
      comps.forEach(function(c, i){
        if(!(c.team && c.team.abbreviation)) return;
        var other = comps[1 - i];              // an NFL game always has exactly two sides
        map[normTeam(c.team.abbreviation)] = {
          state: type.state || null,           // pre | in | post
          kickoff: isNaN(kick) ? null : kick,
          period: status.period || 0,
          score: toScore(c.score),
          oppScore: other ? toScore(other.score) : null,
          opp: other && other.team ? normTeam(other.team.abbreviation) : ""
        };
        noteProTeam(c.team.id, c.team.abbreviation);   // keep the id map honest
      });
    });
    return map;
  }).catch(function(){ return {}; });   // no game states just means no projections shown
}

// Raw projected stats per player. Undocumented endpoint on a different Sleeper
// subdomain than the rest of the app; if it fails we degrade to actual points only.
function fetchProjections(season, week, seasonType, positions){
  var qs = "?season_type=" + (seasonType || "regular") +
    positions.map(function(p){ return "&position[]=" + encodeURIComponent(p); }).join("");
  return getJSON("https://api.sleeper.com/projections/nfl/" + season + "/" + week + qs)
    .then(function(list){
      var map = {};
      (list || []).forEach(function(row){
        if(row && row.player_id && row.stats) map[row.player_id] = deriveStats(row.stats);
      });
      return map;
    }).catch(function(){ return {}; });
}

var FG_MISS_BUCKETS = ["fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fgmiss_40_49", "fgmiss_50p"];

// Projections report missed field goals only by distance bucket, but most
// leagues penalise them with a single `fgmiss` setting. Without this the miss
// penalty silently never applies and every kicker projects a little high.
function deriveStats(stats){
  if(typeof stats.fgmiss !== "number"){
    var total = 0, found = false;
    FG_MISS_BUCKETS.forEach(function(k){
      if(typeof stats[k] === "number"){ total += stats[k]; found = true; }
    });
    if(found) stats.fgmiss = total;
  }
  return stats;
}

// Sleeper's scoring_settings keys match the stat keys in the projection payload,
// so a league's projected points are just the dot product of the two.
function projPoints(stats, scoring){
  if(!stats || !scoring) return null;
  var total = 0, hit = false, k;
  for(k in scoring){
    if(typeof scoring[k] === "number" && typeof stats[k] === "number"){
      total += stats[k] * scoring[k];
      hit = true;
    }
  }
  return hit ? total : null;
}

function projFor(playerId, leagueId){
  var key = playerId + "|" + leagueId;
  if(Object.prototype.hasOwnProperty.call(state.projMemo, key)) return state.projMemo[key];
  var v = projPoints(state.projStats[playerId], state.scoring[leagueId]);
  state.projMemo[key] = v;
  return v;
}

function gameOf(row){
  var t = normTeam(row.team);
  return (!t || t === "FA") ? null : (state.gameState[t] || null);
}

// pre = not kicked off (show projection), in = playing, post = done, bye = no game.
// "none" means we have no scoreboard at all, so nothing can be said either way.
function gameMode(row){
  var t = normTeam(row.team);
  if(!t || t === "FA") return "none";
  var g = state.gameState[t], s = g && g.state;
  if(s === "pre") return "pre";
  if(s === "in") return "in";
  if(s === "post") return "post";
  return Object.keys(state.gameState).length ? "bye" : "none";
}

var DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function fmtKick(ms){
  var d = new Date(ms);                       // renders in the viewer's own zone
  var h = d.getHours(), m = d.getMinutes();
  var ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if(h === 0) h = 12;
  return DAY_ABBR[d.getDay()] + " " + h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
}

// Quarter while a game is live; 5+ is overtime.
function fmtPeriod(p){ return !p ? "" : (p > 4 ? "OT" : "Q" + p); }

// What the Status column shows: kickoff before, score + quarter during, final score after.
// The player's own team is always the left-hand number.
function statusCell(row){
  var mode = gameMode(row), g = gameOf(row);
  if(mode === "pre"){
    return {main: g && g.kickoff ? fmtKick(g.kickoff) : "", note: "", cls: "pre"};
  }
  if(mode === "in" || mode === "post"){
    var score = (g && g.score !== null && g.oppScore !== null)
      ? g.score + "-" + g.oppScore : "";
    return {main: score, note: mode === "in" ? fmtPeriod(g.period) : "F", cls: mode};
  }
  if(mode === "bye") return {main: "BYE", note: "", cls: "bye"};
  return {main: "", note: "", cls: "none"};
}

/* ---------------- fetch + aggregate ---------------- */

// Everything that doesn't change during a game day: the user, their leagues
// (including scoring_settings) and each league's rosters and managers.
function loadContext(username, season, week){
  var user = null, leagues = [];

  var sleeper = !username ? Promise.resolve(null)
    : getJSON(API + "/user/" + encodeURIComponent(username)).then(function(u){
        if(!u || !u.user_id) throw new Error('No Sleeper user found named "' + username + '".');
        user = u;
        setStatus("Finding " + season + " leagues…", 12);
        return getJSON(API + "/user/" + u.user_id + "/leagues/nfl/" + season);
      }).then(function(ls){
        leagues = ls || [];
        if(!leagues.length && !state.espnConfig.length){
          throw new Error("That account has no NFL leagues for " + season + ".");
        }
        setStatus("Loading " + leagues.length + " Sleeper leagues…", 18);
        return pool(leagues, 5, function(lg){
          return Promise.all([
            getJSON(API + "/league/" + lg.league_id + "/rosters"),
            getJSON(API + "/league/" + lg.league_id + "/users")
          ]).then(function(res){ return {rosters:res[0] || [], users:res[1] || []}; });
        }, function(done, total){
          setStatus("Leagues… " + done + " of " + total, 18 + Math.round((done / total) * 40));
        });
      });

  return sleeper.then(function(perLeague){
    var data = {};
    state.scoring = {};
    leagues.forEach(function(lg, i){
      data[lg.league_id] = (perLeague || [])[i] || {rosters:[], users:[]};
      state.scoring[lgKey(lg.league_id)] = lg.scoring_settings || null;
    });
    state.ctx = {user:user, season:season, week:week, leagues:leagues, leagueData:data, espn:[]};

    if(!state.espnConfig.length) return state.ctx;
    setStatus("ESPN leagues…", 60);
    return loadProTeams().then(function(){
      return pool(state.espnConfig, 3, function(cfg){
        return fetchEspnTeams(season, cfg.id).then(function(info){
          return {id:cfg.id, teamId:cfg.teamId, name:info.name, teams:info.teams, error:null};
        }).catch(function(err){
          return {id:cfg.id, teamId:cfg.teamId, name:cfg.name || ("ESPN league " + cfg.id),
                  teams:cfg.teams || [], error:err.message};
        });
      });
    }).then(function(list){
      state.ctx.espn = list;
      // keep the saved config's names and team lists fresh for the picker
      list.forEach(function(l){
        var cfg = state.espnConfig.filter(function(c){ return c.id === l.id; })[0];
        if(cfg && !l.error){ cfg.name = l.name; cfg.teams = l.teams; }
      });
      saveEspnConfig();
      return state.ctx;
    });
  });
}

// League ids are namespaced so a Sleeper and an ESPN league can never collide
// in the priority order.
function lgKey(id){ return "sl:" + id; }
function esKey(id){ return "es:" + id; }

// Everything that does change: matchups (live points), game states, projections.
function loadScores(quiet){
  var ctx = state.ctx;
  if(!ctx) return Promise.reject(new Error("Nothing loaded yet."));
  if(!quiet) setStatus("Matchups…", 70);

  return Promise.all([
    pool(ctx.leagues, 5, function(lg){
      return getJSON(API + "/league/" + lg.league_id + "/matchups/" + ctx.week)
        .then(function(m){ return m || []; });
    }),
    pool(ctx.espn, 3, function(l){
      if(l.error) return null;
      return fetchEspnBox(ctx.season, l.id, ctx.week).catch(function(err){
        l.error = err.message;
        return null;
      });
    })
  ]).then(function(both){
    var matchups = both[0], boxes = both[1];
    var byLeague = {};
    ctx.leagues.forEach(function(lg, i){ byLeague[lg.league_id] = matchups[i]; });
    ctx.espn.forEach(function(l, i){ l.schedule = boxes[i]; });

    // which positions are actually in these lineups, so we don't pull every projection
    var positions = {};
    ctx.leagues.forEach(function(lg){
      (byLeague[lg.league_id] || []).forEach(function(m){
        // players, not starters: a benched player still needs a projection.
        (m.players || m.starters || []).forEach(function(pid){
          if(pid && pid !== "0"){
            var info = playerInfo(pid);
            if(info.pos && info.pos !== "?") positions[info.pos] = true;
          }
        });
      });
    });

    if(!quiet) setStatus("Scores and projections…", 88);
    return Promise.all([
      fetchGameStates(ctx.season, ctx.week, state.seasonType),
      fetchProjections(ctx.season, ctx.week, state.seasonType, Object.keys(positions))
    ]).then(function(res){
      state.gameState = res[0];
      state.projStats = res[1];
      state.projMemo = {};
      state.updatedAt = Date.now();
      return aggregate(byLeague);
    });
  });
}

function run(username, season, week){
  return loadContext(username, season, week).then(function(){ return loadScores(false); });
}

function aggregate(matchupsByLeague){
  // No Sleeper username means no user and no Sleeper leagues, so the loop below
  // never runs and this id is never read. It still has to not throw.
  var ctx = state.ctx, userId = ctx.user ? ctx.user.user_id : null, week = ctx.week;
  var leagues = ctx.leagues;
  var byPlayer = {}, active = [];

  function add(pid, side, c){
    if(!pid || pid === "0") return;
    var row = byPlayer[pid];
    if(!row){
      var info = playerInfo(pid);
      // Counts aren't stored: they're derived from `entries` so the league
      // filter can change them without re-aggregating.
      row = byPlayer[pid] = {
        id:pid, name:info.name, pos:info.pos, team:info.team, inj:info.inj, entries:[]
      };
    }
    var pts = c.points && Object.prototype.hasOwnProperty.call(c.points, pid)
      ? Number(c.points[pid]) : null;
    if(typeof c.directPoints === "number") pts = c.directPoints;
    row.entries.push({
      league: c.league, leagueId: c.leagueId, side: side, platform: c.platform || "sleeper",
      startedBy: side === "for" ? c.myTeam : c.oppTeam,
      versus:    side === "for" ? c.oppTeam : c.myTeam,
      manager:   side === "for" ? c.myManager : c.oppManager,
      points: (pts === null || isNaN(pts)) ? null : pts,
      proj: typeof c.directProj === "number" ? c.directProj : undefined,
      bench: !!c.bench
    });
  }

  leagues.forEach(function(lg){
    var b = ctx.leagueData[lg.league_id] || {rosters:[], users:[]};
    b.matchups = matchupsByLeague[lg.league_id] || [];
    var name = lg.name || ("League " + lg.league_id);
    var usersById = {}, rostersById = {};
    b.users.forEach(function(u){ usersById[u.user_id] = u; });
    b.rosters.forEach(function(r){ rostersById[r.roster_id] = r; });

    var mine = myRoster(b.rosters, userId);
    if(!mine) return;

    var myM = null, i;
    for(i = 0; i < b.matchups.length; i++){
      if(b.matchups[i].roster_id === mine.roster_id){ myM = b.matchups[i]; break; }
    }
    if(!myM) return;

    var opps = b.matchups.filter(function(m){
      return m.matchup_id != null && m.matchup_id === myM.matchup_id && m.roster_id !== mine.roster_id;
    });

    var myTeam = teamNameFor(mine, usersById);
    var myManager = (usersById[mine.owner_id] || {}).display_name || "";
    var myStarters = (myM.starters || []).filter(function(p){ return p && p !== "0"; });
    if(!myStarters.length) return;

    var oppRoster = opps.length ? rostersById[opps[0].roster_id] : null;
    var oppTeam = opps.length ? teamNameFor(oppRoster, usersById) : "— no opponent —";
    var oppManager = oppRoster ? ((usersById[oppRoster.owner_id] || {}).display_name || "") : "";

    active.push({id:lgKey(lg.league_id), name:name, platform:"sleeper"});

    myStarters.forEach(function(pid){
      add(pid, "for", {league:name, leagueId:lgKey(lg.league_id), myTeam:myTeam, oppTeam:oppTeam,
        myManager:myManager, oppManager:oppManager, points: myM.players_points});
    });

    // Your bench rides along on every load so Roster view has it without a
    // second pass. sideEntries() keeps it out of the normal tables.
    var started = {};
    myStarters.forEach(function(pid){ started[pid] = true; });
    (myM.players || mine.players || []).forEach(function(pid){
      if(!pid || pid === "0" || started[pid]) return;
      add(pid, "for", {league:name, leagueId:lgKey(lg.league_id), myTeam:myTeam, oppTeam:oppTeam,
        myManager:myManager, oppManager:oppManager, points: myM.players_points, bench:true});
    });

    opps.forEach(function(om){
      var r = rostersById[om.roster_id];
      var c = {
        league:name, leagueId:lgKey(lg.league_id), myTeam:myTeam, oppTeam:teamNameFor(r, usersById),
        myManager:myManager,
        oppManager: r ? ((usersById[r.owner_id] || {}).display_name || "") : "",
        points: om.players_points
      };
      (om.starters || []).forEach(function(pid){ add(pid, "against", c); });
    });
  });

  /* ---- ESPN leagues ---- */
  (ctx.espn || []).forEach(function(l){
    var name = l.name || ("ESPN league " + l.id);
    if(l.error || !l.teamId) return;

    var teamsById = {};
    (l.teams || []).forEach(function(t){ teamsById[t.id] = t; });
    var nameOf = function(id){ return (teamsById[id] && teamsById[id].name) || ("Team " + id); };
    var mgrOf  = function(id){ return (teamsById[id] && teamsById[id].manager) || ""; };

    var mine = null, side = null;
    (l.schedule || []).forEach(function(m){
      if(m.matchupPeriodId !== week) return;
      if(m.home && m.home.teamId === l.teamId){ mine = m; side = "home"; }
      else if(m.away && m.away.teamId === l.teamId){ mine = m; side = "away"; }
    });
    if(!mine) return;

    var me = mine[side], them = mine[side === "home" ? "away" : "home"];
    var lineup = function(s, bench){
      var ents = (s && s.rosterForCurrentScoringPeriod && s.rosterForCurrentScoringPeriod.entries) || [];
      return ents.filter(function(e){
        return bench ? !!BENCH_SLOTS[e.lineupSlotId] : !BENCH_SLOTS[e.lineupSlotId];
      }).map(espnEntry);
    };
    var mineStarters = lineup(me, false);
    if(!mineStarters.length) return;

    var myTeam = nameOf(l.teamId);
    var oppTeam = them ? nameOf(them.teamId) : "— no opponent —";
    active.push({id:esKey(l.id), name:name, platform:"espn"});

    var base = {league:name, leagueId:esKey(l.id), platform:"espn",
      myTeam:myTeam, oppTeam:oppTeam,
      myManager: mgrOf(l.teamId), oppManager: them ? mgrOf(them.teamId) : ""};

    mineStarters.forEach(function(p){
      var c = {}; for(var k in base) c[k] = base[k];
      c.directPoints = p.points; c.directProj = p.proj;
      add(p.id, "for", c);
    });
    lineup(me, true).forEach(function(p){
      var c = {}; for(var k in base) c[k] = base[k];
      c.directPoints = p.points; c.directProj = p.proj; c.bench = true;
      add(p.id, "for", c);
    });
    if(them) lineup(them, false).forEach(function(p){
      var c = {}; for(var k in base) c[k] = base[k];
      c.directPoints = p.points; c.directProj = p.proj;
      add(p.id, "against", c);
    });
  });

  return {
    user: ctx.user,
    rows: Object.keys(byPlayer).map(function(k){ return byPlayer[k]; }),
    activeLeagues:active, season:ctx.season, week:week
  };
}

/* ---------------- rendering ---------------- */

function included(leagueId){ return !state.excluded[leagueId]; }

// Entries for one side, honouring the league filter. Counts are derived from
// this rather than the totals baked in at aggregation time, so unchecking a
// league updates starts, points and details together.
// Bench entries only exist on the "for" side and only Roster view wants them,
// so this is the one place the two views diverge: everything downstream
// (counts, points, details, search) follows whatever it returns.
function sideEntries(row, side){
  var withBench = state.rosterView && side === "for";
  return row.entries.filter(function(e){
    return e.side === side && included(e.leagueId) && (withBench || !e.bench);
  });
}
// Starts is lineups he's actually in; shares is lineups he's on at all. Outside
// Roster view there are no bench entries, so the two are the same number.
function countOf(row, side){
  return sideEntries(row, side).filter(function(e){ return !e.bench; }).length;
}
function sharesOf(row, side){ return sideEntries(row, side).length; }
function isBoth(row){ return countOf(row, "for") > 0 && countOf(row, "against") > 0; }

// The value shown for one player in one league: actual points once his game has
// started, the league-scored projection before that.
function shownValue(row, entry, mode){
  if(mode === "pre"){
    // ESPN hands us a league-scored projection directly; for Sleeper we compute one.
    if(typeof entry.proj === "number") return entry.proj;
    return projFor(row.id, entry.leagueId);
  }
  return typeof entry.points === "number" ? entry.points : null;
}

// Points for one player on one side. Leagues can score the same player
// differently, so we show the highest-priority league he appears in, plus the
// spread across the rest.
function ptsInfo(row, side){
  var mode = gameMode(row);
  var best = null, bestRank = Infinity, bestVal = null, vals = [];
  sideEntries(row, side).forEach(function(e){
    var v = shownValue(row, e, mode);
    if(typeof v !== "number") return;
    var rank = state.orderIndex[e.leagueId];
    if(rank === undefined) rank = 9999;
    if(rank < bestRank){ bestRank = rank; best = e; bestVal = v; }
    vals.push(v);
  });
  if(!vals.length) return {val:null, min:null, max:null, league:null, mode:mode};
  return {
    val: bestVal, league: best.league, mode: mode,
    min: Math.min.apply(null, vals), max: Math.max.apply(null, vals)
  };
}
function ptsOf(row, side){
  var p = ptsInfo(row, side);
  return p.val === null ? -Infinity : p.val;
}
function fmtPts(n){ return (Math.round(n * 100) / 100).toFixed(1); }

function rebuildOrderIndex(){
  state.orderIndex = {};
  state.leagueOrder.forEach(function(id, i){ state.orderIndex[id] = i; });
}

function prioKey(){
  return "ri_prio_" + (state.meta && state.meta.user ? state.meta.user.user_id : "local");
}

function loadOrder(activeLeagues){
  var ids = activeLeagues.map(function(l){ return l.id; });
  var saved = null;
  try{ saved = JSON.parse(localStorage.getItem(prioKey()) || "null"); }catch(e){}
  var order = [];
  if(saved && saved.length){
    // keep saved order, drop leagues that are gone, append ones that are new
    saved.forEach(function(id){ if(ids.indexOf(id) !== -1) order.push(id); });
  }
  ids.forEach(function(id){ if(order.indexOf(id) === -1) order.push(id); });
  state.leagueOrder = order;
  state.leagueNames = {};
  activeLeagues.forEach(function(l){ state.leagueNames[l.id] = l.name; });
  rebuildOrderIndex();
}
function saveOrder(){
  try{ localStorage.setItem(prioKey(), JSON.stringify(state.leagueOrder)); }catch(e){}
}

function renderFooter(m){
  var who = m.user ? (m.user.display_name || m.user.username) : "";
  var srcs = [];
  if(m.user) srcs.push("Sleeper");
  if((state.ctx.espn || []).length) srcs.push("ESPN");
  el("foot").textContent = (who ? who + " · " : "") + m.season + " week " + m.week +
    " · data from " + (srcs.join(" and ") || "Sleeper");
}

// Positions present in the current rows, in the usual fantasy order.
function posList(){
  var seen = {};
  state.rows.forEach(function(r){ seen[r.pos] = true; });
  return Object.keys(seen).sort(function(a, b){
    return posRank(a) - posRank(b) || a.localeCompare(b);
  });
}

/* Positions and Status are the same widget over different values: a list of
   checkboxes, select all/none, and a chip naming what's on. `key` is the state
   object holding the values that are switched OFF. `chipText` overrides the
   default label. Returns its own render function. */
function multiFilter(cfg){
  var chip = el(cfg.toggle), panel = el(cfg.panel), list = el(cfg.list);

  function off(){ return state[cfg.key]; }
  function label(v){ return cfg.label ? cfg.label(v) : v; }

  // Name what's on while the names still fit, then fall back to a count.
  function defaultText(on, items){
    return on.length === items.length ? cfg.title
      : !on.length ? cfg.title + ": none"
      : on.length <= cfg.maxNames ? cfg.title + ": " + on.map(label).join(", ")
      : cfg.title + ": " + on.length + " of " + items.length;
  }

  function render(){
    var items = cfg.items();
    list.innerHTML = items.map(function(v, i){
      var id = cfg.list + i;
      return '<li><label for="' + id + '"><input type="checkbox" id="' + id +
        '" data-v="' + esc(v) + '"' + (off()[v] ? "" : " checked") + ">" +
        '<span class="lname">' + esc(label(v)) + "</span></label></li>";
    }).join("");

    var on = items.filter(function(v){ return !off()[v]; });
    chip.textContent = (cfg.chipText || defaultText)(on, items);
    chip.classList.toggle("filtered", on.length !== items.length);
  }

  function apply(){ render(); renderTables(); }

  chip.addEventListener("click", function(){
    panel.hidden = !panel.hidden;
    this.classList.toggle("open", !panel.hidden);
  });
  list.addEventListener("change", function(e){
    var cb = e.target.closest("input[type=checkbox]");
    if(!cb) return;
    var v = cb.getAttribute("data-v");
    if(cb.checked) delete off()[v];
    else off()[v] = true;
    apply();
  });
  el(cfg.all).addEventListener("click", function(){ state[cfg.key] = {}; apply(); });
  el(cfg.none).addEventListener("click", function(){
    cfg.items().forEach(function(v){ off()[v] = true; });
    apply();
  });

  return render;
}

var renderPosFilter, renderStatusFilter;

// "none" is deliberately absent: with no scoreboard there's nothing to filter on,
// so those rows stay visible whatever the boxes say.
var STATUS_ORDER = ["pre", "in", "post", "bye"];
var STATUS_LABEL = {pre:"Yet to play", "in":"Playing", post:"Finished", bye:"Bye"};

// Only the states actually present this week get a row.
function statusList(){
  var seen = {};
  state.rows.forEach(function(r){ seen[gameMode(r)] = true; });
  return STATUS_ORDER.filter(function(s){ return seen[s]; });
}


/* Status sort: live games first (what you're watching), then games still to
   come soonest-first, then finished ones most-recent-first. Players in the same
   game always land together. */
var STATUS_RANK = {"in":0, pre:1, post:2, bye:3, none:3};
var STATUS_PIN = {bye:1, none:1};
function statusRank(row){ return STATUS_RANK[gameMode(row)]; }
function kickoffOf(row){ var g = gameOf(row); return g && g.kickoff; }

function visibleRows(side){
  var q = state.search.trim().toLowerCase();
  var s = state.sort[side];
  return state.rows.filter(function(r){
    if(sharesOf(r, side) === 0) return false;
    if(state.bothOnly && !isBoth(r)) return false;
    if(state.posOff[r.pos]) return false;
    if(state.statusOff[gameMode(r)]) return false;
    if(q){
      var hay = (r.name + " " + r.pos + " " + r.team + " " + sideEntries(r, side)
        .map(function(e){ return e.league + " " + e.startedBy + " " + e.versus; })
        .join(" ")).toLowerCase();
      if(hay.indexOf(q) === -1) return false;
    }
    return true;
  }).sort(function(a, b){
    var c;
    if(s.key === "status"){
      // Rows with no game to report carry no status, so they'd otherwise take
      // turns capping whichever end you sorted from. Park them at the bottom
      // both ways, before direction is applied.
      var pa = STATUS_PIN[gameMode(a)] ? 1 : 0, pb = STATUS_PIN[gameMode(b)] ? 1 : 0;
      if(pa !== pb) return pa - pb;
      c = statusRank(a) - statusRank(b);
      if(c === 0){
        var t = (kickoffOf(a) || 0) - (kickoffOf(b) || 0);
        // Games still ahead of you read forward in time (soonest first), but
        // finished ones read backward, so the game that just ended is on top.
        c = gameMode(a) === "post" ? -t : t;
      }
      if(c === 0) c = String(a.team).localeCompare(String(b.team));
    }
    else if(s.key === "count") c = countOf(a, side) - countOf(b, side);
    else if(s.key === "shares") c = sharesOf(a, side) - sharesOf(b, side);
    else if(s.key === "pts") c = ptsOf(a, side) - ptsOf(b, side);
    else if(s.key === "pos") c = posRank(a.pos) - posRank(b.pos) || a.pos.localeCompare(b.pos);
    else if(s.key === "name") c = a.name.localeCompare(b.name);
    else c = String(a[s.key]).localeCompare(String(b[s.key]));
    if(c === 0) c = (countOf(a, side) - countOf(b, side)) || b.name.localeCompare(a.name);
    return c * s.dir;
  });
}

function detailHTML(row, side, cols){
  // The "for" table shows who you're up against; the "against" table doesn't need
  // a column repeating your own team name on every row.
  var showFacing = side === "for";
  var showLineup = state.rosterView && side === "for";
  var top = topIncluded();
  var mode = gameMode(row);
  var body = sideEntries(row, side)
    .sort(function(a, b){
      var ra = state.orderIndex[a.leagueId], rb = state.orderIndex[b.leagueId];
      return (ra === undefined ? 9999 : ra) - (rb === undefined ? 9999 : rb);
    })
    .map(function(e){
      var used = e.leagueId === top;
      var v = shownValue(row, e, mode);
      return '<tr' + (used ? ' class="lead"' : "") + "><td>" + esc(e.league) +
        '<span class="plat ' + e.platform + '">' + (e.platform === "espn" ? "ESPN" : "Sleeper") +
        "</span></td><td>" +
        esc(e.startedBy) +
        (e.manager ? ' <span style="color:var(--muted)">(' + esc(e.manager) + ")</span>" : "") +
        "</td>" + (showFacing ? "<td>" + esc(e.versus) + "</td>" : "") +
        (showLineup ? "<td>" + (e.bench ? '<span class="tag benched">bench</span>'
                                        : '<span class="tag start">starting</span>') + "</td>" : "") +
        '<td class="num' + (mode === "pre" ? " isproj" : "") + '">' +
        (typeof v === "number" ? fmtPts(v) : '<span class="nopts">—</span>') + "</td></tr>";
    }).join("");
  return '<td class="details" colspan="' + cols + '"><div class="details-inner"><table class="sub">' +
    "<thead><tr><th>League</th><th>" + (showFacing ? "Your team" : "Opponent") + "</th>" +
    (showFacing ? "<th>Facing</th>" : "") + (showLineup ? "<th>Lineup</th>" : "") +
    '<th class="num">Pts</th></tr></thead><tbody>' +
    body + "</tbody></table></div></td>";
}

function rowHTML(r, side, cols){
  var key = side + ":" + r.id, open = !!state.open[key];
  var html = '<tr class="row' + (open ? " open" : "") + '" data-id="' + esc(r.id) + '">' +
    '<td class="name"><span class="caret">&#9656;</span> ' + esc(r.name) +
      (r.inj ? '<span class="inj">' + esc(r.inj) + "</span>" : "") +
      (isBoth(r) ? '<span class="both">both sides</span>' : "") + "</td>";
  if(!state.group) html += '<td class="poscol"><span class="pos">' + esc(r.pos) + "</span></td>";
  html += '<td><span class="tw">' + esc(r.team) + "</span></td>";

  var g = statusCell(r);
  html += '<td class="gs gs-' + g.cls + '">' +
    (g.main ? '<span class="gs-main">' + esc(g.main) + "</span>" : '<span class="nopts">—</span>') +
    (g.note ? ' <span class="gs-note">' + esc(g.note) + "</span>" : "") + "</td>";

  var p = ptsInfo(r, side);
  var tag = p.mode === "pre" ? '<span class="tag proj">proj</span>'
          : p.mode === "in" ? '<span class="tag live">live</span>'
          : p.mode === "bye" ? '<span class="tag bye">bye</span>' : "";
  if(p.val === null){
    html += '<td class="num pts"><span class="nopts">—</span>' +
      (tag ? '<span class="sub">' + tag + "</span>" : "") + "</td>";
  } else {
    html += '<td class="num pts"><span class="pv' + (p.mode === "pre" ? " isproj" : "") + '">' +
      fmtPts(p.val) + "</span>" +
      (tag ? '<span class="sub">' + tag + "</span>" : "") + "</td>";
  }

  var starts = countOf(r, side);
  html += '<td class="num"><span class="cnt' + (starts ? "" : " none") + '">' + starts + "</span></td>";
  if(state.rosterView && side === "for"){
    html += '<td class="num sharecol"><span class="shr">' + sharesOf(r, side) + "</span></td>";
  }
  html += "</tr>";
  if(open) html += '<tr class="detailrow">' + detailHTML(r, side, cols) + "</tr>";
  return html;
}

// Shares only differ from starts once the bench is in the list, so the tallies
// only carry them there.
function sharesNote(rows, side){
  if(!(state.rosterView && side === "for")) return "";
  var n = rows.reduce(function(t, r){ return t + sharesOf(r, side); }, 0);
  return " · " + n + " share" + (n === 1 ? "" : "s");
}

function renderSide(side){
  var rows = visibleRows(side);
  var cols = (state.group ? 5 : 6) + (state.rosterView && side === "for" ? 1 : 0);
  var tbody = el(side === "for" ? "tbodyFor" : "tbodyAgainst");
  var table = document.querySelector('table.grid[data-side="' + side + '"]');
  var html = [];

  table.classList.toggle("grouped", state.group);

  if(state.group){
    var groups = {}, order = [];
    rows.forEach(function(r){
      if(!groups[r.pos]){ groups[r.pos] = []; order.push(r.pos); }
      groups[r.pos].push(r);
    });
    order.sort(function(a, b){ return posRank(a) - posRank(b) || a.localeCompare(b); });
    order.forEach(function(p){
      var starts = groups[p].reduce(function(n, r){ return n + countOf(r, side); }, 0);
      html.push('<tr class="grp"><td colspan="' + cols + '">' + esc(p) +
        '<span class="gcount">' + groups[p].length + " player" + (groups[p].length === 1 ? "" : "s") +
        " · " + starts + " start" + (starts === 1 ? "" : "s") +
        sharesNote(groups[p], side) + "</span></td></tr>");
      groups[p].forEach(function(r){ html.push(rowHTML(r, side, cols)); });
    });
  } else {
    rows.forEach(function(r){ html.push(rowHTML(r, side, cols)); });
  }

  tbody.innerHTML = html.join("");
  el(side === "for" ? "emptyFor" : "emptyAgainst").hidden = rows.length > 0;

  var starts = rows.reduce(function(n, r){ return n + countOf(r, side); }, 0);
  el(side === "for" ? "forSub" : "againstSub").textContent =
    rows.length + " player" + (rows.length === 1 ? "" : "s") + " · " + starts +
    " start" + (starts === 1 ? "" : "s") + sharesNote(rows, side);

  // sort arrows
  var s = state.sort[side];
  Array.prototype.forEach.call(table.querySelectorAll("thead th"), function(th){
    var k = th.getAttribute("data-key");
    var base = th.textContent.replace(/[▲▼]\s*$/, "").trim();
    th.innerHTML = esc(base) + (k === s.key ?
      ' <span class="arrow">' + (s.dir === 1 ? "▲" : "▼") + "</span>" : "");
  });
}

function renderTables(){ renderSide("for"); renderSide("against"); }

/* ---------------- roster view ---------------- */

/* Hold R to trade the two tables for one full-width list of everyone you
   roster, bench included. Held rather than tapped so a stray R while you're
   reading can't flip the page out from under you, and guarded against firing
   while you're typing in the search box or the username field. */
var RV_HOLD = 500;
var rvTimer = null;

function typingIn(t){
  if(!t) return false;
  var tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!t.isContentEditable;
}

function renderRosterView(){
  var on = state.rosterView;
  document.querySelector(".panes").classList.toggle("roster", on);
  el("forTitle").textContent = on ? "My roster" : "For me";
  el("rvBadge").hidden = !on;
}

function setRosterView(on){
  if(state.rosterView === on) return;
  state.rosterView = on;
  renderRosterView();
  renderTables();
}

function cancelHold(){
  if(rvTimer){ clearTimeout(rvTimer); rvTimer = null; }
}

// The league a player's Pts come from: highest in the order that's still
// included. Leaving out the top league promotes the next one rather than
// silently pointing at a league that isn't in the tables.
function topIncluded(){
  for(var i = 0; i < state.leagueOrder.length; i++){
    if(included(state.leagueOrder[i])) return state.leagueOrder[i];
  }
  return null;
}

// One list does both jobs: the checkbox includes a league in the tables, the
// order sets which league's scoring the Pts column uses.
function renderLeagueFilter(){
  var lead = topIncluded();
  el("lfList").innerHTML = state.leagueOrder.map(function(id, i){
    var espn = id.indexOf("es:") === 0, on = included(id);
    return '<li draggable="true" data-id="' + esc(id) + '"' +
      (on ? "" : ' class="off"') + ">" +
      '<span class="grip" aria-hidden="true">⋮⋮</span>' +
      '<input type="checkbox" id="lfcb' + i + '" data-id="' + esc(id) + '"' +
        (on ? " checked" : "") + ">" +
      '<span class="rank">' + (i + 1) + "</span>" +
      '<label class="lname' + (id === lead ? " lead" : "") + '" for="lfcb' + i + '">' +
        esc(state.leagueNames[id] || id) +
        '<span class="plat ' + (espn ? "espn" : "sleeper") + '">' +
        (espn ? "ESPN" : "Sleeper") + "</span>" +
        (id === lead ? '<span class="scoring">scoring</span>' : "") +
      "</label>" +
      '<span class="moves">' +
        '<button type="button" class="mv" data-dir="-1" aria-label="Move up"' +
          (i === 0 ? " disabled" : "") + ">↑</button>" +
        '<button type="button" class="mv" data-dir="1" aria-label="Move down"' +
          (i === state.leagueOrder.length - 1 ? " disabled" : "") + ">↓</button>" +
      "</span></li>";
  }).join("");

  var on = state.leagueOrder.filter(included).length, all = state.leagueOrder.length;
  el("leagueToggle").textContent = "Leagues (" + on + "/" + all + ")";
  el("leagueToggle").classList.toggle("filtered", on !== all);
}

// Players starting on both sides, under the current league filter.
function renderBothToggle(){
  var n = 0;
  state.rows.forEach(function(r){ if(isBoth(r)) n++; });
  el("bothToggle").textContent = "Both sides only (" + n + ")";
}

// Both-sides count and league tallies follow the league filter, so they're
// recomputed together whenever it changes.
function refreshFiltered(){
  renderLeagueFilter();
  renderBothToggle();
  renderTables();
}

function setLeagueIncluded(id, on){
  if(on) delete state.excluded[id];
  else state.excluded[id] = true;
  refreshFiltered();
}

function moveLeague(id, delta){
  var from = state.leagueOrder.indexOf(id);
  var to = from + delta;
  if(from < 0 || to < 0 || to >= state.leagueOrder.length) return;
  state.leagueOrder.splice(to, 0, state.leagueOrder.splice(from, 1)[0]);
  rebuildOrderIndex(); saveOrder(); renderLeagueFilter(); renderTables();
}
function placeLeague(id, beforeId){
  if(id === beforeId) return;
  var order = state.leagueOrder.filter(function(x){ return x !== id; });
  var at = beforeId === null ? order.length : order.indexOf(beforeId);
  if(at < 0) at = order.length;
  order.splice(at, 0, id);
  state.leagueOrder = order;
  rebuildOrderIndex(); saveOrder(); renderLeagueFilter(); renderTables();
}

function renderEspnConfig(){
  var list = el("espnList");
  list.innerHTML = state.espnConfig.map(function(c){
    var teams = c.teams || [];
    var opts = ['<option value="">Pick your team…</option>'].concat(teams.map(function(t){
      return '<option value="' + t.id + '"' + (t.id === c.teamId ? " selected" : "") + ">" +
        esc(t.name) + (t.manager ? " — " + esc(t.manager) : "") + "</option>";
    })).join("");
    return '<li data-id="' + esc(c.id) + '">' +
      '<span class="el-name">' + esc(c.name || ("League " + c.id)) + "</span>" +
      (teams.length
        ? '<select class="el-team">' + opts + "</select>"
        : '<span class="el-warn">' + esc(c.error || "not loaded yet") + "</span>") +
      '<button type="button" class="el-rm" aria-label="Remove league">Remove</button></li>';
  }).join("");
  el("espnCount").textContent = state.espnConfig.length
    ? "(" + state.espnConfig.length + ")" : "";
  var missing = state.espnConfig.filter(function(c){ return !c.teamId; }).length;
  if(missing) el("espnBox").open = true;
}

function espnMsg(text, bad){
  var m = el("espnMsg");
  m.textContent = text || "";
  m.classList.toggle("bad", !!bad);
}

function addEspnLeague(id){
  id = String(id || "").trim().replace(/\D/g, "");
  if(!id){ espnMsg("Enter the numeric league ID.", true); return; }
  if(state.espnConfig.some(function(c){ return c.id === id; })){
    espnMsg("That league is already added.", true); return;
  }
  var season = state.season;
  espnMsg("Checking…");
  loadProTeams().then(function(){ return fetchEspnTeams(season, id); }).then(function(info){
    state.espnConfig.push({id:id, teamId:null, name:info.name, teams:info.teams});
    saveEspnConfig();
    renderEspnConfig();
    el("espnId").value = "";
    espnMsg("Added " + info.name + ". Now pick your team.");
  }).catch(function(err){
    espnMsg("Couldn't add it: " + (err.message || err), true);
  });
}

function renderUpdated(){
  var box = el("updated");
  if(!box) return;
  if(!state.updatedAt){ box.textContent = ""; return; }
  var d = new Date(state.updatedAt);
  var h = d.getHours(), m = d.getMinutes();
  var ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if(h === 0) h = 12;
  box.textContent = "updated " + h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
}

function renderAll(m){
  if(m) renderFooter(m);
  renderPosFilter();
  renderStatusFilter();
  renderLeagueFilter();
  renderBothToggle();
  renderTables();
  renderUpdated();
  results.classList.add("on");
}

// Re-pull only what changes during a game day. Leaves the player database,
// league list and rosters alone, and keeps sorting, filters and open rows.
function refreshScores(auto){
  if(state.refreshing || !state.ctx) return Promise.resolve();
  state.refreshing = true;
  var btn = el("refreshScores");
  if(btn){ btn.disabled = true; btn.textContent = "Refreshing…"; }

  return loadScores(true).then(function(m){
    state.rows = m.rows;
    state.meta = m;
    loadOrder(m.activeLeagues || []);
    renderAll(m);
    clearError();
  }).catch(function(err){
    if(!auto) showError(err && err.message ? err.message : String(err));
  }).then(function(){
    state.refreshing = false;
    if(btn){ btn.disabled = false; btn.textContent = "Refresh scores"; }
  });
}

function startAuto(){
  stopAuto();
  state.autoTimer = setInterval(function(){
    if(document.hidden) return;                 // don't poll a tab nobody is looking at
    if(!results.classList.contains("on")) return;
    refreshScores(true);
  }, AUTO_MS);
}
function stopAuto(){
  if(state.autoTimer){ clearInterval(state.autoTimer); state.autoTimer = null; }
}

/* ---------------- events ---------------- */

function wire(){
  document.querySelectorAll("table.grid").forEach(function(table){
    var side = table.getAttribute("data-side");
    table.querySelector("thead").addEventListener("click", function(e){
      var th = e.target.closest("th");
      if(!th) return;
      var k = th.getAttribute("data-key");
      if(!k) return;
      var s = state.sort[side];
      if(s.key === k) s.dir = -s.dir;
      else { s.key = k; s.dir = (k === "count" || k === "shares" || k === "pts") ? -1 : 1; }
      renderSide(side);
    });
    table.querySelector("tbody").addEventListener("click", function(e){
      var tr = e.target.closest("tr.row");
      if(!tr) return;
      var key = side + ":" + tr.getAttribute("data-id");
      state.open[key] = !state.open[key];
      renderSide(side);
    });
  });

  el("search").addEventListener("input", function(e){ state.search = e.target.value; renderTables(); });

  document.addEventListener("keydown", function(e){
    if(e.key !== "r" && e.key !== "R") return;
    // e.repeat fires for the whole hold, so only the first keydown starts a timer.
    if(e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if(rvTimer || typingIn(e.target) || !results.classList.contains("on")) return;
    rvTimer = setTimeout(function(){
      rvTimer = null;
      setRosterView(!state.rosterView);
    }, RV_HOLD);
  });
  document.addEventListener("keyup", function(e){
    // Releasing shift first turns "R" back into "r" mid-hold, so both count.
    if(e.key === "r" || e.key === "R") cancelHold();
  });
  window.addEventListener("blur", cancelHold);

  renderPosFilter = multiFilter({
    toggle:"posToggle", panel:"posFilter", list:"pfList", all:"pfAll", none:"pfNone",
    key:"posOff", title:"Positions", items:posList,
    // Position codes are short, so list them all rather than falling back to a count.
    chipText:function(on, items){
      return on.length === items.length ? "All Positions"
        : !on.length ? "No Positions"
        : on.join(", ");
    }
  });
  renderStatusFilter = multiFilter({
    toggle:"statusToggle", panel:"statusFilter", list:"gsList", all:"gsAll", none:"gsNone",
    key:"statusOff", title:"Status", maxNames:2, items:statusList,
    label:function(v){ return STATUS_LABEL[v]; }
  });

  el("groupToggle").addEventListener("click", function(){
    state.group = !state.group;
    this.classList.toggle("on", state.group);
    renderTables();
  });

  // Fold the load bar away once the tables are up. Always starts open, and the
  // choice isn't persisted, so a fresh visit never hides the form from you.
  el("setupToggle").addEventListener("click", function(){
    setSetupCollapsed(!el("setup").classList.contains("collapsed"));
  });

  el("leagueToggle").addEventListener("click", function(){
    var p = el("leagueFilter");
    p.hidden = !p.hidden;
    this.classList.toggle("open", !p.hidden);
  });
  el("lfList").addEventListener("change", function(e){
    var cb = e.target.closest("input[type=checkbox]");
    if(!cb) return;
    setLeagueIncluded(cb.getAttribute("data-id"), cb.checked);
  });
  el("lfAll").addEventListener("click", function(){
    state.excluded = {};
    refreshFiltered();
  });
  el("lfNone").addEventListener("click", function(){
    state.leagueOrder.forEach(function(id){ state.excluded[id] = true; });
    refreshFiltered();
  });

  var list = el("lfList"), dragId = null;
  list.addEventListener("click", function(e){
    var btn = e.target.closest("button.mv");
    if(!btn) return;
    moveLeague(btn.closest("li").getAttribute("data-id"), parseInt(btn.getAttribute("data-dir"), 10));
  });
  list.addEventListener("dragstart", function(e){
    var li = e.target.closest("li");
    if(!li) return;
    dragId = li.getAttribute("data-id");
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try{ e.dataTransfer.setData("text/plain", dragId); }catch(err){}
  });
  list.addEventListener("dragend", function(){
    dragId = null;
    Array.prototype.forEach.call(list.querySelectorAll("li"), function(li){
      li.classList.remove("dragging", "over");
    });
  });
  list.addEventListener("dragover", function(e){
    if(!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    var li = e.target.closest("li");
    Array.prototype.forEach.call(list.querySelectorAll("li"), function(x){ x.classList.remove("over"); });
    if(li && li.getAttribute("data-id") !== dragId) li.classList.add("over");
  });
  list.addEventListener("drop", function(e){
    if(!dragId) return;
    e.preventDefault();
    var li = e.target.closest("li");
    placeLeague(dragId, li ? li.getAttribute("data-id") : null);
    dragId = null;
  });

  el("bothToggle").addEventListener("click", function(){
    state.bothOnly = !state.bothOnly;
    this.classList.toggle("on", state.bothOnly);
    renderTables();
  });

  el("expandAll").addEventListener("click", function(){
    var all = visibleRows("for").map(function(r){ return "for:" + r.id; })
      .concat(visibleRows("against").map(function(r){ return "against:" + r.id; }));
    var anyClosed = all.some(function(k){ return !state.open[k]; });
    all.forEach(function(k){ state.open[k] = anyClosed; });
    this.textContent = anyClosed ? "Collapse all" : "Expand all";
    renderTables();
  });

  el("espnAdd").addEventListener("click", function(){ addEspnLeague(el("espnId").value); });
  el("espnId").addEventListener("keydown", function(e){
    if(e.key === "Enter"){ e.preventDefault(); addEspnLeague(this.value); }
  });
  el("espnList").addEventListener("change", function(e){
    var sel = e.target.closest("select.el-team");
    if(!sel) return;
    var id = sel.closest("li").getAttribute("data-id");
    state.espnConfig.forEach(function(c){
      if(c.id === id) c.teamId = sel.value ? parseInt(sel.value, 10) : null;
    });
    saveEspnConfig();
    espnMsg("Saved. Reload matchups to apply.");
  });
  el("espnList").addEventListener("click", function(e){
    if(!e.target.closest("button.el-rm")) return;
    var id = e.target.closest("li").getAttribute("data-id");
    state.espnConfig = state.espnConfig.filter(function(c){ return c.id !== id; });
    saveEspnConfig();
    renderEspnConfig();
    espnMsg("Removed.");
  });

  el("refreshScores").addEventListener("click", function(){ refreshScores(false); });

  // catch up immediately when the tab comes back rather than waiting out the interval
  document.addEventListener("visibilitychange", function(){
    if(document.hidden || !results.classList.contains("on")) return;
    if(state.updatedAt && Date.now() - state.updatedAt > AUTO_MS) refreshScores(true);
  });

  el("refresh").addEventListener("click", function(){
    try{ localStorage.removeItem(PKEY); localStorage.removeItem(PTS); }catch(e){}
    state.players = null;
    setStatus("Player database cleared. It re-downloads on your next lookup.", 100);
    setTimeout(clearStatus, 2500);
  });

  el("form").addEventListener("submit", function(e){
    e.preventDefault();
    var username = el("username").value.trim();
    var season = state.season;
    var week = parseInt(el("week").value, 10);
    if(!username && !state.espnConfig.length){
      showError("Enter a Sleeper username, or add an ESPN league below.");
      return;
    }
    if(!week){ showError("Enter a week."); return; }

    clearError();
    el("leagueFilter").hidden = true;
    el("leagueToggle").classList.remove("open");
    el("posFilter").hidden = true;
    el("posToggle").classList.remove("open");
    el("statusFilter").hidden = true;
    el("statusToggle").classList.remove("open");
    results.classList.remove("on");
    el("go").disabled = true;
    state.open = {};
    state.excluded = {};
    state.posOff = {};
    state.statusOff = {};

    try{ localStorage.setItem("sleeper_last_user", username); }catch(err){}

    loadPlayers()
      .then(function(){ return run(username, season, week); })
      .then(function(m){
        state.rows = m.rows;
        state.meta = m;
        loadOrder(m.activeLeagues || []);
        state.sort = { "for": {key:"count", dir:-1}, "against": {key:"count", dir:-1} };
        renderEspnConfig();
        clearStatus();
        if(!m.rows.length){
          stopAuto();
          showError("No starters found for week " + week + ".");
        } else {
          renderAll(m);
          startAuto();
        }
      })
      .catch(function(err){
        clearStatus();
        showError(err && err.message ? err.message : String(err));
      })
      .then(function(){ el("go").disabled = false; });
  });
}

/* ---------------- boot ---------------- */

function init(){
  statusBox = el("status"); statusText = el("statusText"); bar = el("bar");
  errBox = el("error"); results = el("results");
  loadEspnConfig();
  wire();
  renderEspnConfig();

  try{
    var last = localStorage.getItem("sleeper_last_user");
    if(last) el("username").value = last;
  }catch(e){}

  // Before March the NFL season is still the previous calendar year. This is
  // only a fallback: /state/nfl is authoritative and overwrites it below.
  var now = new Date();
  state.season = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;
  el("week").value = 1;

  getJSON(API + "/state/nfl").then(function(s){
    if(!s) return;
    if(s.league_season || s.season) state.season = parseInt(s.league_season || s.season, 10);
    var w = s.display_week || s.week || s.leg || 1;
    el("week").value = Math.max(1, Math.min(22, w));
    if(s.season_type) state.seasonType = s.season_type;
  }).catch(function(){ /* keep the calendar-based fallback */ });
}

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

})();
