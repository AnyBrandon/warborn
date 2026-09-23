/**
 * maps.js — preset map template definitions for Warborn Phase 1.
 *
 * Each map is a tile grid of GRID_W x GRID_H. Every tile is either:
 *   0 = void  (unplayable, rendered as water / out-of-bounds)
 *   1 = land  (placeable + playable)
 *   2 = hill  (visual only in Phase 1 — treated exactly like land for gameplay)
 *
 * Each map also defines two deployment regions (zoneA / zoneB) as rectangular
 * bounding boxes {x, y, w, h}. A tank may only be deployed on land/hill tiles
 * that fall fully inside that player's own zone. Zones are placed on roughly
 * opposite sides so players never see or place on each other's start area.
 *
 * Tiles are stored row-major: grid[y][x].
 */

const GRID_W = 30;
const GRID_H = 30;

const VOID = 0;
const LAND = 1;
const HILL = 2;

// Helper: build an all-void grid we can carve land into.
function blankGrid() {
  const g = [];
  for (let y = 0; y < GRID_H; y++) {
    g.push(new Array(GRID_W).fill(VOID));
  }
  return g;
}

// Fill a rectangle of tiles with a given type.
function fillRect(grid, x0, y0, w, h, type) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (y >= 0 && y < GRID_H && x >= 0 && x < GRID_W) {
        grid[y][x] = type;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// a) The Isthmus — two landmasses connected by a narrow bridge strip.
// ---------------------------------------------------------------------------
function buildIsthmus() {
  const g = blankGrid();
  // Left landmass
  fillRect(g, 2, 4, 10, 22, LAND);
  // Right landmass
  fillRect(g, 18, 4, 10, 22, LAND);
  // Narrow horizontal bridge connecting them (rows 13-16)
  fillRect(g, 12, 13, 6, 4, LAND);
  // A few hills for visual flavour (no gameplay effect in Phase 1)
  fillRect(g, 4, 6, 3, 3, HILL);
  fillRect(g, 22, 20, 3, 3, HILL);
  return {
    id: "isthmus",
    name: "The Isthmus",
    grid: g,
    // Player A gets the left mass, Player B the right mass.
    zoneA: { x: 2, y: 4, w: 10, h: 22 },
    zoneB: { x: 18, y: 4, w: 10, h: 22 },
  };
}

// ---------------------------------------------------------------------------
// b) Archipelago — 3-4 disconnected land clusters.
// ---------------------------------------------------------------------------
function buildArchipelago() {
  const g = blankGrid();
  // Top-left cluster (A primary)
  fillRect(g, 2, 2, 9, 9, LAND);
  // Top-right cluster (B primary)
  fillRect(g, 19, 2, 9, 9, LAND);
  // Bottom-left cluster (A secondary)
  fillRect(g, 3, 19, 8, 8, LAND);
  // Bottom-right cluster (B secondary)
  fillRect(g, 19, 19, 8, 8, LAND);
  // Hills scattered
  fillRect(g, 4, 4, 2, 2, HILL);
  fillRect(g, 24, 22, 2, 2, HILL);
  return {
    id: "archipelago",
    name: "Archipelago",
    grid: g,
    // Player A gets the two left clusters, Player B the two right clusters.
    zoneA: { x: 2, y: 2, w: 9, h: 25 },
    zoneB: { x: 19, y: 2, w: 9, h: 25 },
  };
}

// ---------------------------------------------------------------------------
// c) Highland Basin — one large continuous landmass.
// ---------------------------------------------------------------------------
function buildHighlandBasin() {
  const g = blankGrid();
  // One big central landmass.
  fillRect(g, 3, 3, 24, 24, LAND);
  // Central hill cluster (visual only).
  fillRect(g, 12, 12, 6, 6, HILL);
  fillRect(g, 6, 20, 4, 4, HILL);
  fillRect(g, 20, 6, 4, 4, HILL);
  return {
    id: "highland",
    name: "Highland Basin",
    grid: g,
    // Split the single landmass into top strip (A) and bottom strip (B).
    zoneA: { x: 3, y: 3, w: 24, h: 9 },
    zoneB: { x: 3, y: 18, w: 24, h: 9 },
  };
}

const MAPS = {
  isthmus: buildIsthmus(),
  archipelago: buildArchipelago(),
  highland: buildHighlandBasin(),
};

// Public list used by the client to render the map-select menu.
const MAP_LIST = Object.values(MAPS).map((m) => ({ id: m.id, name: m.name }));

module.exports = {
  GRID_W,
  GRID_H,
  VOID,
  LAND,
  HILL,
  MAPS,
  MAP_LIST,
};
