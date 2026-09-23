# Warborn — Phase 1

Tank-themed real-time multiplayer strategy game (Battleship-inspired). Phase 1 delivers the complete, deployable core loop: lobby, deployment, simultaneous commit-then-resolve turns, and win detection over real WebSocket multiplayer.

## Structure

```
/server
  server.js      Express static host + ws WebSocket server (one process, one port)
  gameLogic.js   Authoritative game state & rules engine
  maps.js        3 preset map templates + deployment zones
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
- Both players deploy 10 tanks in their own zone: tap/click a tank in the tray, tap a tile, use **Rotate** (or press **R**) to turn it. Tap **Ready**.
- Each round both players secretly submit ONE action (Fire or Reposition) or let the 30s timer expire (auto-pass). The server resolves both at once: repositions first, then fire against the updated board.
- A tank sinks when all its footprint tiles are hit. Wipe out all 10 enemy tanks to win.

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
