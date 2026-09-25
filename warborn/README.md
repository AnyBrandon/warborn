# Warborn — Phase 1

Tank-themed real-time multiplayer strategy game (Battleship-inspired). Phase 1 delivers the complete, deployable core loop: lobby, deployment, simultaneous commit-then-resolve turns, and win detection over real WebSocket multiplayer.

## Structure

```
/server
  server.js      Express static host + ws WebSocket server (one process, one port)
  gameLogic.js   Authoritative game state & rules engine
  maps.js        Assembles the 4 preset templates from baked data + zones
  mapData.js     BAKED static tile arrays (generated — do not hand-edit)
  mapgen/
    generate.js  Offline noise-based map generator (not used at runtime)
  test.js        Engine sanity checks (node server/test.js)
/public
  index.html     Single self-contained client (Three.js via CDN)
render.yaml      Render.com free-tier Web Service config
package.json
```

## Run locally

```
npm install
npm start
```

Open http://localhost:3000 in two browser tabs (or two machines). In tab 1 click **Create Room**, copy the 4-char code, then in tab 2 enter it and click **Join Room**.

## Gameplay

- Player A picks the map (authoritative in Phase 1).
- Both players deploy 10 units in their own zone: tap/click a unit in the tray, tap a tile, use **Rotate** (or press **R**) to turn it. Tap **Ready**.
- Roster (10 units): 1 Command Tank, 2 Heavy, 3 Medium, 3 Light, and 1 **Transportation Plane** (2x2, non-combat — it can't fire but is placeable/targetable/sinkable).
- Turns are **strict alternating** (Phase 2). A random player goes first, then players take turns one at a time. On your turn you pick ONE action (Fire, or Reposition if your plane is alive) and it resolves immediately. A 45s timer runs on the active player's turn only; if it expires you forfeit that turn and play passes to the opponent. The HUD shows whose turn it is.
- **Transportation Plane gating**: you may only Reposition while your plane is alive. Once your plane is fully sunk, Reposition is permanently disabled (Fire remains). Enforced server-side.
- **Weapons** (Fire picks one of three, all resolve instantly, all server-authoritative):
  - **Tank Shoot** — baseline, always available, unlimited. Hits 1 tile.
  - **Missile** — requires a living Heavy Tank; 3 uses per game; can't be used two of your turns in a row. Hits a 5-tile cross (center + 4 orthogonal neighbours, no diagonals).
  - **Ballistic Missile** — requires a living Command Tank; 1 use per game. Hits an 8-pointed star: 4 lines through the center (horizontal, vertical, both diagonals), each extending 3 tiles out in both directions (25 tiles max).
  - Splash tiles outside the enemy zone or off-map are skipped. Each affected tile resolves as an independent hit/miss. Unavailable weapons are greyed out in the UI with the reason shown.
- **Smoke Round** — 3 charges per game, max 1 per turn, gated on a living Transportation Plane (like Reposition). Place on a tile in your own zone: any shot landing there always misses and pops the smoke (that tile reverts to normal afterward). Smoke is a hidden trap — the enemy never sees it on their fog-of-war view. You can't stack a new charge on a tile with active smoke.
- **Recon Sweep** — 1 use per game; costs your turn. Pick a 4x4 area of the enemy zone (live preview as you aim); get a binary "occupied / empty" result only (never which tile). Themed as a cyber-intrusion: the attacker sees a ~5s hacking-terminal sequence, the defender simultaneously gets an intrusion-detected alert, and both wait for a manual Acknowledge to dismiss. The scanned 4x4 area is marked persistently on your own map (owner-only).
- **Hit/miss markers** — every previously-fired-upon tile shows a marker to both players on their respective views: red dot for a hit, black dot for a miss. You cannot reposition a unit onto any tile already fired upon on your own board (hit or miss).
- **Terrain effects** — maps now include Forest and Mud tiles alongside land/hill/void:
  - Forest: a unit on a Forest tile has a 25% chance (`FOREST_CAMO_MISS_CHANCE`) to auto-miss an incoming single-tile **Tank Shoot** (camouflage). Does not apply to Missile/Ballistic splash.
  - Mud: a valid deployment tile, but units can never be **repositioned** onto Mud.
  - Hill: terrain-visual only (no gameplay effect this phase — no vision system exists to hook into).
- **Surrender** — a Surrender button is available during battle. Confirming ends the match immediately (server-authoritative): the opponent wins and both players see the normal win/lose screen.
- **Command Tank double-shot** — while your Command Tank has never been hit, you fire 2 Tank Shoots in a single turn (Tank Shoot only, not Missile/Ballistic). The perk is lost permanently the instant the Command Tank takes its first hit (even if not sunk). Shown in the HUD.
- Battle is shown on ONE unified map (same landmass as deploy): your units are fully visible in your zone, the enemy zone is fog-of-war in its real position (only hit/miss markers on tiles you've fired at; sunk enemy units are revealed). Tap an enemy-zone tile to aim, then Confirm to fire.
- A unit sinks when all its footprint tiles are hit. Wipe out all 10 enemy units to win.

## Cross-platform (desktop / tablet / mobile)

Works in-browser on desktop, tablet, and phones — no native app.

- Responsive layout: the deploy tray is a side panel on wide screens and a scrollable bottom drawer on narrow/portrait phones. Fonts, tap targets, and the action bar reflow fluidly. Safe-area insets are respected on notched phones.
- Unified input via Pointer Events (mouse + touch + stylus, one code path). Camera drag/pinch is handled by OrbitControls (one finger orbit, two finger pinch-zoom/pan). On-screen **+/−** zoom buttons are available as a pinch alternative.
- Tap-vs-drag detection: a small movement counts as a tile tap; a larger drag moves the camera, so camera panning never mis-selects a tile.
- Touch-safe combat: firing is tap-to-aim then **Confirm** (no accidental single-tap misfires). Reposition is tap-tank, tap-destination, **Confirm**, with a **Rotate** button.
- Verified layouts at ~375px (phone portrait), ~768px (tablet portrait), and 1280px+ (desktop) via the browser device toolbar.

## Deploy to Render

1. Push this folder to a GitHub repo.
2. In Render, create a new **Web Service** from the repo (free tier). The included `render.yaml` sets it up automatically (Blueprint), or configure manually:
   - Build Command: `npm install`
   - Start Command: `node server/server.js`
3. No database or add-ons needed.

### Environment variables / settings

- **PORT** — do NOT set this manually. Render injects it automatically and the server reads `process.env.PORT`.
- **NODE_VERSION** — set in `render.yaml` (20.11.1). Adjust in the dashboard if desired.
- No secrets or other env vars are required for Phase 1.

Note: the free tier sleeps after inactivity; the first request after idle may take ~30s to spin up. WebSocket upgrades share the same HTTP port, so no extra networking config is needed.

## Maps

The board is a **70x60** tile grid. There are four preset templates with organic, noise-generated coastlines (bays, peninsulas, inlets, islands):

- **The Isthmus** — two major landmasses joined by a narrow land bridge chokepoint.
- **Archipelago** — several distinct disconnected islands.
- **Highland Basin** — one large continuous landmass with a ring of hills around a lower central plain.
- **Squid** — a single irregular, multi-lobed continent with jagged bays and tentacle-like inlets, an enclosed inland lake, and winding river-like hill lines. Deployment zones sit in the northern and southern lobes with a wide neutral hilly middle.

Each map defines two deployment zones (one per player) in separate regions of contiguous land with a neutral buffer between them.

### Regenerating maps

Tile data is baked (deterministic, no runtime randomness). To change or regenerate maps:

```
node server/mapgen/generate.js --ascii    # visually inspect
node server/mapgen/generate.js --stats     # land/hill/void counts
node server/mapgen/generate.js --write      # (re)write server/mapData.js
```

The generator uses seeded value-noise + per-template shaping masks, keeps the largest connected land component(s), and adds hills via a second noise pass. Seeds are fixed per template so output is deterministic.

### Grid size sync

`GRID_W`/`GRID_H` must stay in sync between `server/mapData.js` (source of truth, consumed by `maps.js`) and the client constant in `public/index.html` (search for `must match server`). The client camera framing auto-fits to the grid/zone size, so no manual zoom tuning is needed when the grid changes.

## Assets & cinematics

- Units render from real `.glb` models (`public/assets/tanks/`) loaded once via GLTFLoader and cloned per instance, auto-scaled to their footprint. A colored ground ring under each unit preserves the mine/class distinction regardless of the model's baked materials. If a model fails to load, the game falls back to the procedural low-poly mesh.
- Forest tiles are decorated with a sparse, deterministic scatter of tree models (`public/assets/terrain/tree1-3.glb`) — purely cosmetic.
- Cinematic popups (presentational only, never block resolution):
  - Ballistic Missile: the firing player sees a launch video; the target sees a dramatic "incoming strike" warning; the impact effect is an intensified multi-shockwave blast with camera shake.
  - Reposition: the acting player sees a "REPOSITIONING UNIT" tactical popup; the opponent sees a reposition video.
  - Victory/Defeat: the winner sees a victory video, the loser a dramatic defeat popup, before the normal win/lose screen.
