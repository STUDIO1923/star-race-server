import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 10000);
const rooms = new Map();
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseServiceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const persistenceEnabled = Boolean(supabaseUrl && supabaseServiceKey);

async function supabaseRequest(path, options = {}) {
  if (!persistenceEnabled) return null;
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: supabaseServiceKey,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}

async function authenticatedUser(accessToken) {
  if (!persistenceEnabled || !accessToken) return null;
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: supabaseServiceKey, authorization: `Bearer ${accessToken}` },
  });
  return response.ok ? response.json() : null;
}

async function loadSave(userId) {
  const rows = await supabaseRequest(`/rest/v1/player_saves?user_id=eq.${encodeURIComponent(userId)}&select=total_stars,display_name&limit=1`);
  return rows?.[0] ?? { total_stars: 0 };
}

async function saveProgress(userId, name, totalStars) {
  await supabaseRequest("/rest/v1/player_saves?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: userId, display_name: name, total_stars: totalStars, updated_at: new Date().toISOString() }),
  });
}

function clean(value, max = 24) {
  return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max);
}
function randomPosition() {
  return 12 + Math.floor(Math.random() * 76);
}
function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { targetX: randomPosition(), targetY: randomPosition(), round: 1, players: new Map() });
  return rooms.get(code);
}
function snapshot(code, winnerId) {
  const room = getRoom(code);
  return {
    type: "state",
    room: code,
    targetX: room.targetX,
    targetY: room.targetY,
    round: room.round,
    winnerId,
    players: [...room.players.values()].map(({ socket, ...player }) => player).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
  };
}
function broadcast(code, winnerId) {
  const message = JSON.stringify(snapshot(code, winnerId));
  for (const player of getRoom(code).players.values()) {
    if (player.socket.readyState === WebSocket.OPEN) player.socket.send(message);
  }
}

const server = http.createServer((request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ ok: true, service: "star-race-server", rooms: rooms.size, persistence: persistenceEnabled ? "supabase" : "memory" }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  let currentRoom = "";
  let currentPlayer = "";

  socket.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "join") {
        const user = await authenticatedUser(data.accessToken);
        currentRoom = clean(data.room, 6).toUpperCase() || "STAR01";
        currentPlayer = user?.id || clean(data.playerId, 48);
        if (!currentPlayer) return;
        const room = getRoom(currentRoom);
        const saved = user ? await loadSave(user.id) : { total_stars: 0 };
        room.players.set(currentPlayer, {
          id: currentPlayer,
          name: clean(data.name, 16) || "ผู้เล่น",
          color: /^#[0-9a-f]{6}$/i.test(data.color ?? "") ? data.color : "#4dabf7",
          score: room.players.get(currentPlayer)?.score ?? 0,
          totalStars: Number(saved.total_stars || 0),
          authenticated: Boolean(user),
          socket,
        });
        broadcast(currentRoom);
      }

      if (data.type === "hit" && currentRoom && Number(data.round) === getRoom(currentRoom).round) {
        const room = getRoom(currentRoom);
        const player = room.players.get(currentPlayer);
        if (!player) return;
        player.score += 1;
        player.totalStars += 1;
        if (player.authenticated) await saveProgress(player.id, player.name, player.totalStars);
        room.round += 1;
        room.targetX = randomPosition();
        room.targetY = randomPosition();
        broadcast(currentRoom, currentPlayer);
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "invalid message" }));
    }
  });

  socket.on("close", () => {
    if (!currentRoom || !currentPlayer) return;
    const room = getRoom(currentRoom);
    room.players.delete(currentPlayer);
    if (room.players.size === 0) rooms.delete(currentRoom);
    else broadcast(currentRoom);
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Star Race server listening on ${port}`));
