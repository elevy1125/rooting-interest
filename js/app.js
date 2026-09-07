/* Sleeper Matchup Tracker
   Pulls your week's matchups across every Sleeper league you're in and shows,
   side by side, which players are starting for you and which are starting
   against you. Pure client-side: the Sleeper API is public and read-only.
*/
(function(){
"use strict";

var API = "https://api.sleeper.app/v1";
var PKEY = "sleeper_players_slim_v2", PTS = "sleeper_players_ts_v2";
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
  pos: null,
  search: "",
  open: {},               // "side:playerId" -> bool
  leagueOrder: [],        // league ids, highest scoring priority first
  orderIndex: {},         // league id -> position in leagueOrder
  leagueNames: {},
  ctx: null,              // user, leagues, rosters/managers — reused across refreshes
  scoring: {},            // league id -> scoring_settings
  gameState: {},          // NFL team -> pre | in | post
  projStats: {},          // player id -> projected raw stats
  projMemo: {},           // "playerId|leagueId" -> projected points
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
function showError(msg){ errBox.textContent = msg; errBox.classList.add("on"); }
function clearError(){ errBox.classList.remove("on"); errBox.textContent = ""; }
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

function getJSON(url){
  return fetch(url, {cache:"no-store"}).catch(function(){
    throw new Error("Couldn't reach the Sleeper API. Check your connection — and if you opened this " +
      "file directly from disk and it keeps failing, serve the folder instead (in Terminal: cd to the " +
      "folder, run `python3 -m http.server 8000`, then open http://localhost:8000).");
  }).then(function(r){
    if(r.status === 404) return null;
    if(!r.ok) throw new Error("Sleeper API returned " + r.status + " for " + url);
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

function loadPlayers(){
  if(state.players) return Promise.resolve(state.players);
  var cached = readCache();
  if(cached){ state.players = cached; return Promise.resolve(cached); }
  setStatus("Downloading the NFL player database (~5 MB, cached for 24 hours)…", 5);
  return getJSON(API + "/players/nfl").then(function(all){
    if(!all) throw new Error("Could not load the NFL player database.");
    var slim = {}, id, p, name;
    for(id in all){
      p = all[id];
      if(!p) continue;
      name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id;
      slim[id] = [name, p.position || (p.fantasy_positions && p.fantasy_positions[0]) || "",
                  p.team || "", p.injury_status || ""];
    }
    writeCache(slim);
    state.players = slim;
    return slim;
  });
}

function playerInfo(id){
  var p = state.players && state.players[id];
  if(p) return {name:p[0], pos:p[1] || "?", team:p[2] || "FA", inj:p[3] || ""};
  return {name:"Player " + id, pos:"?", team:"", inj:""};
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

/* ---------------- game state + projections ---------------- */

// ESPN spells a few teams differently than Sleeper does.
var TEAM_ALIAS = {WSH:"WAS", LA:"LAR", JAC:"JAX", ARZ:"ARI", BLT:"BAL", CLV:"CLE",
                  HST:"HOU", SD:"LAC", OAK:"LV", STL:"LAR"};
function normTeam(t){
  if(!t) return "";
  t = String(t).toUpperCase();
  return TEAM_ALIAS[t] || t;
}

// Which NFL teams have played, are playing, or haven't kicked off yet.
// Sleeper has no game-state endpoint; ESPN's public scoreboard does and is CORS-open.
function fetchGameStates(season, week, seasonType){
  var st = seasonType === "post" ? 3 : (seasonType === "pre" ? 1 : 2);
  var url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard" +
    "?week=" + week + "&seasontype=" + st + "&dates=" + season;
  return getJSON(url).then(function(j){
    var map = {};
    (j && j.events || []).forEach(function(ev){
      var s = ev.status && ev.status.type ? ev.status.type.state : null;   // pre | in | post
      var comps = (ev.competitions && ev.competitions[0] && ev.competitions[0].competitors) || [];
      comps.forEach(function(c){
        if(c.team && c.team.abbreviation) map[normTeam(c.team.abbreviation)] = s;
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
        if(row && row.player_id && row.stats) map[row.player_id] = row.stats;
      });
      return map;
    }).catch(function(){ return {}; });
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

// pre = not kicked off (show projection), in = playing, post = done, bye = no game
function gameMode(row){
  var t = normTeam(row.team);
  if(!t || t === "FA") return "none";
  var s = state.gameState[t];
  if(s === "pre") return "pre";
  if(s === "in") return "in";
  if(s === "post") return "post";
  return Object.keys(state.gameState).length ? "bye" : "none";
}

/* ---------------- fetch + aggregate ---------------- */

// Everything that doesn't change during a game day: the user, their leagues
// (including scoring_settings) and each league's rosters and managers.
function loadContext(username, season, week){
  var user, leagues;
  return getJSON(API + "/user/" + encodeURIComponent(username)).then(function(u){
    if(!u || !u.user_id) throw new Error('No Sleeper user found named "' + username + '".');
    user = u;
    setStatus("Finding " + (u.display_name || username) + "'s " + season + " leagues…", 12);
    return getJSON(API + "/user/" + u.user_id + "/leagues/nfl/" + season);
  }).then(function(ls){
    leagues = ls || [];
    if(!leagues.length) throw new Error("That account has no NFL leagues for " + season + ".");
    setStatus("Loading " + leagues.length + " leagues…", 18);
    return pool(leagues, 5, function(lg){
      return Promise.all([
        getJSON(API + "/league/" + lg.league_id + "/rosters"),
        getJSON(API + "/league/" + lg.league_id + "/users")
      ]).then(function(res){ return {rosters:res[0] || [], users:res[1] || []}; });
    }, function(done, total){
      setStatus("Loading leagues… " + done + " of " + total, 18 + Math.round((done / total) * 50));
    });
  }).then(function(perLeague){
    var data = {};
    state.scoring = {};
    leagues.forEach(function(lg, i){
      data[lg.league_id] = perLeague[i];
      state.scoring[lg.league_id] = lg.scoring_settings || null;
    });
    state.ctx = {user:user, season:season, week:week, leagues:leagues, leagueData:data};
    return state.ctx;
  });
}

// Everything that does change: matchups (live points), game states, projections.
function loadScores(quiet){
  var ctx = state.ctx;
  if(!ctx) return Promise.reject(new Error("Nothing loaded yet."));
  if(!quiet) setStatus("Loading matchups…", 70);

  return pool(ctx.leagues, 5, function(lg){
    return getJSON(API + "/league/" + lg.league_id + "/matchups/" + ctx.week)
      .then(function(m){ return m || []; });
  }).then(function(matchups){
    var byLeague = {};
    ctx.leagues.forEach(function(lg, i){ byLeague[lg.league_id] = matchups[i]; });

    // which positions are actually in these lineups, so we don't pull every projection
    var positions = {};
    ctx.leagues.forEach(function(lg){
      (byLeague[lg.league_id] || []).forEach(function(m){
        (m.starters || []).forEach(function(pid){
          if(pid && pid !== "0"){
            var info = playerInfo(pid);
            if(info.pos && info.pos !== "?") positions[info.pos] = true;
          }
        });
      });
    });

    if(!quiet) setStatus("Loading scores and projections…", 88);
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
  var ctx = state.ctx, userId = ctx.user.user_id, week = ctx.week;
  var skipped = [], leagues = ctx.leagues;
  {
    var byPlayer = {}, counted = 0, active = [];

    function add(pid, side, c){
      if(!pid || pid === "0") return;
      var row = byPlayer[pid];
      if(!row){
        var info = playerInfo(pid);
        row = byPlayer[pid] = {
          id:pid, name:info.name, pos:info.pos, team:info.team, inj:info.inj,
          forCount:0, againstCount:0, total:0, net:0, entries:[]
        };
      }
      if(side === "for") row.forCount++; else row.againstCount++;
      row.total = row.forCount + row.againstCount;
      row.net = row.forCount - row.againstCount;
      var pts = c.points && Object.prototype.hasOwnProperty.call(c.points, pid)
        ? Number(c.points[pid]) : null;
      row.entries.push({
        league: c.league, leagueId: c.leagueId, side: side,
        startedBy: side === "for" ? c.myTeam : c.oppTeam,
        versus:    side === "for" ? c.oppTeam : c.myTeam,
        manager:   side === "for" ? c.myManager : c.oppManager,
        points: (pts === null || isNaN(pts)) ? null : pts
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
      if(!mine){ skipped.push({league:name, reason:"no roster in this league"}); return; }

      var myM = null, i;
      for(i = 0; i < b.matchups.length; i++){
        if(b.matchups[i].roster_id === mine.roster_id){ myM = b.matchups[i]; break; }
      }
      if(!myM){ skipped.push({league:name, reason:"no matchup posted"}); return; }

      var opps = b.matchups.filter(function(m){
        return m.matchup_id != null && m.matchup_id === myM.matchup_id && m.roster_id !== mine.roster_id;
      });

      var myTeam = teamNameFor(mine, usersById);
      var myManager = (usersById[mine.owner_id] || {}).display_name || "";
      var myStarters = (myM.starters || []).filter(function(p){ return p && p !== "0"; });
      if(!myStarters.length){ skipped.push({league:name, reason:"lineup not set"}); return; }

      if(!opps.length) skipped.push({league:name, reason:"no opponent scheduled", partial:true});
      counted++;

      var oppRoster = opps.length ? rostersById[opps[0].roster_id] : null;
      var oppTeam = opps.length ? teamNameFor(oppRoster, usersById) : "— no opponent —";
      var oppManager = oppRoster ? ((usersById[oppRoster.owner_id] || {}).display_name || "") : "";

      active.push({id:lg.league_id, name:name});

      myStarters.forEach(function(pid){
        add(pid, "for", {league:name, leagueId:lg.league_id, myTeam:myTeam, oppTeam:oppTeam,
          myManager:myManager, oppManager:oppManager, points: myM.players_points});
      });

      opps.forEach(function(om){
        var r = rostersById[om.roster_id];
        var c = {
          league:name, leagueId:lg.league_id, myTeam:myTeam, oppTeam:teamNameFor(r, usersById),
          myManager:myManager,
          oppManager: r ? ((usersById[r.owner_id] || {}).display_name || "") : "",
          points: om.players_points
        };
        (om.starters || []).forEach(function(pid){ add(pid, "against", c); });
      });
    });

    return {
      user: ctx.user,
      rows: Object.keys(byPlayer).map(function(k){ return byPlayer[k]; }),
      skipped:skipped, leaguesTotal:leagues.length, leaguesCounted:counted,
      activeLeagues:active, season:ctx.season, week:week
    };
  }
}

/* ---------------- rendering ---------------- */

function countOf(row, side){ return side === "for" ? row.forCount : row.againstCount; }
function isBoth(row){ return row.forCount > 0 && row.againstCount > 0; }

// The value shown for one player in one league: actual points once his game has
// started, the league-scored projection before that.
function shownValue(row, entry, mode){
  if(mode === "pre") return projFor(row.id, entry.leagueId);
  return typeof entry.points === "number" ? entry.points : null;
}

// Points for one player on one side. Leagues can score the same player
// differently, so we show the highest-priority league he appears in, plus the
// spread across the rest.
function ptsInfo(row, side){
  var mode = gameMode(row);
  var best = null, bestRank = Infinity, bestVal = null, vals = [];
  row.entries.forEach(function(e){
    if(e.side !== side) return;
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

function prioKey(){ return "sleeper_prio_" + (state.meta && state.meta.user ? state.meta.user.user_id : "x"); }

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

function renderSummary(m){
  var both = 0;
  state.rows.forEach(function(r){ if(isBoth(r)) both++; });
  var flagged = m.skipped || [];
  var caption = flagged.length
    ? '<em class="statnote" id="statnote">+' + flagged.length +
      " without a matchup</em>"
    : "";

  var stats = [
    ["Week", esc(m.week), ""],
    ["Leagues", esc(m.leaguesCounted), caption],
    ["Unique players", esc(state.rows.length), ""],
    ["On both sides", esc(both), ""]
  ];
  el("summary").innerHTML = stats.map(function(s){
    return '<div class="stat"><span>' + esc(s[0]) + "</span><b>" + s[1] + "</b>" + s[2] + "</div>";
  }).join("");

  var box = el("skipped");
  if(flagged.length){
    box.innerHTML = "No matchup this week: " + flagged.map(function(s){
      return '<span class="sk">' + esc(s.league) +
        (s.reason === "no matchup posted" ? "" : " (" + esc(s.reason) + ")") + "</span>";
    }).join(", ");
    box.hidden = true;
    var note = el("statnote");
    note.addEventListener("click", function(){
      box.hidden = !box.hidden;
      note.classList.toggle("open", !box.hidden);
    });
  } else {
    box.innerHTML = "";
    box.hidden = true;
  }

  el("foot").textContent = (m.user.display_name || m.user.username) + " · " + m.season +
    " season · data from the Sleeper API";
}

function renderPosChips(){
  var seen = {};
  state.rows.forEach(function(r){ seen[r.pos] = true; });
  var list = Object.keys(seen).sort(function(a, b){
    return posRank(a) - posRank(b) || a.localeCompare(b);
  });
  el("posChips").innerHTML =
    '<span class="chip' + (state.pos ? "" : " on") + '" data-pos="">All pos</span>' +
    list.map(function(p){
      return '<span class="chip' + (state.pos === p ? " on" : "") + '" data-pos="' + esc(p) + '">' +
        esc(p) + "</span>";
    }).join("");
}

function visibleRows(side){
  var q = state.search.trim().toLowerCase();
  var s = state.sort[side];
  return state.rows.filter(function(r){
    if(countOf(r, side) === 0) return false;
    if(state.bothOnly && !isBoth(r)) return false;
    if(state.pos && r.pos !== state.pos) return false;
    if(q){
      var hay = (r.name + " " + r.pos + " " + r.team + " " + r.entries.filter(function(e){
        return e.side === side;
      }).map(function(e){ return e.league + " " + e.startedBy + " " + e.versus; }).join(" ")).toLowerCase();
      if(hay.indexOf(q) === -1) return false;
    }
    return true;
  }).sort(function(a, b){
    var c;
    if(s.key === "count") c = countOf(a, side) - countOf(b, side);
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
  var top = state.leagueOrder[0];
  var mode = gameMode(row);
  var body = row.entries.filter(function(e){ return e.side === side; })
    .sort(function(a, b){
      var ra = state.orderIndex[a.leagueId], rb = state.orderIndex[b.leagueId];
      return (ra === undefined ? 9999 : ra) - (rb === undefined ? 9999 : rb);
    })
    .map(function(e){
      var used = e.leagueId === top;
      var v = shownValue(row, e, mode);
      return '<tr' + (used ? ' class="lead"' : "") + "><td>" + esc(e.league) + "</td><td>" +
        esc(e.startedBy) +
        (e.manager ? ' <span style="color:var(--muted)">(' + esc(e.manager) + ")</span>" : "") +
        "</td>" + (showFacing ? "<td>" + esc(e.versus) + "</td>" : "") +
        '<td class="num' + (mode === "pre" ? " isproj" : "") + '">' +
        (typeof v === "number" ? fmtPts(v) : '<span class="nopts">—</span>') + "</td></tr>";
    }).join("");
  return '<td class="details" colspan="' + cols + '"><div class="details-inner"><table class="sub">' +
    "<thead><tr><th>League</th><th>" + (showFacing ? "Your team" : "Opponent") + "</th>" +
    (showFacing ? "<th>Facing</th>" : "") + '<th class="num">Pts</th></tr></thead><tbody>' +
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

  html += '<td class="num"><span class="cnt">' + countOf(r, side) + "</span></td></tr>";
  if(open) html += '<tr class="detailrow">' + detailHTML(r, side, cols) + "</tr>";
  return html;
}

function renderSide(side){
  var rows = visibleRows(side);
  var cols = state.group ? 4 : 5;
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
        " · " + starts + " start" + (starts === 1 ? "" : "s") + "</span></td></tr>");
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
    " start" + (starts === 1 ? "" : "s");

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

function renderPrio(){
  var list = el("prioList");
  list.innerHTML = state.leagueOrder.map(function(id, i){
    return '<li draggable="true" data-id="' + esc(id) + '">' +
      '<span class="grip" aria-hidden="true">⋮⋮</span>' +
      '<span class="rank">' + (i + 1) + "</span>" +
      '<span class="lname">' + esc(state.leagueNames[id] || id) + "</span>" +
      '<span class="moves">' +
        '<button type="button" class="mv" data-dir="-1" aria-label="Move up"' +
          (i === 0 ? " disabled" : "") + ">↑</button>" +
        '<button type="button" class="mv" data-dir="1" aria-label="Move down"' +
          (i === state.leagueOrder.length - 1 ? " disabled" : "") + ">↓</button>" +
      "</span></li>";
  }).join("");
  el("prioToggle").textContent = "Scoring: " +
    (state.leagueNames[state.leagueOrder[0]] || "priority");
}

function moveLeague(id, delta){
  var from = state.leagueOrder.indexOf(id);
  var to = from + delta;
  if(from < 0 || to < 0 || to >= state.leagueOrder.length) return;
  state.leagueOrder.splice(to, 0, state.leagueOrder.splice(from, 1)[0]);
  rebuildOrderIndex(); saveOrder(); renderPrio(); renderTables();
}
function placeLeague(id, beforeId){
  if(id === beforeId) return;
  var order = state.leagueOrder.filter(function(x){ return x !== id; });
  var at = beforeId === null ? order.length : order.indexOf(beforeId);
  if(at < 0) at = order.length;
  order.splice(at, 0, id);
  state.leagueOrder = order;
  rebuildOrderIndex(); saveOrder(); renderPrio(); renderTables();
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
  if(m) renderSummary(m);
  renderPosChips();
  renderPrio();
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
      else { s.key = k; s.dir = (k === "count") ? -1 : 1; }
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

  el("posChips").addEventListener("click", function(e){
    var chip = e.target.closest(".chip");
    if(!chip) return;
    state.pos = chip.getAttribute("data-pos") || null;
    renderPosChips(); renderTables();
  });

  el("groupToggle").addEventListener("click", function(){
    state.group = !state.group;
    this.classList.toggle("on", state.group);
    renderTables();
  });

  el("prioToggle").addEventListener("click", function(){
    var p = el("prio");
    p.hidden = !p.hidden;
    this.classList.toggle("on", !p.hidden);
  });

  var list = el("prioList"), dragId = null;
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

  el("csv").addEventListener("click", function(){
    var STATUS = {pre:"projected", "in":"live", post:"final", bye:"bye", none:""};
    var lines = [["Side", "Player", "Pos", "NFL", "Starts", "Status", "Priority pts", "League",
      "Started by", "Facing", "League pts"]];
    ["for", "against"].forEach(function(side){
      visibleRows(side).forEach(function(r){
        var p = ptsInfo(r, side), mode = p.mode;
        r.entries.filter(function(e){ return e.side === side; }).forEach(function(e){
          var v = shownValue(r, e, mode);
          lines.push([side === "for" ? "For me" : "Against me", r.name, r.pos, r.team,
            countOf(r, side), STATUS[mode] || "", p.val === null ? "" : fmtPts(p.val),
            e.league, e.startedBy, e.versus, typeof v === "number" ? fmtPts(v) : ""]);
        });
      });
    });
    var csv = lines.map(function(row){
      return row.map(function(c){
        c = String(c == null ? "" : c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(",");
    }).join("\n");
    var url = URL.createObjectURL(new Blob([csv], {type:"text/csv"}));
    var a = document.createElement("a");
    a.href = url;
    a.download = "sleeper-week" + (state.meta ? state.meta.week : "") + "-exposure.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
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
    setStatus("Player database cleared — it will re-download on your next lookup.", 100);
    setTimeout(clearStatus, 2500);
  });

  el("form").addEventListener("submit", function(e){
    e.preventDefault();
    var username = el("username").value.trim();
    var season = parseInt(el("season").value, 10);
    var week = parseInt(el("week").value, 10);
    if(!username) return;
    if(!season || !week){ showError("Enter a season and a week."); return; }

    clearError();
    el("skipped").hidden = true;
    el("prio").hidden = true;
    el("prioToggle").classList.remove("on");
    results.classList.remove("on");
    el("go").disabled = true;
    state.open = {};

    try{ localStorage.setItem("sleeper_last_user", username); }catch(err){}

    loadPlayers()
      .then(function(){ return run(username, season, week); })
      .then(function(m){
        state.rows = m.rows;
        state.meta = m;
        loadOrder(m.activeLeagues || []);
        state.sort = { "for": {key:"count", dir:-1}, "against": {key:"count", dir:-1} };
        clearStatus();
        if(!m.rows.length){
          stopAuto();
          showError("No starters found for week " + week + " in any of your leagues.");
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
  wire();

  try{
    var last = localStorage.getItem("sleeper_last_user");
    if(last) el("username").value = last;
  }catch(e){}

  var now = new Date();
  el("season").value = now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;
  el("week").value = 1;

  getJSON(API + "/state/nfl").then(function(s){
    if(!s) return;
    if(s.league_season || s.season) el("season").value = s.league_season || s.season;
    var w = s.display_week || s.week || s.leg || 1;
    el("week").value = Math.max(1, Math.min(22, w));
    if(s.season_type) state.seasonType = s.season_type;
  }).catch(function(){ /* keep calendar-based defaults */ });
}

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

})();
