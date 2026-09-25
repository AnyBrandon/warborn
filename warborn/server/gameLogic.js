/**
 * gameLogic.js — authoritative game state & rules engine for Warborn Phase 1.
 *
 * This module holds ALL truth about a match. The client never decides a hit;
 * it only renders what functions here return. Everything is validated here.
 *
 * Key concepts:
 *  - A Match has two players ("A" and "B"), a chosen map, per-player boards.
 *  - A board tracks placed tanks (with real footprints) and a "hits" set of
 *    tiles that have been fired upon (for both fog-of-war and reposition rules).
 *  - Turns are STRICT ALTERNATING (Phase 2): one player acts at a time, the
 *    action resolves immediately (see resolveAction). A random player goes first.
 *  - Reposition is gated on the player's Transportation Plane being alive.
 */

const { MAPS, LAND, HILL, FOREST, MUD } = require("./maps");

// Forest camouflage: chance a single-tile Tank Shoot on a Forest tile is an
// automatic miss (does NOT apply to Missile/Ballistic splash). Named constant
// for easy tuning. Uses Math.random() at resolve time (injectable for tests).
const FOREST_CAMO_MISS_CHANCE = 0.25;

// ---------------------------------------------------------------------------
// Roster config. footprint is [width, height] in tiles at rotation 0.
// Phase 2: 3 Light Tanks (down from 4) + 1 Transportation Plane (non-combat).
// The Transportation Plane cannot fire; it is placeable/targetable/sinkable
// like any unit. While it is ALIVE the player may Reposition; once it is fully
// sunk the player permanently loses Reposition (see canReposition).
// `combat: false` marks a unit that cannot fire.
// ---------------------------------------------------------------------------
const TANK_ROSTER = [
  { type: "command", label: "Command Tank", footprint: [2, 2], count: 1, combat: true },
  { type: "heavy", label: "Heavy Tank", footprint: [2, 3], count: 2, combat: true },
  { type: "medium", label: "Medium Tank", footprint: [2, 2], count: 3, combat: true },
  { type: "light", label: "Light Tank", footprint: [1, 2], count: 3, combat: true },
  { type: "plane", label: "Transportation Plane", footprint: [2, 2], count: 1, combat: false },
];

const TURN_TIME_MS = 45000; // 45 second per-turn timer (single active player)

// ---------------------------------------------------------------------------
// WEAPONS (Phase 3). A Fire action now selects one of three weapons. Only one
// action per turn total (fire-with-a-weapon OR reposition). All restrictions
// are enforced authoritatively in validateAction.
// ---------------------------------------------------------------------------
const MISSILE_MAX_USES = 3;
const BALLISTIC_MAX_USES = 1;
// Each of the 8 rays extends exactly 3 tiles from (and NOT counting) the shared
// center tile: total = 1 center + 8*3 = 25 tiles.
const BALLISTIC_RAY_LEN = 3;
const SMOKE_MAX_CHARGES = 3; // Smoke charges per player per game
const RECON_SIZE = 4; // Recon Sweep scans a 4x4 area
const RECON_MAX_USES = 1; // Recon Sweep uses per player per game

const WEAPONS = {
  tank_shoot: { id: "tank_shoot", label: "Tank Shoot" },
  missile: { id: "missile", label: "Missile" },
  ballistic: { id: "ballistic", label: "Ballistic Missile" },
};

// Compute the set of target tiles a weapon hits, centered on {cx,cy}.
// Returns an array of {x,y}. Callers filter to the enemy zone / map bounds.
function weaponPattern(weaponId, cx, cy) {
  if (weaponId === "tank_shoot") {
    return [{ x: cx, y: cy }];
  }
  if (weaponId === "missile") {
    // Cross within a 3x3: center + 4 orthogonal neighbors (NOT diagonals).
    return [
      { x: cx, y: cy },
      { x: cx, y: cy - 1 },
      { x: cx, y: cy + 1 },
      { x: cx - 1, y: cy },
      { x: cx + 1, y: cy },
    ];
  }
  if (weaponId === "ballistic") {
    // 8-pointed star: 4 lines (horizontal, vertical, both diagonals) through the
    // center, each extending BALLISTIC_RAY_LEN tiles in both directions.
    const tiles = [{ x: cx, y: cy }];
    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1],      // horizontal + vertical
      [1, 1], [-1, -1], [1, -1], [-1, 1],    // both diagonals
    ];
    for (const [dx, dy] of dirs) {
      for (let n = 1; n <= BALLISTIC_RAY_LEN; n++) {
        tiles.push({ x: cx + dx * n, y: cy + dy * n });
      }
    }
    return tiles;
  }
  return [];
}

