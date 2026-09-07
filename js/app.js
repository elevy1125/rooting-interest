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
  open: {}                // "side:playerId" -> bool
};

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

function run(username, season, week){
  var skipped = [], userId, user, leagues;

  return getJSON(API + "/user/" + encodeURIComponent(username)).then(function(u){
    if(!u || !u.user_id) throw new Error('No Sleeper user found named "' + username + '".');
    user = u; userId = u.user_id;
    setStatus("Finding " + (u.display_name || username) + "'s " + season + " leagues…", 12);
    return getJSON(API + "/user/" + userId + "/leagues/nfl/" + season);
  }).then(function(ls){
    leagues = ls || [];
    if(!leagues.length) throw new Error("That account has no NFL leagues for " + season + ".");
    setStatus("Loading " + leagues.length + " leagues…", 18);

    return pool(leagues, 5, function(lg){
      return Promise.all([
        getJSON(API + "/league/" + lg.league_id + "/rosters"),
        getJSON(API + "/league/" + lg.league_id + "/users"),
        getJSON(API + "/league/" + lg.league_id + "/matchups/" + week)
      ]).then(function(res){
        return {league:lg, rosters:res[0] || [], users:res[1] || [], matchups:res[2] || []};
      });
    }, function(done, total){
      setStatus("Loading leagues… " + done + " of " + total, 18 + Math.round((done / total) * 74));
    });
  }).then(function(bundles){
    setStatus("Crunching lineups…", 96);

    var byPlayer = {}, counted = 0;

    function add(pid, side, ctx){
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
      row.entries.push({
        league: ctx.league, side: side,
        startedBy: side === "for" ? ctx.myTeam : ctx.oppTeam,
        versus:    side === "for" ? ctx.oppTeam : ctx.myTeam,
        manager:   side === "for" ? ctx.myManager : ctx.oppManager
      });
    }

    bundles.forEach(function(b){
      var lg = b.league, name = lg.name || ("League " + lg.league_id);
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

      myStarters.forEach(function(pid){
        add(pid, "for", {league:name, myTeam:myTeam, oppTeam:oppTeam, myManager:myManager, oppManager:oppManager});
      });

      opps.forEach(function(om){
        var r = rostersById[om.roster_id];
        var ctx = {
          league:name, myTeam:myTeam, oppTeam:teamNameFor(r, usersById), myManager:myManager,
          oppManager: r ? ((usersById[r.owner_id] || {}).display_name || "") : ""
        };
        (om.starters || []).forEach(function(pid){ add(pid, "against", ctx); });
      });
    });

    return {
      user:user,
      rows: Object.keys(byPlayer).map(function(k){ return byPlayer[k]; }),
      skipped:skipped, leaguesTotal:leagues.length, leaguesCounted:counted,
      season:season, week:week
    };
  });
}

/* ---------------- rendering ---------------- */

function countOf(row, side){ return side === "for" ? row.forCount : row.againstCount; }
function isBoth(row){ return row.forCount > 0 && row.againstCount > 0; }

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
  var body = row.entries.filter(function(e){ return e.side === side; })
    .sort(function(a, b){ return a.league.localeCompare(b.league); })
    .map(function(e){
      return "<tr><td>" + esc(e.league) + "</td><td>" + esc(e.startedBy) +
        (e.manager ? ' <span style="color:var(--muted)">(' + esc(e.manager) + ")</span>" : "") +
        "</td>" + (showFacing ? "<td>" + esc(e.versus) + "</td>" : "") + "</tr>";
    }).join("");
  return '<td class="details" colspan="' + cols + '"><div class="details-inner"><table class="sub">' +
    "<thead><tr><th>League</th><th>" + (showFacing ? "Your team" : "Opponent") + "</th>" +
    (showFacing ? "<th>Facing</th>" : "") + "</tr></thead><tbody>" + body + "</tbody></table></div></td>";
}

function rowHTML(r, side, cols){
  var key = side + ":" + r.id, open = !!state.open[key];
  var html = '<tr class="row' + (open ? " open" : "") + '" data-id="' + esc(r.id) + '">' +
    '<td class="name"><span class="caret">&#9656;</span> ' + esc(r.name) +
      (r.inj ? '<span class="inj">' + esc(r.inj) + "</span>" : "") +
      (isBoth(r) ? '<span class="both">both sides</span>' : "") + "</td>";
  if(!state.group) html += '<td class="poscol"><span class="pos">' + esc(r.pos) + "</span></td>";
  html += '<td><span class="tw">' + esc(r.team) + "</span></td>" +
    '<td class="num"><span class="cnt">' + countOf(r, side) + "</span></td></tr>";
  if(open) html += '<tr class="detailrow">' + detailHTML(r, side, cols) + "</tr>";
  return html;
}

function renderSide(side){
  var rows = visibleRows(side);
  var cols = state.group ? 3 : 4;
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

function renderAll(m){
  if(m) renderSummary(m);
  renderPosChips();
  renderTables();
  results.classList.add("on");
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
    var lines = [["Side", "Player", "Pos", "NFL", "Starts", "League", "Started by", "Facing"]];
    ["for", "against"].forEach(function(side){
      visibleRows(side).forEach(function(r){
        r.entries.filter(function(e){ return e.side === side; }).forEach(function(e){
          lines.push([side === "for" ? "For me" : "Against me", r.name, r.pos, r.team,
            countOf(r, side), e.league, e.startedBy, e.versus]);
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
    results.classList.remove("on");
    el("go").disabled = true;
    state.open = {};

    try{ localStorage.setItem("sleeper_last_user", username); }catch(err){}

    loadPlayers()
      .then(function(){ return run(username, season, week); })
      .then(function(m){
        state.rows = m.rows;
        state.meta = m;
        state.sort = { "for": {key:"count", dir:-1}, "against": {key:"count", dir:-1} };
        clearStatus();
        if(!m.rows.length) showError("No starters found for week " + week + " in any of your leagues.");
        else renderAll(m);
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
  }).catch(function(){ /* keep calendar-based defaults */ });
}

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

})();
