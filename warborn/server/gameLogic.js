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
 *  - Turns are SIMULTANEOUS COMMIT-THEN-RESOLVE (see resolveRound).
 */

const { MAPS, LAND, HILL } = require("./maps");

// ---------------------------------------------------------------------------
// Tank roster config (Phase 1: sizes only, all use the same Direct Cannon).
// Stored as config so later phases can change composition/weapons easily.
// footprint is [width, height] in tiles at rotation 0 (horizontal).
// ---------------------------------------------------------------------------
const TANK_ROSTER = [
  { type: "command", label: "Command Tank", footprint: [2, 2], count: 1 },
  { type: "heavy", label: "Heavy Tank", footprint: [2, 3], count: 2 },
  { type: "medium", label: "Medium Tank", footprint: [2, 2], count: 3 },
  { type: "light", label: "Light Tank", footprint: [1, 2], count: 4 },
];

const REPOSITION_COOLDOWN = 3; // a tank may reposition once every 3 rounds
const TURN_TIME_MS = 30000; // 30 second turn timer

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
        footprint: def.footprint.slice(),
        // Placement state (filled during deployment):
        position: null, // {x, y} top-left tile
        rotation: 0, // 0 = horizontal (footprint as-is), 1 = vertical (swapped)
        tiles: [], // resolved list of {x,y} occupied tiles
        // Combat state:
        hitTiles: [], // tiles of this tank that have been hit
        sunk: false,
        lastRepositionRound: -REPOSITION_COOLDOWN, // allows use on round 0
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
    // Round handling for simultaneous resolve:
    round: 0,
    pendingActions: {}, // slot -> action object (cleared each round)
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

// Mark ready; returns true when BOTH players are ready (battle can begin).
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
    match.pendingActions = {};
  }
  return { ok: true, bothReady: both };
}

// ---------------------------------------------------------------------------
// Turn / action submission
// ---------------------------------------------------------------------------
// Record a player's action for this round. Does NOT resolve yet — that happens
// only once BOTH players have submitted (or timer expires -> forced "pass").
function submitAction(match, playerId, action) {
  const player = match.players[playerId];
  if (!player) return { ok: false, error: "No such player" };
  if (match.phase !== "battle") return { ok: false, error: "Not in battle" };
  if (match.pendingActions[player.slot]) {
    return { ok: false, error: "Action already submitted this round" };
  }

  // Validate action shape up-front (but do not APPLY it yet).
  const validated = validateAction(match, player, action);
  if (!validated.ok) return validated;

  match.pendingActions[player.slot] = validated.action;

  const bothSubmitted = match.pendingActions.A && match.pendingActions.B;
  return { ok: true, bothSubmitted };
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
    const tank = player.tanks.find((t) => t.tankId === action.tankId);
    if (!tank) return { ok: false, error: "No such tank" };
    if (tank.sunk) return { ok: false, error: "Cannot move a sunk tank" };

    // Cooldown: once every REPOSITION_COOLDOWN rounds.
    if (match.round - tank.lastRepositionRound < REPOSITION_COOLDOWN) {
      return { ok: false, error: "Tank reposition is on cooldown" };
    }

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
// SIMULTANEOUS RESOLUTION
// ---------------------------------------------------------------------------
// Order (per spec, critical for correctness):
//   1) Apply BOTH repositions first (against the board as it was this round).
//   2) THEN resolve BOTH fire actions against the possibly-updated board.
// This means a tank that repositioned this round may dodge an incoming shot
// aimed at its old tile — that is intended behaviour.
function resolveRound(match) {
  const actions = match.pendingActions;
  const result = {
    round: match.round,
    repositions: [], // {slot, tankId, tiles}
    shots: [], // {slot(shooter), target, hit, sunkTankId|null}
    sunk: [], // {slot(owner), tankId}
  };

  // Ensure per-player hit sets exist.
  for (const p of Object.values(match.players)) {
    if (!p.hits) p.hits = new Set();
  }

  // --- Step 1: apply repositions ---
  for (const slot of ["A", "B"]) {
    const act = actions[slot];
    if (act && act.action === "reposition") {
      const player = getPlayerBySlot(match, slot);
      const tank = player.tanks.find((t) => t.tankId === act.tankId);
      if (tank && !tank.sunk) {
        tank.position = act.position;
        tank.rotation = act.rotation;
        tank.tiles = computeTiles(tank.footprint, act.rotation, act.position);
        tank.lastRepositionRound = match.round; // start cooldown
        result.repositions.push({
          slot,
          tankId: tank.tankId,
          tiles: tank.tiles,
        });
      }
    }
  }

  // --- Step 2: resolve fire actions against updated board ---
  for (const slot of ["A", "B"]) {
    const act = actions[slot];
    if (act && act.action === "fire") {
      const shooter = getPlayerBySlot(match, slot);
      const target = getPlayerBySlot(match, opponentSlot(slot));
      const key = `${act.target.x},${act.target.y}`;

      // Record the shot on the target's board hit set (idempotent).
      target.hits.add(key);

      // Find whether a tank tile occupies the target.
      let hit = false;
      let sunkTankId = null;
      for (const tank of target.tanks) {
        if (tank.sunk) continue;
        const occupies = tank.tiles.some(
          (t) => t.x === act.target.x && t.y === act.target.y
        );
        if (occupies) {
          hit = true;
          // Track this tile as hit on the tank if not already.
          if (!tank.hitTiles.some((t) => t.x === act.target.x && t.y === act.target.y)) {
            tank.hitTiles.push({ x: act.target.x, y: act.target.y });
          }
          // Sunk when every footprint tile has been hit.
          if (tank.hitTiles.length >= tank.tiles.length) {
            tank.sunk = true;
            sunkTankId = tank.tankId;
            result.sunk.push({ slot: target.slot, tankId: tank.tankId });
          }
          break;
        }
      }

      result.shots.push({
        slot, // who fired
        target: { x: act.target.x, y: act.target.y },
        hit,
        sunkTankId,
      });
    }
  }

  // --- Win check ---
  for (const slot of ["A", "B"]) {
    const player = getPlayerBySlot(match, slot);
    const allSunk = player.tanks.every((t) => t.sunk);
    if (allSunk) {
      match.phase = "over";
      match.winner = opponentSlot(slot); // opponent of the wiped player wins
    }
  }

  // Advance round + clear pending actions for next round.
  match.pendingActions = {};
  if (match.phase === "battle") {
    match.round += 1;
  }

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
    footprint: t.footprint,
    position: t.position,
    rotation: t.rotation,
    tiles: t.tiles,
    hitTiles: t.hitTiles,
    sunk: t.sunk,
    onCooldown:
      match.round - t.lastRepositionRound < REPOSITION_COOLDOWN,
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
    submitted: !!match.pendingActions[me.slot],
    oppSubmitted: opp ? !!match.pendingActions[oppSlot] : false,
  };
}

// Reset a match back to a fresh state for "Play Again" (keep same players/slots).
function resetMatch(match) {
  match.mapId = null;
  match.map = null;
  match.phase = "lobby";
  match.round = 0;
  match.pendingActions = {};
  match.winner = null;
  for (const p of Object.values(match.players)) {
    p.ready = false;
    p.tanks = buildRosterInstances();
    p.hits = new Set();
  }
}

module.exports = {
  TANK_ROSTER,
  REPOSITION_COOLDOWN,
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
  resolveRound,
  buildPlayerView,
  resetMatch,
  computeTiles,
};