// Build the flat list of tank instances a player must place (10 total).
function buildRosterInstances() {
  const list = [];
  let n = 0;
  for (const def of TANK_ROSTER) {
    for (let i = 0; i < def.count; i++) {
      list.push({
        tankId: `${def.type}_${i}`,
        type: def.type,
        label: def.label,
        combat: def.combat,
        footprint: def.footprint.slice(),
        // Placement state (filled during deployment):
        position: null, // {x, y} top-left tile
        rotation: 0, // 0 = horizontal (footprint as-is), 1 = vertical (swapped)
        tiles: [], // resolved list of {x,y} occupied tiles
        // Combat state:
        hitTiles: [], // tiles of this tank that have been hit
        everHit: false, // true once ANY tile is hit — permanently locks Reposition
        sunk: false,
      });
    }
  }
  return list;
}

// Given a tank's footprint + rotation + top-left position, compute occupied tiles.
function computeTiles(footprint, rotation, position) {
  let [w, h] = footprint;
  if (rotation === 1) {
    [w, h] = [h, w]; // vertical: swap width/height
  }
  const tiles = [];
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      tiles.push({ x: position.x + dx, y: position.y + dy });
    }
  }
  return tiles;
}

// Is a tile land/hill (playable)?
// A tile is playable (deployable/traversable) if it's any land-family type:
// land, hill, forest, or mud. (Mud is playable but blocked as a Reposition
// DESTINATION — see the reposition validation.)
function isPlayable(map, x, y) {
  if (y < 0 || y >= map.grid.length) return false;
  if (x < 0 || x >= map.grid[0].length) return false;
  const t = map.grid[y][x];
  return t === LAND || t === HILL || t === FOREST || t === MUD;
}

// Tile-type helper (bounds-safe).
function tileAt(map, x, y) {
  if (y < 0 || y >= map.grid.length) return VOID_TYPE;
  if (x < 0 || x >= map.grid[0].length) return VOID_TYPE;
  return map.grid[y][x];
}
const VOID_TYPE = 0;

// Is a tile inside a rectangular zone?
function inZone(zone, x, y) {
  return (
    x >= zone.x &&
    x < zone.x + zone.w &&
    y >= zone.y &&
    y < zone.y + zone.h
  );
}

// ---------------------------------------------------------------------------
// Match factory
// ---------------------------------------------------------------------------
function createMatch(roomCode) {
  return {
    roomCode,
    mapId: null,
    map: null,
    players: {
      // Filled as players join. Each: { id, slot, ready, tanks:[], connected }
    },
    phase: "lobby", // lobby -> deploy -> battle -> over
    // Strict alternating turns (Phase 2):
    round: 0, // increments each time it returns to the first player
    turn: 0, // total turns taken this match (monotonic)
    activeSlot: null, // whose turn it is: "A" | "B"
    turnTimer: null,
    winner: null,
  };
}

// Assign a player to a slot ("A" or "B"). Returns slot or null if full.
function addPlayer(match, playerId) {
  const usedSlots = Object.values(match.players).map((p) => p.slot);
  let slot = null;
  if (!usedSlots.includes("A")) slot = "A";
  else if (!usedSlots.includes("B")) slot = "B";
  else return null;

  match.players[playerId] = {
    id: playerId,
    slot,
    ready: false,
    connected: true,
    tanks: buildRosterInstances(),
    // Weapon state — persists across the whole match (not per round):
    weapons: {
      missileUses: 0, // Missile fired count (cap 3)
      missileLastTurn: -10, // turn number of the player's last Missile use
      ballisticUses: 0, // Ballistic Missile fired count (cap 1)
    },
    smokeCharges: SMOKE_MAX_CHARGES, // remaining Smoke charges (3 total)
    activeSmoke: [], // this player's own live smoke tiles: [{x,y}]
    reconUses: 0, // Recon Sweep uses (cap 1/game)
    reconAreas: [], // areas this player has scanned: [{x,y,w,h}] (owner-only marker)
    commandEverHit: false, // set true the first time the Command Tank is hit
    // Double-shot bookkeeping: how many Tank Shoots taken in the CURRENT turn.
    shotsThisTurn: 0,
  };
  return slot;
}

function getPlayerBySlot(match, slot) {
  return Object.values(match.players).find((p) => p.slot === slot) || null;
}

function opponentSlot(slot) {
  return slot === "A" ? "B" : "A";
}

// Set the map for the match (Player A's choice is authoritative in Phase 1).
function selectMap(match, mapId) {
  const map = MAPS[mapId];
  if (!map) return { ok: false, error: "Unknown map" };
  match.mapId = mapId;
  match.map = map;
  match.phase = "deploy";
  return { ok: true };
}

// Get the deployment zone for a slot on the current map.
function zoneForSlot(match, slot) {
  return slot === "A" ? match.map.zoneA : match.map.zoneB;
}

