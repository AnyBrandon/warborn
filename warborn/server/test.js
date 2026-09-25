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
// Plane footprint is now 2x2 (4 tiles).
const planeDef = roster.find((t) => t.type === "plane");
ok(planeDef.footprint[0] === 2 && planeDef.footprint[1] === 2, "plane footprint is 2x2");

deployAll(m, pA, m.map.zoneA);
deployAll(m, pB, m.map.zoneB);
ok(gl.allPlaced(m.players[pA]), "player A fully placed (10)");
ok(gl.allPlaced(m.players[pB]), "player B fully placed (10)");
// The placed 2x2 plane occupies exactly 4 distinct tiles.
const placedPlane = m.players[pA].tanks.find((t) => t.type === "plane");
ok(placedPlane.tiles.length === 4, "placed plane occupies 4 tiles (2x2)");
const planeKeys = new Set(placedPlane.tiles.map((t) => `${t.x},${t.y}`));
ok(planeKeys.size === 4, "plane's 4 tiles are all distinct (no overlap in footprint)");

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

// ---- Per-turn timer duration (Phase: bumped 30s -> 45s) ----
ok(gl.TURN_TIME_MS === 45000, "per-turn timer is 45 seconds");

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
ok(ballPat.size === 25, "Ballistic star is 25 tiles (center + 8 rays x 3)");
// spot-check each of the 8 directions at full reach (3 out)
ok(ballPat.has("23,20") && ballPat.has("17,20") && ballPat.has("20,23") && ballPat.has("20,17"),
   "Ballistic horizontal/vertical rays reach 3 out");
ok(ballPat.has("23,23") && ballPat.has("17,17") && ballPat.has("23,17") && ballPat.has("17,23"),
   "Ballistic diagonal rays reach 3 out");
ok(!ballPat.has("24,20") && !ballPat.has("22,21"), "Ballistic doesn't exceed reach / off-line tiles");

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
const t0missile = Date.now();
const mres = gl.submitAction(w, "a", { action: "fire", weapon: "missile", target: aim });
const missileResolveMs = Date.now() - t0missile;
ok(mres.ok, "Missile accepted while Heavy alive & uses remain");
ok(mres.result.impacts.length === 5, "Missile resolved 5 impact tiles");
ok(w.players["a"].weapons.missileUses === 1, "Missile use count incremented");
// The 3s impact delay is CLIENT-side only. Server resolution is synchronous:
// impacts + any sunk are present in the returned result immediately, and the
// call returns effectively instantly (no server-side travel-time delay).
ok(missileResolveMs < 100, "Missile resolves immediately server-side (no 3s delay in logic)");
ok(mres.result.impacts.every((i) => typeof i.hit === "boolean"),
   "Missile impacts are fully resolved in the returned result (not deferred)");

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

// ==========================================================================
// PART 1 — Ballistic ray length (exactly 4 tiles per ray)
// ==========================================================================
{
  const pat = keySet(gl.weaponPattern("ballistic", 30, 30));
  // Along +x: 31,32,33 present; 34 (4th) absent (rays are now 3 long).
  ok(pat.has("33,30") && !pat.has("34,30"), "Ballistic +x ray is exactly 3 long");
  ok(pat.has("27,30") && !pat.has("26,30"), "Ballistic -x ray is exactly 3 long");
  ok(pat.has("33,33") && !pat.has("34,34"), "Ballistic diagonal ray is exactly 3 long");
  ok(pat.size === 25, "Ballistic total is 25 tiles (1 + 8*3)");
}

