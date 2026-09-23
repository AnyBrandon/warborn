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

// ---- Fire hit/miss (Tank Shoot: single-tile pattern) ----
ensureTurn(m, pA);
const bTank = m.players[pB].tanks[0];
const rHit = gl.submitAction(m, pA, { action: "fire", weapon: "tank_shoot", target: bTank.tiles[0] });
ok(rHit.result.impacts.length === 1 && rHit.result.impacts[0].hit === true, "Tank Shoot on enemy tank tile = HIT");
ensureTurn(m, pA);
// Find an empty land tile inside zone B not covered by any tank.
const occupied = new Set();
m.players[pB].tanks.forEach((t) => t.tiles.forEach((tl) => occupied.add(`${tl.x},${tl.y}`)));
let emptyTile = null;
const zB = m.map.zoneB;
outer: for (let y = zB.y; y < zB.y + zB.h; y++)
  for (let x = zB.x; x < zB.x + zB.w; x++) {
    const t = m.map.grid[y][x];
    if ((t === 1 || t === 2) && !occupied.has(`${x},${y}`)) { emptyTile = { x, y }; break outer; }
  }
const rMiss = gl.submitAction(m, pA, { action: "fire", weapon: "tank_shoot", target: emptyTile });
ok(rMiss.result.impacts.length === 1 && rMiss.result.impacts[0].hit === false, "Tank Shoot on empty enemy-zone tile = MISS");

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

// ==========================================================================
// WEAPONS
// ==========================================================================

// ---- Damage patterns (pure function) ----
function keySet(tiles) { return new Set(tiles.map((t) => `${t.x},${t.y}`)); }

const shootPat = gl.weaponPattern("tank_shoot", 10, 10);
ok(shootPat.length === 1 && shootPat[0].x === 10 && shootPat[0].y === 10, "Tank Shoot hits exactly 1 tile");

const missilePat = keySet(gl.weaponPattern("missile", 10, 10));
ok(missilePat.size === 5, "Missile pattern is 5 tiles");
ok(missilePat.has("10,10") && missilePat.has("10,9") && missilePat.has("10,11") &&
   missilePat.has("9,10") && missilePat.has("11,10"), "Missile is center + 4 orthogonal");
ok(!missilePat.has("9,9") && !missilePat.has("11,11") && !missilePat.has("9,11") && !missilePat.has("11,9"),
   "Missile excludes diagonal corners");

const ballPat = keySet(gl.weaponPattern("ballistic", 20, 20));
ok(ballPat.size === 33, "Ballistic star is 33 tiles (center + 8 rays x 4)");
// spot-check each of the 8 directions at full reach
ok(ballPat.has("24,20") && ballPat.has("16,20") && ballPat.has("20,24") && ballPat.has("20,16"),
   "Ballistic horizontal/vertical rays reach 4 out");
ok(ballPat.has("24,24") && ballPat.has("16,16") && ballPat.has("24,16") && ballPat.has("16,24"),
   "Ballistic diagonal rays reach 4 out");
ok(!ballPat.has("25,20") && !ballPat.has("22,21"), "Ballistic doesn't exceed reach / off-line tiles");

// ---- Fresh match for weapon gating/resolution ----
function freshBattle(mapId) {
  const mm = gl.createMatch("W");
  gl.addPlayer(mm, "a"); gl.addPlayer(mm, "b");
  gl.selectMap(mm, mapId);
  deployAll(mm, "a", mm.map.zoneA);
  deployAll(mm, "b", mm.map.zoneB);
  gl.setReady(mm, "a"); gl.setReady(mm, "b");
  return mm;
}

// Missile: valid use hits a cross, decrements uses, sets no-two-in-a-row.
const w = freshBattle("highland");
ensureTurn(w, "a");
const bZone = w.map.zoneB;
// aim at an interior enemy-zone tile so the whole cross lands in-zone
const aim = { x: bZone.x + 5, y: bZone.y + 5 };
const mres = gl.submitAction(w, "a", { action: "fire", weapon: "missile", target: aim });
ok(mres.ok, "Missile accepted while Heavy alive & uses remain");
ok(mres.result.impacts.length === 5, "Missile resolved 5 impact tiles");
ok(w.players["a"].weapons.missileUses === 1, "Missile use count incremented");