// ---------------------------------------------------------------------------
// Deployment validation & placement
// ---------------------------------------------------------------------------
function placeTank(match, playerId, tankId, position, rotation) {
  const player = match.players[playerId];
  if (!player) return { ok: false, error: "No such player" };
  if (match.phase !== "deploy") return { ok: false, error: "Not in deploy phase" };

  const tank = player.tanks.find((t) => t.tankId === tankId);
  if (!tank) return { ok: false, error: "No such tank" };

  const tiles = computeTiles(tank.footprint, rotation, position);
  const zone = zoneForSlot(match, player.slot);

  // 1) Every tile must be playable land AND inside the player's own zone.
  for (const tl of tiles) {
    if (!isPlayable(match.map, tl.x, tl.y)) {
      return { ok: false, error: "Tank must sit on land" };
    }
    if (!inZone(zone, tl.x, tl.y)) {
      return { ok: false, error: "Tank must be inside your deployment zone" };
    }
  }

  // 2) Must not overlap another of THIS player's already-placed tanks.
  const occupied = new Set();
  for (const other of player.tanks) {
    if (other.tankId === tankId) continue;
    for (const t of other.tiles) occupied.add(`${t.x},${t.y}`);
  }
  for (const tl of tiles) {
    if (occupied.has(`${tl.x},${tl.y}`)) {
      return { ok: false, error: "Tanks may not overlap" };
    }
  }

  // Commit placement.
  tank.position = { x: position.x, y: position.y };
  tank.rotation = rotation;
  tank.tiles = tiles;
  return { ok: true };
}

// All 10 tanks placed?
function allPlaced(player) {
  return player.tanks.every((t) => t.tiles.length > 0);
}

// A player may Reposition only while their Transportation Plane is NOT fully
// sunk. Once the plane is destroyed, Reposition is permanently unavailable.
function planeAlive(player) {
  const plane = player.tanks.find((t) => t.type === "plane");
  return !!plane && !plane.sunk;
}
function canReposition(player) {
  return planeAlive(player);
}

// Any living Heavy Tank? (gates Missile.)
function heavyAlive(player) {
  return player.tanks.some((t) => t.type === "heavy" && !t.sunk);
}
// Command Tank alive? (gates Ballistic Missile.)
function commandAlive(player) {
  return player.tanks.some((t) => t.type === "command" && !t.sunk);
}

// Smoke is gated exactly like Reposition: only while the plane is alive.
function canSmoke(player) {
  return planeAlive(player) && player.smokeCharges > 0;
}

// Does this player still have the Command Tank double-shot perk? True only
// while the Command Tank has NEVER been hit (distinct from "sunk").
function hasDoubleShot(player) {
  return !player.commandEverHit;
}

// How many Tank Shoots the player is allowed this turn (2 with the perk, else 1).
function shotsAllowed(player) {
  return hasDoubleShot(player) ? 2 : 1;
}

// Is there active (un-popped) smoke on this owner's tile?
function smokeAt(player, x, y) {
  return (player.activeSmoke || []).some((s) => s.x === x && s.y === y);
}

// Compute per-weapon availability + human reason for THIS player at THIS turn.
// `currentTurn` is match.turn (used for Missile's no-two-in-a-row check).
// Returns { tank_shoot:{available}, missile:{available, reason, usesLeft},
//           ballistic:{available, reason, usesLeft} }.
function weaponStatus(match, player) {
  const w = player.weapons;
  const missileLeft = MISSILE_MAX_USES - w.missileUses;
  const ballisticLeft = BALLISTIC_MAX_USES - w.ballisticUses;

  // Missile gating (all conditions must hold to be available).
  let missileAvail = true, missileReason = "";
  if (!heavyAlive(player)) { missileAvail = false; missileReason = "Heavy Tanks destroyed"; }
  else if (missileLeft <= 0) { missileAvail = false; missileReason = "No uses left"; }
  else if (match.phase === "battle" && w.missileLastTurn === match.turn - 2) {
    // Used it on my previous turn (turns alternate, so my prev turn = turn-2).
    missileAvail = false; missileReason = "Skip a turn (used last turn)";
  }

  // Ballistic gating.
  let ballAvail = true, ballReason = "";
  if (!commandAlive(player)) { ballAvail = false; ballReason = "Command Tank destroyed"; }
  else if (ballisticLeft <= 0) { ballAvail = false; ballReason = "No uses left"; }

  return {
    tank_shoot: { available: true, reason: "", usesLeft: Infinity },
    missile: { available: missileAvail, reason: missileReason, usesLeft: missileLeft },
    ballistic: { available: ballAvail, reason: ballReason, usesLeft: ballisticLeft },
  };
}

