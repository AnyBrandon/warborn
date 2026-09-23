/**
 * test.js — engine sanity checks for Warborn (run: node server/test.js).
 * Covers Phase 2: strict alternating turns, timeout passing, the new roster
 * (3 Light + 1 Transportation Plane), and plane-gated Reposition.
 */
const gl = require("./gameLogic");

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.error("  FAIL-", name); }
}

// Deploy all of a player's tanks inside their zone via naive scan (tries both
// rotations so the 1x4 plane fits in tighter spots too).
function deployAll(m, pid, zone) {
  const player = m.players[pid];
  for (const t of player.tanks) {
    let placed = false;
    for (let yy = zone.y; yy < zone.y + zone.h && !placed; yy++) {
      for (let xx = zone.x; xx < zone.x + zone.w && !placed; xx++) {
        if (gl.placeTank(m, pid, t.tankId, { x: xx, y: yy }, 0).ok) { placed = true; break; }
        if (gl.placeTank(m, pid, t.tankId, { x: xx, y: yy }, 1).ok) { placed = true; break; }
      }
    }
    if (!placed) throw new Error("could not place " + t.tankId + " for " + pid);
  }
}

// Sink an entire named tank of the target player by firing every footprint tile.
function sinkTank(m, shooterId, targetId, tankId) {
  const tank = m.players[targetId].tanks.find((t) => t.tankId === tankId);
  for (const tile of tank.tiles) {
    // Ensure it's the shooter's turn.
    if (m.activeSlot !== m.players[shooterId].slot) {
      // opponent passes
      const other = m.activeSlot === "A" ? "a" : "b"; // map slot back to id in this test
    }
    ensureTurn(m, shooterId);
    gl.submitAction(m, shooterId, { action: "fire", target: tile });
  }
}

// Make it `pid`'s turn by having the other player pass until it is.
function ensureTurn(m, pid) {
  const wantSlot = m.players[pid].slot;
  let guard = 0;
  while (m.activeSlot !== wantSlot && m.phase === "battle" && guard++ < 10) {
    const otherId = Object.keys(m.players).find((k) => m.players[k].slot === m.activeSlot);
    gl.submitAction(m, otherId, { action: "pass" });
  }
}

// ---- Setup ----
const m = gl.createMatch("TEST");
const pA = "a", pB = "b";
ok(gl.addPlayer(m, pA) === "A", "player A gets slot A");
ok(gl.addPlayer(m, pB) === "B", "player B gets slot B");
ok(gl.addPlayer(m, "c") === null, "third player rejected");

gl.selectMap(m, "highland");
ok(m.phase === "deploy", "map select -> deploy phase");

// Roster check: 10 units incl. exactly one non-combat plane, 3 light tanks.
const roster = m.players[pA].tanks;
ok(roster.length === 10, "roster has 10 units");
ok(roster.filter((t) => t.type === "light").length === 3, "3 Light Tanks");
ok(roster.filter((t) => t.type === "plane").length === 1, "1 Transportation Plane");
ok(roster.find((t) => t.type === "plane").combat === false, "plane is non-combat");

deployAll(m, pA, m.map.zoneA);
deployAll(m, pB, m.map.zoneB);
ok(gl.allPlaced(m.players[pA]), "player A fully placed (10)");
ok(gl.allPlaced(m.players[pB]), "player B fully placed (10)");

const rdy = gl.setReady(m, pA); gl.setReady(m, pB);
ok(m.phase === "battle", "both ready -> battle");
ok(m.activeSlot === "A" || m.activeSlot === "B", "a first player was chosen");

// ---- Strict alternating turns ----
const firstSlot = m.activeSlot;
const firstId = firstSlot === "A" ? pA : pB;
const secondId = firstSlot === "A" ? pB : pA;

// Non-active player cannot act.
const wrongTurn = gl.submitAction(m, secondId, { action: "pass" });
ok(!wrongTurn.ok && /your turn/i.test(wrongTurn.error), "non-active player is rejected");

// Active player fires; turn passes to the other.
const r1 = gl.submitAction(m, firstId, { action: "pass" });
ok(r1.ok && m.activeSlot === m.players[secondId].slot, "turn passes to opponent after action");

