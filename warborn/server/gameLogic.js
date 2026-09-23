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

const { MAPS, LAND, HILL } = require("./maps");

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
  { type: "plane", label: "Transportation Plane", footprint: [1, 4], count: 1, combat: false },
];

const TURN_TIME_MS = 30000; // 30 second per-turn timer (single active player)

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
function isPlayable(map, x, y) {
  if (y < 0 || y >= map.grid.length) return false;
  if (x < 0 || x >= map.grid[0].length) return false;
  const t = map.grid[y][x];
  return t === LAND || t === HILL;
}

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
function submitAction(match, playerId, action) {
  const player = match.players[playerId];
  if (!player) return { ok: false, error: "No such player" };
  if (match.phase !== "battle") return { ok: false, error: "Not in battle" };
  if (player.slot !== match.activeSlot) {
    return { ok: false, error: "Not your turn" };
  }

  const validated = validateAction(match, player, action);
  if (!validated.ok) return validated;

  // Resolve this single action immediately and advance the turn.
  const result = resolveAction(match, validated.action);
  return { ok: true, result };
}

// Advance to the other player's turn (increment round when it returns to first).
function advanceTurn(match) {
  match.turn += 1;
  const next = opponentSlot(match.activeSlot);
  // A "round" is one turn each; bump round counter when play returns to A-style
  // start. We simply increment round every two turns for display purposes.
  if (match.turn % 2 === 1) match.round += 1;
  match.activeSlot = next;
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
    // You may fire anywhere on the enemy grid (misses on void are allowed but
    // pointless; we still record them as misses for fog-of-war clarity).
    return {
      ok: true,
      action: { slot: player.slot, action: "fire", target: { x, y } },
    };
  }

  if (action.action === "reposition") {
    // Plane gate (authoritative): no repositioning once the plane is destroyed.
    if (!canReposition(player)) {
      return { ok: false, error: "Reposition disabled — Transportation Plane destroyed" };
    }
    const tank = player.tanks.find((t) => t.tankId === action.tankId);
    if (!tank) return { ok: false, error: "No such tank" };
    if (tank.sunk) return { ok: false, error: "Cannot move a sunk tank" };

    const rotation = action.rotation || 0;
    const position = action.position;
    if (!position) return { ok: false, error: "Reposition needs a position" };

    const newTiles = computeTiles(tank.footprint, rotation, position);
    const zone = zoneForSlot(match, player.slot);

    // Must land on playable tiles inside own zone.
    for (const tl of newTiles) {
      if (!isPlayable(match.map, tl.x, tl.y)) {
        return { ok: false, error: "Must reposition onto land" };
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

    // CANNOT move onto a tile that has already been hit/damaged on own board.
    const hitSet = player.hits || new Set();
    for (const tl of newTiles) {
      if (hitSet.has(`${tl.x},${tl.y}`)) {
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

// ---------------------------------------------------------------------------
// SINGLE-ACTION RESOLUTION (Phase 2 — one action resolves at a time)
// ---------------------------------------------------------------------------
// Resolves the given (already-validated) action immediately, checks for a win,
// then advances the turn to the opponent. Returns a result describing what
// happened, broadcast to both clients.
function resolveAction(match, act) {
  for (const p of Object.values(match.players)) {
    if (!p.hits) p.hits = new Set();
  }

  const result = {
    round: match.round,
    turn: match.turn,
    actorSlot: act.slot,
    kind: act.action, // "fire" | "reposition" | "pass"
    reposition: null, // {slot, tankId, tiles}
    shot: null, // {slot, target, hit, sunkTankId|null}
    sunk: [], // {slot(owner), tankId}
    planeDestroyed: null, // slot whose plane was just destroyed, if any
  };

  if (act.action === "reposition") {
    const player = getPlayerBySlot(match, act.slot);
    const tank = player.tanks.find((t) => t.tankId === act.tankId);
    if (tank && !tank.sunk) {
      tank.position = act.position;
      tank.rotation = act.rotation;
      tank.tiles = computeTiles(tank.footprint, act.rotation, act.position);
      result.reposition = { slot: act.slot, tankId: tank.tankId, tiles: tank.tiles };
    }
  } else if (act.action === "fire") {
    const target = getPlayerBySlot(match, opponentSlot(act.slot));
    const key = `${act.target.x},${act.target.y}`;
    target.hits.add(key); // record for fog-of-war (idempotent)

    let hit = false;
    let sunkTankId = null;
    for (const tank of target.tanks) {
      if (tank.sunk) continue;
      const occupies = tank.tiles.some(
        (t) => t.x === act.target.x && t.y === act.target.y
      );
      if (occupies) {
        hit = true;
        if (!tank.hitTiles.some((t) => t.x === act.target.x && t.y === act.target.y)) {
          tank.hitTiles.push({ x: act.target.x, y: act.target.y });
        }
        if (tank.hitTiles.length >= tank.tiles.length) {
          tank.sunk = true;
          sunkTankId = tank.tankId;
          result.sunk.push({ slot: target.slot, tankId: tank.tankId });
          // Note if this was the Transportation Plane (disables their reposition).
          if (tank.type === "plane") result.planeDestroyed = target.slot;
        }
        break;
      }
    }
    result.shot = { slot: act.slot, target: { x: act.target.x, y: act.target.y }, hit, sunkTankId };
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

  // Advance the turn (unless the match just ended).
  if (match.phase === "battle") advanceTurn(match);

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
    sunk: t.sunk,
  }));

  // Enemy view: fog-of-war. Only reveal a tank's tiles once it is sunk.
  // Otherwise expose only the set of tiles I've fired on and whether each hit.
  let enemyShots = [];
  if (opp) {
    const enemyHitSet = opp.hits || new Set();
    for (const key of enemyHitSet) {
      const [x, y] = key.split(",").map(Number);
      const occupied = opp.tanks.some(
        (t) => t.tiles.some((tl) => tl.x === x && tl.y === y)
      );
      enemyShots.push({ x, y, hit: occupied });
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
    p.hits = new Set();
  }
}

module.exports = {
  TANK_ROSTER,
  TURN_TIME_MS,
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
  canReposition,
  planeAlive,
  buildPlayerView,
  resetMatch,
  computeTiles,
};