// Mark ready; returns true when BOTH players are ready (battle can begin).
// On battle start, randomly choose which player takes the first turn.
function setReady(match, playerId) {
  const player = match.players[playerId];
  if (!player) return { ok: false, error: "No such player" };
  if (!allPlaced(player)) return { ok: false, error: "Place all tanks first" };
  player.ready = true;

  const both =
    Object.values(match.players).length === 2 &&
    Object.values(match.players).every((p) => p.ready);
  if (both) {
    match.phase = "battle";
    match.round = 1;
    match.turn = 1;
    // Random first player.
    match.activeSlot = Math.random() < 0.5 ? "A" : "B";
  }
  return { ok: true, bothReady: both };
}

// ---------------------------------------------------------------------------
// Turn / action submission (STRICT ALTERNATING — Phase 2)
// ---------------------------------------------------------------------------
// The active player submits ONE action; it validates and resolves immediately,
// then the turn passes to the opponent. There is no simultaneous batching.
function submitAction(match, playerId, action, opts) {
  const player = match.players[playerId];
  if (!player) return { ok: false, error: "No such player" };
  if (match.phase !== "battle") return { ok: false, error: "Not in battle" };
  if (player.slot !== match.activeSlot) {
    return { ok: false, error: "Not your turn" };
  }

  // Double-shot restriction: if the player has ALREADY fired a Tank Shoot this
  // turn (mid-double-shot), their SECOND action may only be another Tank Shoot
  // or a "pass" (declining the bonus shot). No Missile / Ballistic / Reposition
  // / Smoke / Recon substitution for the second action.
  if (player.shotsThisTurn > 0) {
    const isSecondTankShoot =
      action.action === "fire" && (action.weapon || "tank_shoot") === "tank_shoot";
    const isPass = action.action === "pass";
    if (!isSecondTankShoot && !isPass) {
      return { ok: false, error: "Double-shot: second action must be another Tank Shoot" };
    }
  }

  const validated = validateAction(match, player, action);
  if (!validated.ok) return validated;

  // Resolve this single action immediately and advance the turn. `opts` allows
  // tests to inject a deterministic rng for Forest camo; production uses default.
  const result = resolveAction(match, validated.action, opts);
  return { ok: true, result };
}

// Advance to the other player's turn (increment round when it returns to first).
function advanceTurn(match) {
  // The player whose turn is ending can't have a half-used double-shot carry over.
  const ending = getPlayerBySlot(match, match.activeSlot);
  if (ending) ending.shotsThisTurn = 0;
  match.turn += 1;
  const next = opponentSlot(match.activeSlot);
  // A "round" is one turn each; bump round counter when play returns to A-style
  // start. We simply increment round every two turns for display purposes.
  if (match.turn % 2 === 1) match.round += 1;
  match.activeSlot = next;
}

// Surrender: the given player forfeits; the OPPONENT is declared the winner and
// the match ends immediately. Reuses the normal game-over flow/win state.
function surrender(match, playerId) {
  const player = match.players[playerId];
  if (!player) return { ok: false, error: "No such player" };
  if (match.phase !== "battle") return { ok: false, error: "Can only surrender during battle" };
  match.phase = "over";
  match.winner = opponentSlot(player.slot);
  return { ok: true, winner: match.winner, surrenderedSlot: player.slot };
}

// Called by the server when the active player's 30s timer expires: they forfeit
// this turn (no action) and play passes to the opponent immediately.
function timeoutTurn(match) {
  if (match.phase !== "battle") return null;
  const passingSlot = match.activeSlot;
  advanceTurn(match);
  return {
    kind: "pass",
    slot: passingSlot,
    reason: "timeout",
    round: match.round,
    turn: match.turn,
    activeSlot: match.activeSlot,
    phase: match.phase,
    winner: match.winner,
  };
}