// No-two-in-a-row: A's very next turn cannot use Missile.
ensureTurn(w, "a");
const consec = gl.submitAction(w, "a", { action: "fire", weapon: "missile", target: aim });
ok(!consec.ok && /skip a turn|last turn/i.test(consec.error), "Missile blocked two turns in a row");
// but Tank Shoot is fine that turn
const shootOk = gl.submitAction(w, "a", { action: "fire", weapon: "tank_shoot", target: aim });
ok(shootOk.ok, "Tank Shoot allowed on the skipped-missile turn");

// Missile 3-use cap. Because of the no-two-in-a-row rule, interleave a Tank
// Shoot on each "skip" turn so we can reach the cap; the 4th missile must fail
// with "no uses left" (not the skip reason).
const w2 = freshBattle("highland");
const w2aim = { x: w2.map.zoneB.x + 5, y: w2.map.zoneB.y + 5 };
let used = 0, capError = null;
for (let i = 0; i < 12 && used < 4; i++) {
  ensureTurn(w2, "a");
  const r = gl.submitAction(w2, "a", { action: "fire", weapon: "missile", target: w2aim });
  if (r.ok) { used++; }
  else if (/no uses left/i.test(r.error)) { capError = r.error; break; }
  else {
    // blocked by no-two-in-a-row: spend this turn on a Tank Shoot.
    gl.submitAction(w2, "a", { action: "fire", weapon: "tank_shoot", target: w2aim });
  }
}
ok(used === 3 && !!capError, "Missile capped at 3 uses per game (4th rejected)");

// Missile Heavy-gate: sink both of A's Heavy Tanks, Missile becomes unavailable.
const w3 = freshBattle("highland");
for (const heavy of w3.players["a"].tanks.filter((t) => t.type === "heavy")) {
  for (const tile of heavy.tiles) { ensureTurn(w3, "b"); gl.submitAction(w3, "b", { action: "fire", target: tile }); }
}
ok(!gl.heavyAlive(w3.players["a"]), "both A Heavy Tanks sunk");
ensureTurn(w3, "a");
const noHeavy = gl.submitAction(w3, "a", { action: "fire", weapon: "missile", target: { x: w3.map.zoneB.x + 5, y: w3.map.zoneB.y + 5 } });
ok(!noHeavy.ok && /heavy/i.test(noHeavy.error), "Missile rejected once Heavy Tanks destroyed");

// Ballistic: 1-use cap + Command-gate.
const w4 = freshBattle("highland");
ensureTurn(w4, "a");
const b1 = gl.submitAction(w4, "a", { action: "fire", weapon: "ballistic", target: { x: w4.map.zoneB.x + 6, y: w4.map.zoneB.y + 6 } });
ok(b1.ok, "Ballistic accepted while Command alive & unused");
ok(w4.players["a"].weapons.ballisticUses === 1, "Ballistic use count incremented");
ensureTurn(w4, "a");
const b2 = gl.submitAction(w4, "a", { action: "fire", weapon: "ballistic", target: { x: w4.map.zoneB.x + 6, y: w4.map.zoneB.y + 6 } });
ok(!b2.ok && /no uses left/i.test(b2.error), "Ballistic capped at 1 use per game");

// Ballistic Command-gate: sink A's Command Tank, Ballistic becomes unavailable.
const w5 = freshBattle("highland");
const aCmd = w5.players["a"].tanks.find((t) => t.type === "command");
for (const tile of aCmd.tiles) { ensureTurn(w5, "b"); gl.submitAction(w5, "b", { action: "fire", target: tile }); }
ok(!gl.commandAlive(w5.players["a"]), "A Command Tank sunk");
ensureTurn(w5, "a");
const noCmd = gl.submitAction(w5, "a", { action: "fire", weapon: "ballistic", target: { x: w5.map.zoneB.x + 6, y: w5.map.zoneB.y + 6 } });
ok(!noCmd.ok && /command/i.test(noCmd.error), "Ballistic rejected once Command Tank destroyed");

// View exposes weapon availability + reasons.
const wv = gl.buildPlayerView(w5, "a");
ok(wv.weapons && wv.weapons.tank_shoot.available === true, "view weapons: tank_shoot always available");
ok(wv.weapons.ballistic.available === false && /command/i.test(wv.weapons.ballistic.reason),
   "view weapons: ballistic unavailable with reason");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
