/**
 * generate.js — OFFLINE map generator for Warborn.
 *
 * NOT used at runtime. Run manually:  node server/mapgen/generate.js
 * It produces organic, noise-based landmasses at the target grid size and
 * prints baked tile arrays (0=void, 1=land, 2=hill) that we paste into maps.js.
 *
 * Determinism: everything is driven by a seeded PRNG, so a given seed always
 * yields the same map. We bake the OUTPUT (static arrays) into maps.js — there
 * is no runtime randomness in the game.
 *
 * Technique: value-noise (a few octaves of smoothed lattice noise) thresholded
 * into land, multiplied by a radial/shaped falloff mask per template to control
 * the silhouette (two lobes for Isthmus, scattered blobs for Archipelago, one
 * big mass for Highland, a convoluted multi-lobe mass for Squid). Then we keep
 * the largest connected land component(s), and add hills via a second noise pass.
 */

const GRID_W = 70;
const GRID_H = 60;
const VOID = 0, LAND = 1, HILL = 2, FOREST = 3, MUD = 4;

// ---- Seeded PRNG (mulberry32) ------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Value noise -------------------------------------------------------------
// Build a lattice of random values, sample with smooth interpolation.
function makeNoise(rand, cells) {
  const g = [];
  for (let y = 0; y <= cells + 1; y++) {
    const row = [];
    for (let x = 0; x <= cells + 1; x++) row.push(rand());
    g.push(row);
  }
  const smooth = (t) => t * t * (3 - 2 * t); // smoothstep
  const lerp = (a, b, t) => a + (b - a) * t;
  return function (nx, ny) {
    // nx, ny in [0,1); scale to lattice
    const fx = nx * cells, fy = ny * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = smooth(fx - x0), ty = smooth(fy - y0);
    const v00 = g[y0][x0], v10 = g[y0][x0 + 1];
    const v01 = g[y0 + 1][x0], v11 = g[y0 + 1][x0 + 1];
    return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
  };
}

// Fractal noise: sum several octaves of value noise.
function fractal(rand, octaves, baseCells) {
  const layers = [];
  let cells = baseCells, amp = 1, totalAmp = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ noise: makeNoise(rand, cells), amp });
    totalAmp += amp;
    cells *= 2; amp *= 0.5;
  }
  return function (nx, ny) {
    let sum = 0;
    for (const l of layers) sum += l.noise(nx, ny) * l.amp;
    return sum / totalAmp;
  };
}

// ---- Grid helpers ------------------------------------------------------------
function blank() {
  const g = [];
  for (let y = 0; y < GRID_H; y++) g.push(new Array(GRID_W).fill(VOID));
  return g;
}

// Keep only the largest N connected land components (flood fill), void the rest.
function keepLargestComponents(grid, n) {
  const seen = grid.map((row) => row.map(() => false));
  const comps = [];
  const stack = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (grid[y][x] !== VOID && !seen[y][x]) {
        const cells = [];
        stack.push([x, y]); seen[y][x] = true;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          cells.push([cx, cy]);
          const nb = [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
          for (const [ax, ay] of nb) {
            if (ax >= 0 && ax < GRID_W && ay >= 0 && ay < GRID_H &&
                !seen[ay][ax] && grid[ay][ax] !== VOID) {
              seen[ay][ax] = true; stack.push([ax, ay]);
            }
          }
        }
        comps.push(cells);
      }
    }
  }
  comps.sort((a, b) => b.length - a.length);
  const keep = new Set();
  for (let i = 0; i < Math.min(n, comps.length); i++) {
    for (const [x, y] of comps[i]) keep.add(x + "," + y);
  }
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (!keep.has(x + "," + y)) grid[y][x] = VOID;
}

// Add hills where a second noise field is high AND tile is land.
function addHills(grid, hillNoise, threshold) {
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (grid[y][x] === LAND && hillNoise(x / GRID_W, y / GRID_H) > threshold)
        grid[y][x] = HILL;
}