// ---- Turn timeout passes play to the other player ----
const beforeSlot = m.activeSlot;
const to = gl.timeoutTurn(m);
ok(to && to.reason === "timeout", "timeout produces a pass result");
ok(m.activeSlot !== beforeSlot, "timeout passes turn to the other player");

// ---- Fire hit/miss ----
ensureTurn(m, pA);
const bTank = m.players[pB].tanks[0];
const rHit = gl.submitAction(m, pA, { action: "fire", target: bTank.tiles[0] });
ok(rHit.result.shot.hit === true, "fire on enemy tank tile = HIT");
ensureTurn(m, pA);
const rMiss = gl.submitAction(m, pA, { action: "fire", target: { x: 0, y: 0 } });
ok(rMiss.result.shot.hit === false, "fire on empty tile = MISS");

// ---- Reposition works while plane alive (NO cooldown) ----
ensureTurn(m, pA);
const movable = m.players[pA].tanks.find((t) => t.type === "light");
let moved = null;
for (let yy = m.map.zoneA.y; yy < m.map.zoneA.y + m.map.zoneA.h && !moved; yy++)
  for (let xx = m.map.zoneA.x; xx < m.map.zoneA.x + m.map.zoneA.w && !moved; xx++) {
    const r = gl.submitAction(m, pA, { action: "reposition", tankId: movable.tankId, position: { x: xx, y: yy }, rotation: 0 });
    if (r.ok) moved = { xx, yy };
  }
ok(!!moved, "reposition accepted while plane alive");

// Same tank can reposition again immediately — there is no per-tank cooldown.
ensureTurn(m, pA);
let movedAgain = null;
for (let yy = m.map.zoneA.y; yy < m.map.zoneA.y + m.map.zoneA.h && !movedAgain; yy++)
  for (let xx = m.map.zoneA.x; xx < m.map.zoneA.x + m.map.zoneA.w && !movedAgain; xx++) {
    const r = gl.submitAction(m, pA, { action: "reposition", tankId: movable.tankId, position: { x: xx, y: yy }, rotation: 0 });
    if (r.ok) movedAgain = { xx, yy };
  }
ok(!!movedAgain, "same tank repositions again immediately (no cooldown)");

// ---- Plane gating: destroy A's plane, A loses reposition permanently ----
ok(gl.canReposition(m.players[pA]) === true, "canReposition true before plane destroyed");
// B sinks A's plane.
const aPlane = m.players[pA].tanks.find((t) => t.type === "plane");
for (const tile of aPlane.tiles) {
  ensureTurn(m, pB);
  gl.submitAction(m, pB, { action: "fire", target: tile });
}
ok(m.players[pA].tanks.find((t) => t.type === "plane").sunk === true, "A's plane is sunk");
ok(gl.canReposition(m.players[pA]) === false, "canReposition false after plane destroyed");

ensureTurn(m, pA);
const anyLight = m.players[pA].tanks.find((t) => t.type === "light" && !t.sunk);
const blocked = gl.submitAction(m, pA, { action: "reposition", tankId: anyLight.tankId, position: { x: m.map.zoneA.x, y: m.map.zoneA.y }, rotation: 0 });
ok(!blocked.ok && /plane/i.test(blocked.error), "reposition rejected once plane destroyed");
// Fire still works for A.
ensureTurn(m, pA);
const stillFire = gl.submitAction(m, pA, { action: "fire", target: { x: 1, y: 1 } });
ok(stillFire.ok, "fire still allowed after plane destroyed");

// ---- View shape ----
const view = gl.buildPlayerView(m, pA);
const maps = require("./maps");
ok(Array.isArray(view.grid) && view.grid.length === maps.GRID_H && view.grid[0].length === maps.GRID_W,
   `view includes ${maps.GRID_W}x${maps.GRID_H} server-authoritative grid`);
ok(view.enemyShots !== undefined && view.enemySunkTanks !== undefined, "enemy view is fog-of-war only");
ok(view.myTanks.length === 10, "own tanks fully visible (10)");
ok(view.canReposition === false, "view.canReposition reflects destroyed plane");
ok(typeof view.myTurn === "boolean" && typeof view.activeSlot === "string", "view exposes turn info");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
