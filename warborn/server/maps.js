/**
 * maps.js — preset map templates for Warborn.
 *
 * Tile data is now BAKED (generated offline) rather than hand-typed. The actual
 * land/void/hill arrays live in ./mapData.js, produced by the deterministic
 * noise generator in ./mapgen/generate.js. There is NO runtime randomness — the
 * arrays are frozen static data, same guarantee as the old hand-typed maps,
 * just organically shaped (real coastlines: bays, peninsulas, inlets, islands).
 *
 * Every tile is one of:
 *   0 = void   (unplayable, rendered as water / out-of-bounds)
 *   1 = land   (placeable + playable)
 *   2 = hill   (terrain-visual only; no gameplay effect)
 *   3 = forest (playable land + camouflage: chance to auto-miss Tank Shoot)
 *   4 = mud    (playable land, but INVALID as a Reposition destination)
 *
 * Each map defines two deployment regions (zoneA / zoneB) as rectangular
 * bounding boxes {x, y, w, h}. A tank may only deploy on land/hill tiles that
 * fall fully inside that player's own zone. Zones sit in separate regions of
 * contiguous land with a neutral buffer between them.
 *
 * Tiles are row-major: grid[y][x].
 *
 * To change a map: edit + re-run `node server/mapgen/generate.js --write`,
 * which regenerates ./mapData.js. Do not hand-edit the arrays.
 */

const { GRID_W, GRID_H, DATA } = require("./mapData");

const VOID = 0;
const LAND = 1;
const HILL = 2;
const FOREST = 3;
const MUD = 4;

// Human-facing names for each generated template.
const NAMES = {
  isthmus: "The Isthmus",
  archipelago: "Archipelago",
  highland: "Highland Basin",
  squid: "Squid",
};

// Assemble the runtime MAPS object from the baked data.
const MAPS = {};
for (const [id, def] of Object.entries(DATA)) {
  MAPS[id] = {
    id,
    name: NAMES[id] || id,
    grid: def.grid,
    zoneA: def.zoneA,
    zoneB: def.zoneB,
  };
}

// Public list used by the client to render the map-select menu.
const MAP_LIST = Object.values(MAPS).map((m) => ({ id: m.id, name: m.name }));

module.exports = {
  GRID_W,
  GRID_H,
  VOID,
  LAND,
  HILL,
  FOREST,
  MUD,
  MAPS,
  MAP_LIST,
};