// Scatter clustered patches of a terrain type onto plain LAND tiles using a
// dedicated noise field. Only converts LAND (leaves hills/void/existing terrain
// alone) so features read as distinct patches, not overwriting each other.
function addTerrain(grid, type, noise, threshold) {
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (grid[y][x] === LAND && noise(x / GRID_W, y / GRID_H) > threshold)
        grid[y][x] = type;
}

// Apply forest + mud patches to a finished land/hill grid. Uses distinct seeds
// so the two features don't correlate. Thresholds tuned to be "meaningful
// features, not map-covering" (~8-12% of land each).
function addForestAndMud(grid, seed) {
  addTerrain(grid, FOREST, fractal(mulberry32(seed + 101), 4, 8), 0.72);
  addTerrain(grid, MUD, fractal(mulberry32(seed + 211), 4, 9), 0.72);
}

// Radial falloff: 1 at (cx,cy), fading to 0 at radius r. Elliptical via sx,sy.
function radial(x, y, cx, cy, r, sx = 1, sy = 1) {
  const dx = (x - cx) / sx, dy = (y - cy) / sy;
  const d = Math.sqrt(dx * dx + dy * dy) / r;
  return Math.max(0, 1 - d);
}

// ---- Template generators -----------------------------------------------------
// Each returns { grid, zoneA, zoneB }. Seeds chosen by inspecting output.

function genIsthmus(seed) {
  const rand = mulberry32(seed);
  const noise = fractal(rand, 4, 3);
  const g = blank();
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      // Two big elliptical lobes (left & right). Radii grown modestly for ~25%
      // more land: radius 22->23.5, sy 1.35->1.42. The noise only perturbs the
      // coastline, it can't erase a lobe.
      const left = radial(x, y, 16, 30, 24, 1.0, 1.46);
      const right = radial(x, y, 54, 30, 24, 1.0, 1.46);
      let mask = Math.max(left, right);
      // Bridge: a narrow guaranteed chokepoint across the waist (UNCHANGED size).
      // Only the central rows get a boost, so it reads as an isthmus, not a band.
      if (y >= 28 && y <= 31) {
        const bridge = 0.72 - Math.abs(y - 29.5) * 0.06;
        mask = Math.max(mask, bridge);
      }
      const v = noise(x / GRID_W, y / GRID_H) * 0.4 + mask * 0.75;
      if (v > 0.58) g[y][x] = LAND;
    }
  }
  keepLargestComponents(g, 1);
  addHills(g, fractal(mulberry32(seed + 7), 3, 5), 0.66);
  return {
    grid: g,
    // Zones widened/heightened slightly to capture the larger lobe extent.
    zoneA: { x: 3, y: 12, w: 24, h: 36 },
    zoneB: { x: 43, y: 12, w: 24, h: 36 },
  };
}

function genArchipelago(seed) {
  const rand = mulberry32(seed);
  const noise = fractal(rand, 5, 4);
  const g = blank();
  // MUCH larger islands (bigger radii) pulled CLOSER together (blob centers
  // moved toward the middle) so the map is compact/playable, not empty ocean.
  const blobs = [
    [18, 14, 19], [19, 44, 18],   // left cluster (Player A) — radii +~1
    [51, 14, 19], [50, 45, 18],   // right cluster (Player B)
  ];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      let mask = 0;
      for (const [bx, by, br] of blobs) mask = Math.max(mask, radial(x, y, bx, by, br));
      // Slightly denser islands (more deployable land) without moving the
      // clusters or growing the neutral gap.
      const v = noise(x / GRID_W, y / GRID_H) * 0.4 + mask * 0.92;
      if (v > 0.585) g[y][x] = LAND;
    }
  }
  keepLargestComponents(g, 4); // keep the several distinct islands
  addHills(g, fractal(mulberry32(seed + 7), 3, 6), 0.72);
  return {
    grid: g,
    // Width grown a little (30->32) with a central gap preserved; height near
    // the grid limit stays ~54.
    zoneA: { x: 1, y: 3, w: 32, h: 54 },
    zoneB: { x: 37, y: 3, w: 32, h: 54 },
  };
}