// ==========================================================================
// PART 2 — Smoke Round
// ==========================================================================
{
  const s = freshBattle("highland");
  const az = s.map.zoneA, bz = s.map.zoneB;
  // Find an empty land tile in A's zone for smoke placement.
  const aOcc = new Set();
  s.players["a"].tanks.forEach((t) => t.tiles.forEach((tl) => aOcc.add(`${tl.x},${tl.y}`)));
  let smokeTile = null;
  outerS: for (let y = az.y; y < az.y + az.h; y++)
    for (let x = az.x; x < az.x + az.w; x++) {
      const t = s.map.grid[y][x];
      if ((t === 1 || t === 2) && !aOcc.has(`${x},${y}`)) { smokeTile = { x, y }; break outerS; }
    }

  ensureTurn(s, "a");
  ok(gl.buildPlayerView(s, "a").smokeCharges === 3, "smoke starts at 3 charges");
  const sm = gl.submitAction(s, "a", { action: "smoke", target: smokeTile });
  ok(sm.ok && sm.result.smokePlaced, "smoke placed on own zone");
  ok(s.players["a"].smokeCharges === 2, "smoke charge decremented");
  ok(gl.smokeAt(s.players["a"], smokeTile.x, smokeTile.y), "smoke active on tile");

  // Cannot re-place on an active smoke tile.
  ensureTurn(s, "a");
  const dup = gl.submitAction(s, "a", { action: "smoke", target: smokeTile });
  ok(!dup.ok && /active smoke/i.test(dup.error), "cannot re-place on active smoke");

  // One smoke per turn is inherent (it consumes the action); place elsewhere ok.
  // Put a tank ON a fresh smoke tile to prove smoke forces a miss then pops.
  // Move one of A's light tanks onto a known tile, then A smokes that tile.
  const s2 = freshBattle("highland");
  ensureTurn(s2, "a");
  // pick A's command tank first tile as the "under smoke" test tile
  const aCmdTank = s2.players["a"].tanks.find((t) => t.type === "command");
  const underTile = aCmdTank.tiles[0];
  // A places smoke on that occupied tile (own zone, own tank there — allowed).
  const sp = gl.submitAction(s2, "a", { action: "smoke", target: underTile });
  ok(sp.ok, "smoke placed over own occupied tile");
  // B fires that tile: must MISS (smoke), and smoke pops.
  ensureTurn(s2, "b");
  const bShot = gl.submitAction(s2, "b", { action: "fire", weapon: "tank_shoot", target: underTile });
  ok(bShot.ok && bShot.result.impacts[0].hit === false, "shot on smoke tile forced to MISS");
  ok(bShot.result.smokePopped && bShot.result.smokePopped.length === 1, "smoke popped by the shot");
  ok(!gl.smokeAt(s2.players["a"], underTile.x, underTile.y), "smoke cleared after pop");
  ok(!aCmdTank.hitTiles.some((h) => h.x === underTile.x && h.y === underTile.y), "no damage recorded under smoke");
  // Next shot on the same tile now resolves normally (hits the command tank).
  ensureTurn(s2, "b");
  const bShot2 = gl.submitAction(s2, "b", { action: "fire", weapon: "tank_shoot", target: underTile });
  ok(bShot2.ok && bShot2.result.impacts[0].hit === true, "future shot on popped tile resolves normally (HIT)");

  // Smoke plane gate: sink A's plane, smoke becomes unavailable.
  const s3 = freshBattle("highland");
  for (const tile of s3.players["a"].tanks.find((t) => t.type === "plane").tiles) {
    ensureTurn(s3, "b"); gl.submitAction(s3, "b", { action: "fire", target: tile });
  }
  ensureTurn(s3, "a");
  const noSmoke = gl.submitAction(s3, "a", { action: "smoke", target: smokeTile });
  ok(!noSmoke.ok && /plane/i.test(noSmoke.error), "smoke rejected once plane destroyed");
  ok(gl.buildPlayerView(s3, "a").canSmoke === false, "view.canSmoke false after plane destroyed");

  // Smoke 3-charge cap.
  const s4 = freshBattle("highland");
  let placed = 0, capErr = null;
  const az4 = s4.map.zoneA;
  const a4Occ = new Set();
  s4.players["a"].tanks.forEach((t) => t.tiles.forEach((tl) => a4Occ.add(`${tl.x},${tl.y}`)));
  const spots = [];
  for (let y = az4.y; y < az4.y + az4.h && spots.length < 6; y++)
    for (let x = az4.x; x < az4.x + az4.w && spots.length < 6; x++) {
      const t = s4.map.grid[y][x];
      if ((t === 1 || t === 2) && !a4Occ.has(`${x},${y}`)) spots.push({ x, y });
    }
  for (const spot of spots) {
    ensureTurn(s4, "a");
    const r = gl.submitAction(s4, "a", { action: "smoke", target: spot });
    if (r.ok) placed++;
    else if (/no smoke charges/i.test(r.error)) { capErr = r.error; break; }
  }
  ok(placed === 3 && !!capErr, "smoke capped at 3 charges per game");
}