// Validate an action against current state. Returns a normalized action.
function validateAction(match, player, action) {
  if (action.action === "pass") {
    return { ok: true, action: { slot: player.slot, action: "pass" } };
  }

  if (action.action === "fire") {
    const { x, y } = action.target || {};
    if (typeof x !== "number" || typeof y !== "number") {
      return { ok: false, error: "Fire needs a target tile" };
    }
    // Default to Tank Shoot when no weapon is specified (back-compat).
    const weapon = action.weapon || "tank_shoot";
    if (!WEAPONS[weapon]) return { ok: false, error: "Unknown weapon" };

    // Authoritative weapon restriction checks (never trust the client).
    if (weapon !== "tank_shoot") {
      const status = weaponStatus(match, player);
      const s = status[weapon];
      if (!s.available) {
        const name = WEAPONS[weapon].label;
        return { ok: false, error: `${name} unavailable: ${s.reason}` };
      }
    }

    return {
      ok: true,
      action: { slot: player.slot, action: "fire", weapon, target: { x, y } },
    };
  }

  if (action.action === "smoke") {
    // Gated like Reposition: plane must be alive, and charges must remain.
    if (!planeAlive(player)) {
      return { ok: false, error: "Smoke disabled — Transportation Plane destroyed" };
    }
    if (player.smokeCharges <= 0) {
      return { ok: false, error: "No Smoke charges left" };
    }
    const { x, y } = action.target || {};
    if (typeof x !== "number" || typeof y !== "number") {
      return { ok: false, error: "Smoke needs a target tile" };
    }
    const zone = zoneForSlot(match, player.slot);
    if (!inZone(zone, x, y) || !isPlayable(match.map, x, y)) {
      return { ok: false, error: "Smoke must be placed on land in your own zone" };
    }
    // Cannot re-place on a tile that already has active (un-popped) smoke.
    if (smokeAt(player, x, y)) {
      return { ok: false, error: "That tile already has active smoke" };
    }
    return { ok: true, action: { slot: player.slot, action: "smoke", target: { x, y } } };
  }

  if (action.action === "recon") {
    // Recon Sweep: pick the TOP-LEFT of a RECON_SIZE x RECON_SIZE area. 1/game.
    if (player.reconUses >= RECON_MAX_USES) {
      return { ok: false, error: "Recon Sweep already used this game" };
    }
    const { x, y } = action.area || {};
    if (typeof x !== "number" || typeof y !== "number") {
      return { ok: false, error: "Recon needs an area" };
    }
    return { ok: true, action: { slot: player.slot, action: "recon", area: { x, y } } };
  }

  if (action.action === "reposition") {
    // Plane gate (authoritative): no repositioning once the plane is destroyed.
    if (!canReposition(player)) {
      return { ok: false, error: "Reposition disabled — Transportation Plane destroyed" };
    }
    const tank = player.tanks.find((t) => t.tankId === action.tankId);
    if (!tank) return { ok: false, error: "No such tank" };
    if (tank.sunk) return { ok: false, error: "Cannot move a sunk tank" };
    // PER-TANK HIT LOCK (authoritative): once this specific tank has taken any
    // hit (on any of its tiles), it can never be repositioned again — even if
    // the plane is still alive and other undamaged tanks remain repositionable.
    if (tank.everHit || (tank.hitTiles && tank.hitTiles.length > 0)) {
      return { ok: false, error: "This unit has taken damage and cannot be repositioned" };
    }

    const rotation = action.rotation || 0;
    const position = action.position;
    if (!position) return { ok: false, error: "Reposition needs a position" };

    const newTiles = computeTiles(tank.footprint, rotation, position);
    const zone = zoneForSlot(match, player.slot);

    // Must land on playable tiles inside own zone. MUD tiles are explicitly
    // invalid Reposition destinations (a tank cannot be MOVED onto mud — though
    // it may have been deployed there initially, which is unaffected).
    for (const tl of newTiles) {
      if (!isPlayable(match.map, tl.x, tl.y)) {
        return { ok: false, error: "Must reposition onto land" };
      }
      if (tileAt(match.map, tl.x, tl.y) === MUD) {
        return { ok: false, error: "Cannot reposition onto mud" };
      }
      if (!inZone(zone, tl.x, tl.y)) {
        return { ok: false, error: "Must stay in your deployment zone" };
      }
    }

    // Must not overlap another of this player's tanks (excluding itself).
    const occupied = new Set();
    for (const other of player.tanks) {
      if (other.tankId === tank.tankId) continue;
      for (const t of other.tiles) occupied.add(`${t.x},${t.y}`);
    }
    for (const tl of newTiles) {
      if (occupied.has(`${tl.x},${tl.y}`)) {
        return { ok: false, error: "Destination is occupied" };
      }
    }

    // CANNOT move onto any tile that has ALREADY been fired upon on my own board
    // — this covers BOTH hits and misses, since player.hits records every fired
    // tile with its resolved outcome (not just hits).
    const hitMap = player.hits || new Map();
    for (const tl of newTiles) {
      if (hitMap.has(`${tl.x},${tl.y}`)) {
        return { ok: false, error: "Cannot reposition onto a damaged tile" };
      }
    }

    return {
      ok: true,
      action: {
        slot: player.slot,
        action: "reposition",
        tankId: tank.tankId,
        position: { x: position.x, y: position.y },
        rotation,
      },
    };
  }

  return { ok: false, error: "Unknown action" };
}