function genHighland(seed) {
  const rand = mulberry32(seed);
  const noise = fractal(rand, 4, 3);
  const g = blank();
  const cx = 35, cy = 29.5; // center between rows 29 and 30 for clean symmetry
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      // Taller basin (sy 1.0->1.06) grown vertically toward the (slightly
      // slimmer) neutral band, for ~25% more land while keeping the character.
      const mask = radial(x, y, cx, cy, 30, 1.15, 1.06);
      const v = noise(x / GRID_W, y / GRID_H) * 0.45 + mask * 0.76;
      if (v > 0.545) g[y][x] = LAND;
    }
  }
  // Force VERTICAL SYMMETRY so both player zones get identical land. A tile is
  // land if EITHER it or its mirror across the horizontal center-line is land.
  // This guarantees zoneA (top) and zoneB (bottom) are balanced by construction.
  for (let y = 0; y < GRID_H / 2; y++) {
    const my = GRID_H - 1 - y;
    for (let x = 0; x < GRID_W; x++) {
      const land = g[y][x] !== VOID || g[my][x] !== VOID;
      g[y][x] = land ? LAND : VOID;
      g[my][x] = land ? LAND : VOID;
    }
  }
  keepLargestComponents(g, 1);
  // Ring of hills around a lower central plain: hills where the (elliptical)
  // distance from center falls in a mid band. Distance is symmetric about the
  // center-line, so the ring stays balanced top/bottom.
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (g[y][x] !== LAND) continue;
      const dx = (x - cx) / 1.15, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 15 && d < 22) g[y][x] = HILL; // ring band -> hills
    }
  }
  return {
    grid: g,
    // BALANCED, mirrored player zones grown in HEIGHT (24->26), symmetric about
    // y=29.5: top y 2-27, bottom y 32-57. Neutral band stays ~rows 28-31,
    // keeping the ring-of-hills basin character.
    zoneA: { x: 5, y: 2, w: 60, h: 26 },
    zoneB: { x: 5, y: 32, w: 60, h: 26 },
  };
}

function genSquid(seed) {
  const rand = mulberry32(seed);
  // Higher frequency + more octaves => convoluted, tentacled coastline.
  const noise = fractal(rand, 6, 6);
  const g = blank();
  const cx = 35, cy = 30;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      // Soft central mask so tentacles can reach outward. Grown slightly
      // vertically (sy 1.0->1.05) for ~25% more deployable land per lobe,
      // keeping the tentacled/inlet character.
      const mask = radial(x, y, cx, cy, 34, 1.05, 1.05);
      const v = noise(x / GRID_W, y / GRID_H) * 0.62 + mask * 0.56;
      if (v > 0.585) g[y][x] = LAND;
    }
  }
  keepLargestComponents(g, 1);

  // Enclosed inland lake: carve a void pocket well inside the landmass, then
  // ensure it is fully surrounded by land (it will be, being interior).
  for (let y = 22; y < 30; y++)
    for (let x = 30; x < 40; x++)
      if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) {
        // rough oval
        const dx = (x - 35) / 5, dy = (y - 26) / 3.2;
        if (dx * dx + dy * dy < 1) g[y][x] = VOID;
      }

  // A couple of winding river-like hill lines cutting inward from the coast.
  const river = (pts) => {
    for (const [x, y] of pts)
      if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H && g[y][x] === LAND) g[y][x] = HILL;
  };
  // hand-traced winding paths (baked, deterministic)
  river([[12,12],[13,13],[14,14],[15,15],[16,15],[17,16],[18,17],[19,18],[20,18],[21,19],[22,20]]);
  river([[58,46],[57,45],[56,44],[55,44],[54,43],[53,42],[52,42],[51,41],[50,40],[49,40]]);
  river([[40,8],[40,9],[41,10],[41,11],[42,12],[42,13],[43,14],[43,15]]);

  // Neutral middle terrain: an even NARROWER band of hills across the waist,
  // pushed further so the player lobes take more of the map. Rows 28-31 only.
  const hillNoise = fractal(mulberry32(seed + 11), 4, 7);
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (g[y][x] === LAND && y >= 28 && y <= 31 && hillNoise(x / GRID_W, y / GRID_H) > 0.4)
        g[y][x] = HILL;

  return {
    grid: g,
    // North lobe vs south lobe. Zones grown in HEIGHT (25->27) reaching a little
    // further toward the center; the hill waist band (rows 28-31) is unchanged.
    zoneA: { x: 6, y: 1, w: 58, h: 27 },
    zoneB: { x: 6, y: 32, w: 58, h: 27 },
  };
}