// ==========================================================================
// PART 3 — Recon Sweep (binary, no tile leak)
// ==========================================================================
{
  const r = freshBattle("highland");
  const bTankTile = r.players["b"].tanks[0].tiles[0];
  // 4x4 area whose top-left puts bTankTile inside it.
  ensureTurn(r, "a");
  const occ = gl.submitAction(r, "a", { action: "recon", area: { x: bTankTile.x - 1, y: bTankTile.y - 1 } });
  ok(occ.ok && occ.result.recon.occupied === true, "recon over enemy unit = occupied");
  ok(occ.result.recon.area && occ.result.recon.area.w === 4, "recon reports 4x4 area, not exact tile");
  // No per-tile leak: result exposes only a boolean + the queried area.
  ok(!("tiles" in occ.result.recon) && !("hitTile" in occ.result.recon), "recon does not leak which tile");
  // Owner records the scanned area as a persistent (owner-only) marker.
  ok(gl.buildPlayerView(r, "a").myReconAreas.length === 1, "recon area recorded for owner");

  // Cap: a second Recon Sweep is rejected (1 use per game).
  ensureTurn(r, "a");
  const second = gl.submitAction(r, "a", { action: "recon", area: { x: bTankTile.x - 1, y: bTankTile.y - 1 } });
  ok(!second.ok && /already used/i.test(second.error), "Recon Sweep capped at 1 use per game");
  ok(gl.buildPlayerView(r, "a").canRecon === false, "view.canRecon false after use");

  // Empty area (fresh match, first use): 4x4 with no enemy tank tiles = empty.
  const r2 = freshBattle("highland");
  const bz = r2.map.zoneB;
  const bOcc = new Set();
  r2.players["b"].tanks.forEach((t) => t.tiles.forEach((tl) => bOcc.add(`${tl.x},${tl.y}`)));
  let emptyArea = null;
  outerR: for (let y = bz.y; y <= bz.y + bz.h - 4; y++)
    for (let x = bz.x; x <= bz.x + bz.w - 4; x++) {
      let any = false;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++)
        if (bOcc.has(`${x+dx},${y+dy}`)) any = true;
      if (!any) { emptyArea = { x, y }; break outerR; }
    }
  ensureTurn(r2, "a");
  const emp = gl.submitAction(r2, "a", { action: "recon", area: emptyArea });
  ok(emp.ok && emp.result.recon.occupied === false, "recon over empty area = empty");
}