// Resolve a single tile against a target player's board (binary hit/miss +
// per-tile sink tracking). Records the shot for fog-of-war, mutates the tank's
// hitTiles/sunk state, and appends any newly-sunk tank into `result`. Returns
// { hit }. Shared by all weapons — a splash weapon just calls this per tile.
// opts.camoEligible: true only for single-tile Tank Shoot (Forest camo applies).
// opts.rng: injectable random source (defaults to Math.random) for testing.
function applyHitToTile(match, target, x, y, result, opts) {
  opts = opts || {};
  const rng = opts.rng || Math.random;

  // SMOKE: if the target has active smoke on this tile, the shot ALWAYS misses,
  // and the smoke is consumed by this triggering shot (reverts to normal after).
  const smokeIdx = (target.activeSmoke || []).findIndex((s) => s.x === x && s.y === y);
  if (smokeIdx !== -1) {
    target.activeSmoke.splice(smokeIdx, 1); // pop it
    target.hits.set(`${x},${y}`, false); // recorded as a miss for fog-of-war
    result.smokePopped = result.smokePopped || [];
    result.smokePopped.push({ slot: target.slot, x, y });
    return { hit: false };
  }

  for (const tank of target.tanks) {
    if (tank.sunk) continue;
    if (!tank.tiles.some((t) => t.x === x && t.y === y)) continue;

    // FOREST CAMO: only for single-tile Tank Shoot. If the occupied tile is a
    // Forest tile, there's FOREST_CAMO_MISS_CHANCE the shot auto-misses. Does
    // NOT apply to Missile/Ballistic splash (camoEligible=false there).
    if (opts.camoEligible && tileAt(match.map, x, y) === FOREST) {
      if (rng() < FOREST_CAMO_MISS_CHANCE) {
        target.hits.set(`${x},${y}`, false); // recorded as a miss (camo)
        result.camoMiss = result.camoMiss || [];
        result.camoMiss.push({ x, y });
        return { hit: false };
      }
    }
    if (!tank.hitTiles.some((t) => t.x === x && t.y === y)) {
      tank.hitTiles.push({ x, y });
    }
    // Per-tank hit lock: mark this tank as permanently ineligible for Reposition.
    tank.everHit = true;
    // Command Tank: mark the perk-ending "first hit" (distinct from sunk).
    if (tank.type === "command" && !target.commandEverHit) {
      target.commandEverHit = true;
      result.commandHit = target.slot;
    }
    if (tank.hitTiles.length >= tank.tiles.length) {
      tank.sunk = true;
      result.sunk.push({ slot: target.slot, tankId: tank.tankId });
      if (tank.type === "plane") result.planeDestroyed = target.slot;
    }
    target.hits.set(`${x},${y}`, true); // resolved as a hit
    return { hit: true };
  }
  target.hits.set(`${x},${y}`, false); // resolved as a miss
  return { hit: false };
}

