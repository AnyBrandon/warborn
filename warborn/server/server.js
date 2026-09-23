/**
 * server.js — Warborn Phase 1 entry point.
 *
 * One process, one port:
 *   - Express serves the static client from /public.
 *   - The `ws` WebSocket server shares the SAME HTTP server (Render free tier
 *     exposes a single port), handling the upgrade on that server.
 *
 * All authoritative game state lives in memory (rooms map). No database.
 */

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const gl = require("./gameLogic");
const { MAP_LIST } = require("./maps");

const PORT = process.env.PORT || 3000;
const DISCONNECT_GRACE_MS = 60000; // 60s reconnect grace period

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- In-memory state ---------------------------------------------------------
// rooms: roomCode -> match (from gameLogic.createMatch)
const rooms = new Map();
// socket -> { roomCode, playerId }
const socketMeta = new Map();
// playerId -> socket (so we can push per-player views)
const playerSockets = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makePlayerId() {
  return "p_" + Math.random().toString(36).slice(2, 10);
}

function send(socket, msg) {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function sendError(socket, error) {
  send(socket, { type: "error", error });
}

// Push each player their own fog-of-war view of the match.
function broadcastState(match) {
  for (const playerId of Object.keys(match.players)) {
    const sock = playerSockets.get(playerId);
    if (sock) {
      send(sock, { type: "state", view: gl.buildPlayerView(match, playerId) });
    }
  }
}

// --- Turn timer --------------------------------------------------------------
// Start the 30s timer for the CURRENT active player's turn. On expiry, that
// player forfeits the turn (no action) and play passes to the opponent.
function startTurnTimer(match) {
  clearTurnTimer(match);
  match.turnDeadline = Date.now() + gl.TURN_TIME_MS;
  match.turnTimer = setTimeout(() => {
    if (match.phase !== "battle") return;
    const result = gl.timeoutTurn(match); // passes turn to opponent
    broadcastActionResult(match, result);
    if (match.phase === "battle") startTurnTimer(match);
  }, gl.TURN_TIME_MS);
}

function clearTurnTimer(match) {
  if (match.turnTimer) {
    clearTimeout(match.turnTimer);
    match.turnTimer = null;
  }
}

// Broadcast a single resolved action (fire/reposition/pass) + fresh per-player
// view to both clients. Handles game-over messaging.
function broadcastActionResult(match, result) {
  for (const playerId of Object.keys(match.players)) {
    const sock = playerSockets.get(playerId);
    if (sock) {
      send(sock, {
        type: "action_result",
        result,
        view: gl.buildPlayerView(match, playerId),
      });
    }
  }
  if (match.phase === "over") {
    for (const playerId of Object.keys(match.players)) {
      const sock = playerSockets.get(playerId);
      const view = gl.buildPlayerView(match, playerId);
      send(sock, {
        type: "game_over",
        winner: match.winner,
        youWon: view.slot === match.winner,
      });
    }
  }
}

// --- Message handlers --------------------------------------------------------
function handleMessage(socket, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendError(socket, "Bad JSON");
  }

  switch (msg.type) {
    case "create_room":
      return onCreateRoom(socket);
    case "join_room":
      return onJoinRoom(socket, msg);
    case "reconnect":
      return onReconnect(socket, msg);
    case "select_map":
      return onSelectMap(socket, msg);
    case "place_tank":
      return onPlaceTank(socket, msg);
    case "ready":
      return onReady(socket);
    case "submit_action":
      return onSubmitAction(socket, msg);
    case "play_again":
      return onPlayAgain(socket);
    default:
      return sendError(socket, "Unknown message type: " + msg.type);
  }
}