// ==========================================================================
// PART 4 — Command Tank double-shot perk
// ==========================================================================
{
  const d = freshBattle("highland");
  ensureTurn(d, "a");
  const view0 = gl.buildPlayerView(d, "a");
  ok(view0.doubleShot === true && view0.shotsAllowed === 2, "double-shot active before any Command hit");

  // First Tank Shoot must NOT end A's turn (perk lets them shoot again).
  const aim = { x: d.map.zoneB.x + 4, y: d.map.zoneB.y + 4 };
  const shot1 = gl.submitAction(d, "a", { action: "fire", weapon: "tank_shoot", target: aim });
  ok(shot1.ok && shot1.result.turnContinues === true && d.activeSlot === "A", "1st Tank Shoot keeps A's turn");
  const shot2 = gl.submitAction(d, "a", { action: "fire", weapon: "tank_shoot", target: aim });
  ok(shot2.ok && shot2.result.turnContinues === false && d.activeSlot === "B", "2nd Tank Shoot ends A's turn");

  // Missile does NOT get a second action even with the perk.
  const d2 = freshBattle("highland");
  ensureTurn(d2, "a");
  const mA = gl.submitAction(d2, "a", { action: "fire", weapon: "missile", target: { x: d2.map.zoneB.x + 5, y: d2.map.zoneB.y + 5 } });
  ok(mA.ok && d2.activeSlot === "B", "Missile only fires once even with double-shot perk");

  // After the FIRST Tank Shoot, the second action can ONLY be another Tank
  // Shoot — Missile/Ballistic/Reposition/Smoke substitution is rejected.
  const d2b = freshBattle("highland");
  ensureTurn(d2b, "a");
  const ez2b = d2b.map.zoneB;
  gl.submitAction(d2b, "a", { action: "fire", weapon: "tank_shoot", target: { x: ez2b.x + 3, y: ez2b.y + 3 } });
  const subMissile = gl.submitAction(d2b, "a", { action: "fire", weapon: "missile", target: { x: ez2b.x + 5, y: ez2b.y + 5 } });
  ok(!subMissile.ok && /second action must be another tank shoot/i.test(subMissile.error),
     "2nd action cannot be a Missile (double-shot is Tank-Shoot-only)");
  const subRepo = gl.submitAction(d2b, "a", { action: "reposition", tankId: d2b.players["a"].tanks[0].tankId, position: { x: d2b.map.zoneA.x, y: d2b.map.zoneA.y }, rotation: 0 });
  ok(!subRepo.ok, "2nd action cannot be a Reposition during double-shot");
  // A genuine second Tank Shoot is allowed and ends the turn.
  const second = gl.submitAction(d2b, "a", { action: "fire", weapon: "tank_shoot", target: { x: ez2b.x + 6, y: ez2b.y + 6 } });
  ok(second.ok && d2b.activeSlot === "B", "2nd Tank Shoot is allowed and ends the turn");

  // Perk lost the instant Command Tank is first hit (not necessarily sunk).
  const d3 = freshBattle("highland");
  const aCmd = d3.players["a"].tanks.find((t) => t.type === "command");
  ensureTurn(d3, "b");
  const hit = gl.submitAction(d3, "b", { action: "fire", weapon: "tank_shoot", target: aCmd.tiles[0] });
  ok(hit.result.commandHit === "A", "result flags A's Command first-hit");
  ok(d3.players["a"].commandEverHit === true, "commandEverHit set on first hit");
  ok(aCmd.sunk === false, "Command not necessarily sunk from one hit");
  ok(gl.hasDoubleShot(d3.players["a"]) === false, "double-shot lost after first Command hit");
  // Now A gets only ONE Tank Shoot per turn.
  ensureTurn(d3, "a");
  const oneShot = gl.submitAction(d3, "a", { action: "fire", weapon: "tank_shoot", target: { x: d3.map.zoneB.x + 4, y: d3.map.zoneB.y + 4 } });
  ok(oneShot.ok && oneShot.result.turnContinues === false && d3.activeSlot === "B", "reverts to 1 shot per turn after Command hit");
  ok(gl.buildPlayerView(d3, "a").doubleShot === false, "view.doubleShot false after Command hit");
}

