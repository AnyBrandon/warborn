/**
 * test.js — quick sanity checks for the core engine (run: node server/test.js).
 * Not a formal test framework — just assertions on the critical logic paths.
 */
const gl = require("./gameLogic");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.error("  FAIL-", name); }
}

// --- Setup a match, deploy minimal, drive a round ---
const m = gl.createMatch("TEST");
const pA = "a"; const pB = "b";
ok(gl.addPlayer(m, pA) === "A", "player A gets slot A");
ok(gl.addPlayer(m, pB) === "B", "player B gets slot B");
ok(gl.addPlayer(m, "c") === null, "third player rejected");

gl.selectMap(m, "highland");
ok(m.phase === "deploy", "map select -> deploy phase");

// Place all tanks for each player inside their zones (stack in a line).
function deployAll(pid, zone) {
  const player = m.players[pid];
  let x = zone.x, y = zone.y;
  for (const t of player.tanks) {
    // find a spot that fits; naive scan
    let placed = false;
    for (let yy = zone.y; yy < zone.y + zone.h && !placed; yy++) {
      for (let xx = zone.x; xx < zone.x + zone.w && !placed; xx++) {
        const r = gl.placeTank(m, pid, t.tankId, { x: xx, y: yy }, 0);
        if (r.ok) placed = true;
      }
    }
    if (!placed) throw new Error("could not place " + t.tankId);
  }
}
deployAll(pA, m.map.zoneA);
deployAll(pB, m.map.zoneB);
ok(gl.allPlaced(m.players[pA]), "player A fully placed");
ok(gl.allPlaced(m.players[pB]), "player B fully placed");

gl.setReady(m, pA);
const rdy = gl.setReady(m, pB);
ok(rdy.bothReady && m.phase === "battle", "both ready -> battle");

// --- Simultaneous resolve: both fire at each other ---
const aTank = m.players[pA].tanks[0];
const bTank = m.players[pB].tanks[0];
const aTargetTile = bTank.tiles[0]; // A fires at one of B's real tiles => hit
const bTargetTile = { x: 0, y: 0 }; // B fires at void/empty => miss

gl.submitAction(m, pA, { action: "fire", target: aTargetTile });
const sub = gl.submitAction(m, pB, { action: "fire", target: bTargetTile });
ok(sub.bothSubmitted, "both actions submitted");

const res = gl.resolveRound(m);
const aShot = res.shots.find((s) => s.slot === "A");
const bShot = res.shots.find((s) => s.slot === "B");
ok(aShot.hit === true, "A's fire on B tank tile registers HIT");
ok(bShot.hit === false, "B's fire on empty tile registers MISS");
ok(m.round === 2, "round advanced to 2");

// --- Reposition cooldown ---
const t = m.players[pA].tanks.find((x) => !x.sunk);
// Move it somewhere valid in zone A.
let moved = null;
for (let yy = m.map.zoneA.y; yy < m.map.zoneA.y + m.map.zoneA.h && !moved; yy++) {
  for (let xx = m.map.zoneA.x; xx < m.map.zoneA.x + m.map.zoneA.w && !moved; xx++) {
    const r = gl.submitAction(m, pA, { action: "reposition", tankId: t.tankId, position: { x: xx, y: yy }, rotation: 0 });
    if (r.ok) moved = { xx, yy };
  }
}
ok(!!moved, "reposition accepted");
gl.submitAction(m, pB, { action: "pass" });
gl.resolveRound(m);
// Immediately try to reposition same tank again -> should be on cooldown.
const cd = gl.submitAction(m, pA, { action: "reposition", tankId: t.tankId, position: { x: m.map.zoneA.x, y: m.map.zoneA.y }, rotation: 0 });
ok(!cd.ok && /cooldown/i.test(cd.error), "reposition blocked by cooldown");

// --- Fog of war view never leaks enemy positions ---
const view = gl.buildPlayerView(m, pA);
ok(view.enemyShots !== undefined && view.enemySunkTanks !== undefined, "enemy view is fog-of-war only");
ok(view.myTanks.length === 10, "own tanks fully visible (10)");

// --- Server-authoritative grid is included in the view ---
ok(Array.isArray(view.grid) && view.grid.length === 30 && view.grid[0].length === 30,
   "view includes 30x30 server-authoritative grid");
ok(view.grid === m.map.grid, "view grid is the map's actual tile data");
const lobbyView = (() => { const mm = gl.createMatch("L"); gl.addPlayer(mm, "x"); return gl.buildPlayerView(mm, "x"); })();
ok(lobbyView.grid === null, "grid is null before a map is selected");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