function onCreateRoom(socket) {
  const roomCode = makeRoomCode();
  const match = gl.createMatch(roomCode);
  rooms.set(roomCode, match);

  const playerId = makePlayerId();
  const slot = gl.addPlayer(match, playerId);
  socketMeta.set(socket, { roomCode, playerId });
  playerSockets.set(playerId, socket);

  send(socket, {
    type: "joined",
    roomCode,
    playerId,
    slot,
    maps: MAP_LIST,
    roster: gl.TANK_ROSTER,
    turnTimeMs: gl.TURN_TIME_MS,
  });
  broadcastState(match);
}

function onJoinRoom(socket, msg) {
  const roomCode = (msg.roomCode || "").toUpperCase().trim();
  const match = rooms.get(roomCode);
  if (!match) return sendError(socket, "Room not found");
  if (Object.keys(match.players).length >= 2) {
    return sendError(socket, "Room is full");
  }

  const playerId = makePlayerId();
  const slot = gl.addPlayer(match, playerId);
  if (!slot) return sendError(socket, "Room is full");

  socketMeta.set(socket, { roomCode, playerId });
  playerSockets.set(playerId, socket);

  send(socket, {
    type: "joined",
    roomCode,
    playerId,
    slot,
    maps: MAP_LIST,
    roster: gl.TANK_ROSTER,
    turnTimeMs: gl.TURN_TIME_MS,
  });
  broadcastState(match);
}

// Reconnect within the grace period: rebind an existing playerId to a new socket.
function onReconnect(socket, msg) {
  const { roomCode, playerId } = msg;
  const match = rooms.get(roomCode);
  if (!match || !match.players[playerId]) {
    // Stale session (match ended, or never existed here). Tell the client to
    // clear its saved session and return to the lobby to join fresh.
    return send(socket, { type: "reconnect_failed" });
  }
  const player = match.players[playerId];
  // Guard against a DUPLICATED TAB (sessionStorage is copied into the new tab)
  // reconnecting with the SAME playerId as a still-connected socket. Without
  // this, both tabs would share one slot/zone — which looked like "both players
  // deploying on the same zone." Reject the hijack; the new tab must join fresh.
  if (player.connected && playerSockets.has(playerId)) {
    return send(socket, { type: "reconnect_failed", reason: "already_active" });
  }
  player.connected = true;
  if (match.disconnectTimers && match.disconnectTimers[playerId]) {
    clearTimeout(match.disconnectTimers[playerId]);
    delete match.disconnectTimers[playerId];
  }
  socketMeta.set(socket, { roomCode, playerId });
  playerSockets.set(playerId, socket);

  send(socket, {
    type: "joined",
    roomCode,
    playerId,
    slot: player.slot,
    maps: MAP_LIST,
    roster: gl.TANK_ROSTER,
    turnTimeMs: gl.TURN_TIME_MS,
    reconnected: true,
  });
  broadcastState(match);
  // Let the other player know the opponent is back.
  broadcastOpponentPresence(match);
}

function onSelectMap(socket, msg) {
  const meta = socketMeta.get(socket);
  if (!meta) return sendError(socket, "Not in a room");
  const match = rooms.get(meta.roomCode);
  if (!match) return sendError(socket, "Room not found");

  const player = match.players[meta.playerId];
  // Phase 1: Player A's choice is authoritative.
  if (player.slot !== "A") {
    return sendError(socket, "Only Player A selects the map");
  }
  const res = gl.selectMap(match, msg.mapId);
  if (!res.ok) return sendError(socket, res.error);
  broadcastState(match);
}

function onPlaceTank(socket, msg) {
  const meta = socketMeta.get(socket);
  if (!meta) return sendError(socket, "Not in a room");
  const match = rooms.get(meta.roomCode);
  if (!match) return sendError(socket, "Room not found");

  const res = gl.placeTank(
    match,
    meta.playerId,
    msg.tankId,
    msg.position,
    msg.rotation || 0
  );
  if (!res.ok) return sendError(socket, res.error);
  // Only this player needs the update (their own board), but state is cheap.
  const sock = playerSockets.get(meta.playerId);
  send(sock, { type: "state", view: gl.buildPlayerView(match, meta.playerId) });
}