// ==========================================================================
// PART 5 — Reposition blocked by BOTH hit and missed tiles + incoming-shot view
// ==========================================================================
{
  const g = freshBattle("highland");
  const az = g.map.zoneA;
  const { LAND, HILL, FOREST } = require("./maps");
  const aOcc = new Set();
  g.players["a"].tanks.forEach((t) => t.tiles.forEach((tl) => aOcc.add(`${tl.x},${tl.y}`)));
  // A light tank (footprint 1x2) reposition destination must have BOTH its
  // tiles (x,y)+(x,y+1) be empty, in-zone, non-mud land. Pick a missTile at the
  // TOP of such a valid pair so the ONLY blocker will be the fired-upon tile.
  const validDest = (x, y) => {
    for (const [dx, dy] of [[0, 0], [0, 1]]) {
      const tt = g.map.grid[y + dy] && g.map.grid[y + dy][x + dx];
      if (tt !== LAND && tt !== HILL && tt !== FOREST) return false; // not mud/void
      if (x + dx < az.x || x + dx >= az.x + az.w || y + dy < az.y || y + dy >= az.y + az.h) return false;
      if (aOcc.has(`${x + dx},${y + dy}`)) return false;
    }
    return true;
  };
  let missTile = null;
  for (let y = az.y; y < az.y + az.h - 1 && !missTile; y++)
    for (let x = az.x; x < az.x + az.w && !missTile; x++)
      if (validDest(x, y)) missTile = { x, y };
  ok(!!missTile, "found a valid light-tank reposition destination to fire upon");

  ensureTurn(g, "b");
  const miss = gl.submitAction(g, "b", { action: "fire", weapon: "tank_shoot", target: missTile });
  ok(miss.ok && miss.result.impacts[0].hit === false, "B misses on an empty A-zone tile");

  // A's own view now shows that incoming MISS (black-dot data) on A's board.
  const aView = gl.buildPlayerView(g, "a");
  ok(aView.myIncomingShots.some((s) => s.x === missTile.x && s.y === missTile.y && s.hit === false),
     "defender sees incoming MISS on own board (myIncomingShots)");

  // A cannot reposition a tank ONTO that missed tile (fired-upon, though not hit).
  ensureTurn(g, "a");
  const lite = g.players["a"].tanks.find((t) => t.type === "light");
  const blocked = gl.submitAction(g, "a", { action: "reposition", tankId: lite.tankId, position: { x: missTile.x, y: missTile.y }, rotation: 0 });
  ok(!blocked.ok && /damaged|fired/i.test(blocked.error), "reposition blocked onto a MISSED (fired-upon) tile");
}