// ---------------------------------------------------------------------------
// SINGLE-ACTION RESOLUTION (Phase 2 — one action resolves at a time)
// ---------------------------------------------------------------------------
// Resolves the given (already-validated) action immediately, checks for a win,
// then advances the turn to the opponent. Returns a result describing what
// happened, broadcast to both clients.
function resolveAction(match, act, opts) {
  opts = opts || {};
  const rng = opts.rng || Math.random; // injectable for deterministic tests
  for (const p of Object.values(match.players)) {
    if (!p.hits) p.hits = new Map(); // "x,y" -> resolved hit (bool)
  }

  const result = {
    round: match.round,
    turn: match.turn,
    actorSlot: act.slot,
    kind: act.action, // fire | reposition | smoke | recon | pass
    weapon: act.weapon || null, // which weapon (fire only)
    reposition: null, // {slot, tankId, tiles}
    center: null, // {x,y} aim point (fire only)
    impacts: [], // [{x,y,hit}] every tile the weapon resolved against
    sunk: [], // {slot(owner), tankId}
    planeDestroyed: null, // slot whose plane was just destroyed, if any
    commandHit: null, // slot whose Command Tank just took its first hit
    smokePlaced: null, // {slot,x,y} smoke placed this action
    smokePopped: null, // [{slot,x,y}] smoke consumed by a shot this action
    recon: null, // {slot, area:{x,y,w,h}, occupied}
  };

  const actor = getPlayerBySlot(match, act.slot);

  if (act.action === "reposition") {
    const tank = actor.tanks.find((t) => t.tankId === act.tankId);
    if (tank && !tank.sunk) {
      tank.position = act.position;
      tank.rotation = act.rotation;
      tank.tiles = computeTiles(tank.footprint, act.rotation, act.position);
      result.reposition = { slot: act.slot, tankId: tank.tankId, tiles: tank.tiles };
    }
  } else if (act.action === "smoke") {
    // Place a smoke charge on the actor's OWN tile (already validated).
    actor.smokeCharges -= 1;
    actor.activeSmoke.push({ x: act.target.x, y: act.target.y });
    result.smokePlaced = { slot: act.slot, x: act.target.x, y: act.target.y };
  } else if (act.action === "recon") {
    // Scan a RECON_SIZE x RECON_SIZE on the enemy zone; binary occupied/empty,
    // no damage, no tile leak.
    const target = getPlayerBySlot(match, opponentSlot(act.slot));
    const zone = zoneForSlot(match, target.slot);
    let occupied = false;
    for (let dy = 0; dy < RECON_SIZE && !occupied; dy++)
      for (let dx = 0; dx < RECON_SIZE && !occupied; dx++) {
        const x = act.area.x + dx, y = act.area.y + dy;
        if (!inZone(zone, x, y)) continue;
        if (target.tanks.some((t) => !t.sunk && t.tiles.some((tl) => tl.x === x && tl.y === y)))
          occupied = true;
      }
    const area = { x: act.area.x, y: act.area.y, w: RECON_SIZE, h: RECON_SIZE };
    actor.reconUses += 1;
    actor.reconAreas.push(area); // owner-only persistent marker
    result.recon = { slot: act.slot, area, occupied };
  } else if (act.action === "fire") {
    const target = getPlayerBySlot(match, opponentSlot(act.slot));
    const zone = zoneForSlot(match, target.slot);
    result.center = { x: act.target.x, y: act.target.y };

    if (act.weapon === "missile") {
      actor.weapons.missileUses += 1;
      actor.weapons.missileLastTurn = match.turn;
    } else if (act.weapon === "ballistic") {
      actor.weapons.ballisticUses += 1;
    } else if (act.weapon === "tank_shoot") {
      actor.shotsThisTurn += 1; // count toward the double-shot allowance
    }

    const weapon = act.weapon || "tank_shoot";
    // Forest camo only affects single-tile Tank Shoot, never splash weapons.
    const camoEligible = weapon === "tank_shoot";
    const pattern = weaponPattern(weapon, act.target.x, act.target.y);
    for (const tl of pattern) {
      if (tl.x < 0 || tl.y < 0 || tl.x >= (match.map.grid[0].length) || tl.y >= match.map.grid.length) continue;
      if (!inZone(zone, tl.x, tl.y)) continue; // no effect outside enemy zone
      const outcome = applyHitToTile(match, target, tl.x, tl.y, result, { camoEligible, rng });
      result.impacts.push({ x: tl.x, y: tl.y, hit: outcome.hit });
    }
  }
  // "pass" resolves to nothing.

  // --- Win check ---
  for (const slot of ["A", "B"]) {
    const player = getPlayerBySlot(match, slot);
    if (player.tanks.every((t) => t.sunk)) {
      match.phase = "over";
      match.winner = opponentSlot(slot);
    }
  }

  // --- Turn continuation vs advance ---
  // Double-shot: a Tank Shoot does NOT end the turn if the actor still has the
  // perk AND has shots remaining this turn. Every other action (or the 2nd
  // shot, or the perk being lost this very shot) ends the turn.
  const isTankShoot = act.action === "fire" && act.weapon === "tank_shoot";
  const moreShots =
    isTankShoot &&
    hasDoubleShot(actor) && // still have the perk (not lost this shot)
    actor.shotsThisTurn < shotsAllowed(actor);

  if (match.phase === "battle" && !moreShots) {
    actor.shotsThisTurn = 0; // reset for next time this player acts
    advanceTurn(match);
  }
  result.turnContinues = moreShots && match.phase === "battle";

  result.round = match.round;
  result.turn = match.turn;
  result.activeSlot = match.activeSlot;
  result.winner = match.winner;
  result.phase = match.phase;
  return result;
}