function onReady(socket) {
  const meta = socketMeta.get(socket);
  if (!meta) return sendError(socket, "Not in a room");
  const match = rooms.get(meta.roomCode);
  if (!match) return sendError(socket, "Room not found");

  const res = gl.setReady(match, meta.playerId);
  if (!res.ok) return sendError(socket, res.error);

  broadcastState(match);
  if (res.bothReady) {
    // Battle begins — kick off the first turn timer.
    startTurnTimer(match);
    broadcastState(match);
  }
}

function onSubmitAction(socket, msg) {
  const meta = socketMeta.get(socket);
  if (!meta) return sendError(socket, "Not in a room");
  const match = rooms.get(meta.roomCode);
  if (!match) return sendError(socket, "Room not found");

  // Alternating turns: the active player's action resolves immediately, then
  // the turn passes. Restart the timer for the new active player.
  const res = gl.submitAction(match, meta.playerId, msg);
  if (!res.ok) return sendError(socket, res.error);

  clearTurnTimer(match);
  broadcastActionResult(match, res.result);
  if (match.phase === "battle") startTurnTimer(match);
}

function onPlayAgain(socket) {
  const meta = socketMeta.get(socket);
  if (!meta) return sendError(socket, "Not in a room");
  const match = rooms.get(meta.roomCode);
  if (!match) return sendError(socket, "Room not found");

  clearTurnTimer(match);
  gl.resetMatch(match);
  broadcastState(match);
}

// Tell both players about opponent connection status (for the pause overlay).
function broadcastOpponentPresence(match) {
  for (const playerId of Object.keys(match.players)) {
    const sock = playerSockets.get(playerId);
    const me = match.players[playerId];
    const opp = gl.getPlayerBySlot(match, gl.opponentSlot(me.slot));
    send(sock, {
      type: "opponent_presence",
      connected: opp ? opp.connected : false,
    });
  }
}

// --- Disconnect handling -----------------------------------------------------
function handleDisconnect(socket) {
  const meta = socketMeta.get(socket);
  socketMeta.delete(socket);
  if (!meta) return;

  const match = rooms.get(meta.roomCode);
  if (!match) return;
  const player = match.players[meta.playerId];
  if (!player) return;

  player.connected = false;
  playerSockets.delete(meta.playerId);

  // If in an active match, pause and start a grace timer before ending.
  if (match.phase === "deploy" || match.phase === "battle") {
    clearTurnTimer(match); // pause the round while opponent is gone
    broadcastOpponentPresence(match);

    if (!match.disconnectTimers) match.disconnectTimers = {};
    match.disconnectTimers[meta.playerId] = setTimeout(() => {
      // Grace expired — end the match, award win to the remaining player.
      if (!player.connected) {
        const opp = gl.getPlayerBySlot(match, gl.opponentSlot(player.slot));
        match.phase = "over";
        match.winner = opp ? opp.slot : null;
        for (const pid of Object.keys(match.players)) {
          const s = playerSockets.get(pid);
          if (s) {
            send(s, {
              type: "game_over",
              winner: match.winner,
              youWon: match.players[pid].slot === match.winner,
              reason: "opponent_disconnected",
            });
          }
        }
      }
    }, DISCONNECT_GRACE_MS);
  } else {
    // In lobby: just clean up empty rooms.
    const anyConnected = Object.values(match.players).some((p) => p.connected);
    if (!anyConnected) rooms.delete(meta.roomCode);
  }
}

// --- WebSocket wiring --------------------------------------------------------
wss.on("connection", (socket) => {
  socket.on("message", (data) => handleMessage(socket, data.toString()));
  socket.on("close", () => handleDisconnect(socket));
  socket.on("error", () => handleDisconnect(socket));
});

server.listen(PORT, () => {
  console.log(`Warborn server listening on port ${PORT}`);
});