// ==========================================================================
// PART 2 — Terrain effects: Forest camo (Tank Shoot) + Mud blocks Reposition
// ==========================================================================
{
  const { FOREST, MUD } = require("./maps");
  const t = freshBattle("highland");

  // Move one of B's tanks onto a FOREST tile in B's zone (via deployment-agnostic
  // direct state tweak is not allowed; instead find a B tank tile that IS forest,
  // or place a smoke-free forest tile under a B tank by locating overlap).
  // Simplest deterministic approach: find a FOREST tile inside B's zone, and a
  // B tank; if the tank isn't there, we still test camo by pointing at a forest
  // tile that a tank occupies — so search for a (forest tile that a B tank covers).
  const bz = t.map.zoneB;
  let forestTankTile = null;
  outerF: for (const tank of t.players["b"].tanks) {
    for (const tl of tank.tiles) {
      if (t.map.grid[tl.y] && t.map.grid[tl.y][tl.x] === FOREST) { forestTankTile = tl; break outerF; }
    }
  }
  // If no B tank happens to sit on forest, reposition one there (A-side helper):
  if (!forestTankTile) {
    // find a forest tile in B zone and move B's first light tank's top-left there
    let fTile = null;
    for (let y = bz.y; y < bz.y + bz.h && !fTile; y++)
      for (let x = bz.x; x < bz.x + bz.w && !fTile; x++)
        if (t.map.grid[y][x] === FOREST) fTile = { x, y };
    if (fTile) {
      // Move B's light tank onto forest (B's own zone; forest is valid, not mud).
      // Ensure it's B's turn.
      ensureTurn(t, "b");
      const bl = t.players["b"].tanks.find((k) => k.type === "light");
      const rr = gl.submitAction(t, "b", { action: "reposition", tankId: bl.tankId, position: fTile, rotation: 0 });
      if (rr.ok) forestTankTile = { x: fTile.x, y: fTile.y };
    }
  }
  ok(!!forestTankTile, "found/created a B tank on a Forest tile");

  if (forestTankTile) {
    // rng that always rolls BELOW the miss chance => camo forces a miss.
    ensureTurn(t, "a");
    const camoMiss = gl.submitAction(t, "a",
      { action: "fire", weapon: "tank_shoot", target: forestTankTile },
      { rng: () => 0.0 });
    ok(camoMiss.ok && camoMiss.result.impacts[0].hit === false && (camoMiss.result.camoMiss || []).length === 1,
       "Forest camo forces Tank Shoot to miss (rng below chance)");

    // rng that rolls ABOVE the miss chance => normal hit.
    ensureTurn(t, "a");
    const camoHit = gl.submitAction(t, "a",
      { action: "fire", weapon: "tank_shoot", target: forestTankTile },
      { rng: () => 0.99 });
    ok(camoHit.ok && camoHit.result.impacts[0].hit === true, "Forest camo does NOT miss when rng above chance");

    // Missile splash on the SAME forest tile ignores camo (always resolves normally).
    // (Use a fresh match so state is clean; place a B tank on forest again.)
    const t2 = freshBattle("highland");
    let fTankTile2 = null;
    outerF2: for (const tank of t2.players["b"].tanks)
      for (const tl of tank.tiles)
        if (t2.map.grid[tl.y][tl.x] === FOREST) { fTankTile2 = tl; break outerF2; }
    if (!fTankTile2) {
      let fTile = null;
      for (let y = t2.map.zoneB.y; y < t2.map.zoneB.y + t2.map.zoneB.h && !fTile; y++)
        for (let x = t2.map.zoneB.x; x < t2.map.zoneB.x + t2.map.zoneB.w && !fTile; x++)
          if (t2.map.grid[y][x] === FOREST) fTile = { x, y };
      ensureTurn(t2, "b");
      const bl = t2.players["b"].tanks.find((k) => k.type === "light");
      if (fTile && gl.submitAction(t2, "b", { action: "reposition", tankId: bl.tankId, position: fTile, rotation: 0 }).ok)
        fTankTile2 = fTile;
    }
    if (fTankTile2) {
      ensureTurn(t2, "a");
      // Missile centered so the forest-tank tile is the center; rng=0 would trigger
      // camo IF it applied — it must NOT for splash weapons.
      const mis = gl.submitAction(t2, "a",
        { action: "fire", weapon: "missile", target: fTankTile2 },
        { rng: () => 0.0 });
      const centerImpact = (mis.result.impacts || []).find((i) => i.x === fTankTile2.x && i.y === fTankTile2.y);
      ok(mis.ok && centerImpact && centerImpact.hit === true && !mis.result.camoMiss,
         "Forest camo does NOT apply to Missile splash");
    }
  }

  // MUD blocks Reposition destinations.
  const t3 = freshBattle("highland");
  const az = t3.map.zoneA;
  let mudTile = null;
  for (let y = az.y; y < az.y + az.h && !mudTile; y++)
    for (let x = az.x; x < az.x + az.w && !mudTile; x++)
      if (t3.map.grid[y][x] === MUD) mudTile = { x, y };
  ok(!!mudTile, "found a Mud tile in A's zone");
  if (mudTile) {
    ensureTurn(t3, "a");
    const lite = t3.players["a"].tanks.find((k) => k.type === "light");
    const blocked = gl.submitAction(t3, "a", { action: "reposition", tankId: lite.tankId, position: mudTile, rotation: 0 });
    ok(!blocked.ok && /mud/i.test(blocked.error), "Reposition onto Mud is rejected");
  }
}