// ---- Output ------------------------------------------------------------------
function toJS(name, def) {
  // Compact each row as a run-length-free flat array string to keep file size
  // reasonable while staying human-diffable.
  const rows = def.grid.map((row) => "    [" + row.join(",") + "]").join(",\n");
  return (
`  ${name}: {
    grid: [
${rows}
    ],
    zoneA: ${JSON.stringify(def.zoneA)},
    zoneB: ${JSON.stringify(def.zoneB)},
  },`
  );
}

// Emit a complete, static, committable data module (baked — no runtime RNG).
function emitModule() {
  const parts = Object.entries(maps).map(([k, v]) => toJS(k, v));
  return (
`/**
 * mapData.js — BAKED static map tile data for Warborn.
 *
 * GENERATED by server/mapgen/generate.js (offline). Do NOT hand-edit; re-run
 * the generator and re-bake if you want to change a map. No runtime randomness:
 * these are frozen tile arrays (0=void, 1=land, 2=hill) at ${GRID_W}x${GRID_H}.
 */
module.exports = {
  GRID_W: ${GRID_W},
  GRID_H: ${GRID_H},
  DATA: {
${parts.join("\n")}
  },
};
`
  );
}

function stats(def) {
  let land = 0, hill = 0, voidc = 0, forest = 0, mud = 0;
  for (const row of def.grid) for (const t of row) {
    if (t === LAND) land++;
    else if (t === HILL) hill++;
    else if (t === FOREST) forest++;
    else if (t === MUD) mud++;
    else voidc++;
  }
  return { land, hill, forest, mud, void: voidc };
}

const maps = {
  isthmus: genIsthmus(1337),
  archipelago: genArchipelago(4242),
  highland: genHighland(2024),
  squid: genSquid(9931),
};

// Overlay Forest + Mud patches onto every template (deterministic per seed).
const TERRAIN_SEEDS = { isthmus: 1337, archipelago: 4242, highland: 2024, squid: 9931 };
for (const [id, def] of Object.entries(maps)) {
  addForestAndMud(def.grid, TERRAIN_SEEDS[id]);
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--stats") {
    for (const [k, v] of Object.entries(maps)) console.error(k, stats(v));
  } else if (arg === "--zonestats") {
    // Deployable LAND (land+hill+forest+mud, i.e. any playable tile) inside each
    // player's zone rectangle — the true metric for zone deployable area.
    const zoneLand = (def, z) => {
      let n = 0;
      for (let y = z.y; y < z.y + z.h; y++)
        for (let x = z.x; x < z.x + z.w; x++) {
          const t = def.grid[y] && def.grid[y][x];
          if (t === LAND || t === HILL || t === FOREST || t === MUD) n++;
        }
      return n;
    };
    for (const [k, v] of Object.entries(maps)) {
      console.error(k, "zoneA=" + zoneLand(v, v.zoneA), "zoneB=" + zoneLand(v, v.zoneB));
    }
  } else if (arg === "--ascii") {
    // Visual inspection: print each map as ASCII.
    for (const [k, v] of Object.entries(maps)) {
      console.error("\n=== " + k + " ===");
      for (const row of v.grid)
        console.error(row.map((t) => (t === 0 ? "." : t === 1 ? "#" : t === 2 ? "^" : t === 3 ? "T" : "~")).join(""));
    }
  } else if (arg === "--write") {
    // Write the baked data module directly as UTF-8 (avoids shell BOM issues).
    const fs = require("fs");
    const path = require("path");
    const out = path.join(__dirname, "..", "mapData.js");
    fs.writeFileSync(out, emitModule(), "utf8");
    console.error("Wrote", out);
  } else {
    // Emit the baked data module to stdout.
    process.stdout.write(emitModule());
  }
}

module.exports = { GRID_W, GRID_H, maps, genIsthmus, genArchipelago, genHighland, genSquid };