// ---------------------------------------------------------------------------
// Client views (fog-of-war). Never leak enemy tank positions.
// ---------------------------------------------------------------------------
// Build the state a specific player is allowed to see.
function buildPlayerView(match, playerId) {
  const me = match.players[playerId];
  if (!me) return null;
  const oppSlot = opponentSlot(me.slot);
  const opp = getPlayerBySlot(match, oppSlot);

  // My own full tank data.
  const myTanks = me.tanks.map((t) => ({
    tankId: t.tankId,
    type: t.type,
    label: t.label,
    combat: t.combat,
    footprint: t.footprint,
    position: t.position,
    rotation: t.rotation,
    tiles: t.tiles,
    hitTiles: t.hitTiles,
    everHit: t.everHit,
    sunk: t.sunk,
    // Per-tank Reposition eligibility: needs the plane alive, tank not sunk,
    // AND the tank must never have been hit. Lets the client grey out locked
    // tanks without re-deriving the rule.
    repositionable: canReposition(me) && !t.sunk && !t.everHit && !(t.hitTiles && t.hitTiles.length > 0),
  }));

  // Enemy view: fog-of-war. Only reveal a tank's tiles once it is sunk.
  // Otherwise expose only the set of tiles I've fired on and whether each hit.
  let enemyShots = [];
  if (opp) {
    const enemyHitMap = opp.hits || new Map();
    // Use the ACTUAL resolved outcome recorded at fire time (not a re-derivation
    // from occupancy) so smoke-forced misses stay misses in the fog-of-war view.
    for (const [key, wasHit] of enemyHitMap) {
      const [x, y] = key.split(",").map(Number);
      enemyShots.push({ x, y, hit: wasHit });
    }
  }
  const enemySunkTanks =
    opp
      ? opp.tanks.filter((t) => t.sunk).map((t) => ({
          tankId: t.tankId,
          type: t.type,
          tiles: t.tiles,
        }))
      : [];

  // Incoming shots on MY own board: every tile the enemy has fired at me, with
  // the resolved hit/miss. This lets the DEFENDER see both red (hit) and black
  // (miss) markers on their own zone — previously misses were invisible to them.
  const myIncomingShots = [];
  for (const [key, wasHit] of (me.hits || new Map())) {
    const [x, y] = key.split(",").map(Number);
    myIncomingShots.push({ x, y, hit: wasHit });
  }

  return {
    slot: me.slot,
    phase: match.phase,
    round: match.round,
    turn: match.turn,
    mapId: match.mapId,
    // Server-authoritative map tile data (land/void/hill). null until a map is
    // selected. This is the single source of truth — the client renders from
    // this and no longer keeps a local copy of the templates.
    grid: match.map ? match.map.grid : null,
    myTanks,
    myZone: match.map ? zoneForSlot(match, me.slot) : null,
    enemyZone: match.map ? zoneForSlot(match, oppSlot) : null,
    enemyShots, // tiles I've fired on the enemy + hit/miss
    myIncomingShots, // tiles the enemy fired at me + hit/miss (my own board)
    enemySunkTanks, // revealed only when sunk
    myReady: me.ready,
    oppReady: opp ? opp.ready : false,
    oppConnected: opp ? opp.connected : false,
    winner: match.winner,
    // Alternating-turn state:
    activeSlot: match.activeSlot,
    myTurn: match.phase === "battle" && match.activeSlot === me.slot,
    canReposition: canReposition(me), // false once my plane is destroyed
    planeAlive: planeAlive(me),
    oppPlaneAlive: opp ? planeAlive(opp) : true,
    // Per-weapon availability + reasons for the weapon-select UI.
    weapons: weaponStatus(match, me),
    // Smoke (mine only — NEVER leak my smoke to the enemy's fog-of-war view):
    smokeCharges: me.smokeCharges,
    canSmoke: canSmoke(me),
    mySmoke: (me.activeSmoke || []).map((s) => ({ x: s.x, y: s.y })),
    // Recon: uses left + my OWN scanned areas (owner-only persistent markers).
    reconUsesLeft: RECON_MAX_USES - me.reconUses,
    canRecon: me.reconUses < RECON_MAX_USES,
    myReconAreas: (me.reconAreas || []).map((a) => ({ x: a.x, y: a.y, w: a.w, h: a.h })),
    // Command Tank double-shot perk:
    doubleShot: hasDoubleShot(me),
    shotsThisTurn: me.shotsThisTurn,
    shotsAllowed: shotsAllowed(me),
    commandEverHit: me.commandEverHit,
  };
}

// Reset a match back to a fresh state for "Play Again" (keep same players/slots).
function resetMatch(match) {
  match.mapId = null;
  match.map = null;
  match.phase = "lobby";
  match.round = 0;
  match.turn = 0;
  match.activeSlot = null;
  match.winner = null;
  for (const p of Object.values(match.players)) {
    p.ready = false;
    p.tanks = buildRosterInstances();
    p.hits = new Map();
    p.weapons = { missileUses: 0, missileLastTurn: -10, ballisticUses: 0 };
    p.smokeCharges = SMOKE_MAX_CHARGES;
    p.activeSmoke = [];
    p.reconUses = 0;
    p.reconAreas = [];
    p.commandEverHit = false;
    p.shotsThisTurn = 0;
  }
}

module.exports = {
  TANK_ROSTER,
  TURN_TIME_MS,
  WEAPONS,
  SMOKE_MAX_CHARGES,
  RECON_SIZE,
  RECON_MAX_USES,
  weaponPattern,
  weaponStatus,
  heavyAlive,
  commandAlive,
  canSmoke,
  hasDoubleShot,
  shotsAllowed,
  smokeAt,
  createMatch,
  addPlayer,
  getPlayerBySlot,
  opponentSlot,
  selectMap,
  zoneForSlot,
  placeTank,
  allPlaced,
  setReady,
  submitAction,
  resolveAction,
  timeoutTurn,
  surrender,
  canReposition,
  planeAlive,
  tileAt,
  FOREST_CAMO_MISS_CHANCE,
  buildPlayerView,
  resetMatch,
  computeTiles,
};