// ==========================================================================
// PART 4 — Surrender ends the match, opponent wins, reuses game-over
// ==========================================================================
{
  const s = freshBattle("highland");
  ok(s.phase === "battle", "match in battle before surrender");
  const res = gl.surrender(s, "a"); // A surrenders
  ok(res.ok && res.winner === "B", "surrender declares opponent (B) the winner");
  ok(s.phase === "over" && s.winner === "B", "match ends with B as winner");
  // Views reflect the win/lose for reusing the existing screen.
  ok(gl.buildPlayerView(s, "b").winner === "B", "B's view shows B as winner");
  ok(gl.buildPlayerView(s, "a").winner === "B", "A's view shows B as winner (A lost)");
  // Cannot surrender outside battle.
  const s2 = gl.createMatch("S2"); gl.addPlayer(s2, "a");
  const bad = gl.surrender(s2, "a");
  ok(!bad.ok, "surrender rejected when not in battle");
}

// ==========================================================================
// PART 5 — Per-tank hit lock: a hit tank can NEVER be repositioned again,
// even while the Transportation Plane is still alive; undamaged tanks of the
// same player remain fully repositionable.
// ==========================================================================
{
  const s = freshBattle("highland");
  const az = s.map.zoneA;

  // Pick a light tank of A and hit exactly one of its tiles (not fully sinking).
  const target = s.players["a"].tanks.find((t) => t.type === "light" && t.tiles.length > 1);
  const firstTile = target.tiles[0];
  ensureTurn(s, "b");
  gl.submitAction(s, "b", { action: "fire", weapon: "tank_shoot", target: firstTile });

  const tk = s.players["a"].tanks.find((t) => t.tankId === target.tankId);
  ok(tk.everHit === true, "tank flagged everHit after taking a single hit");
  ok(tk.sunk === false, "single-tile hit did not fully sink the multi-tile tank");
  ok(gl.canReposition(s.players["a"]) === true, "plane still alive — player can reposition in general");

  // Attempt to reposition the HIT tank — must be rejected even though plane alive.
  ensureTurn(s, "a");
  let hitReject = null;
  for (let yy = az.y; yy < az.y + az.h && !hitReject; yy++)
    for (let xx = az.x; xx < az.x + az.w && !hitReject; xx++) {
      const r = gl.submitAction(s, "a", { action: "reposition", tankId: target.tankId, position: { x: xx, y: yy }, rotation: 0 });
      hitReject = r; // capture first response (ok or not)
    }
  ok(hitReject && !hitReject.ok && /damage/i.test(hitReject.error),
     "hit tank rejected from reposition while plane alive");

  // An UNDAMAGED tank of the same player CAN still reposition.
  ensureTurn(s, "a");
  const clean = s.players["a"].tanks.find((t) => t.type === "light" && !t.everHit && !t.sunk);
  let cleanMoved = null;
  for (let yy = az.y; yy < az.y + az.h && !cleanMoved; yy++)
    for (let xx = az.x; xx < az.x + az.w && !cleanMoved; xx++) {
      const r = gl.submitAction(s, "a", { action: "reposition", tankId: clean.tankId, position: { x: xx, y: yy }, rotation: 0 });
      if (r.ok) cleanMoved = { xx, yy };
    }
  ok(!!cleanMoved, "undamaged tank still repositionable while a sibling tank is hit");

  // buildPlayerView exposes per-tank repositionable flags correctly.
  const view = gl.buildPlayerView(s, "a");
  const hitView = view.myTanks.find((t) => t.tankId === target.tankId);
  const cleanView = view.myTanks.find((t) => t.tankId === clean.tankId);
  ok(hitView.repositionable === false, "view: hit tank flagged NOT repositionable");
  ok(cleanView.repositionable === true, "view: undamaged tank flagged repositionable");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
