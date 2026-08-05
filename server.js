import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 10000);
const rooms = new Map();

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
  response.end(JSON.stringify({ ok: true, service: "star-race-server", rooms: rooms.size }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  let currentRoom = "";
  let currentPlayer = "";

  socket.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "join") {
        currentRoom = clean(data.room, 6).toUpperCase() || "STAR01";
        currentPlayer = clean(data.playerId, 48);
        if (!currentPlayer) return;
        const room = getRoom(currentRoom);
        room.players.set(currentPlayer, {
          id: currentPlayer,
          name: clean(data.name, 16) || "ผู้เล่น",
          color: /^#[0-9a-f]{6}$/i.test(data.color ?? "") ? data.color : "#4dabf7",
          score: room.players.get(currentPlayer)?.score ?? 0,
          socket,
        });
        broadcast(currentRoom);
      }

      if (data.type === "hit" && currentRoom && Number(data.round) === getRoom(currentRoom).round) {
        const room = getRoom(currentRoom);
        const player = room.players.get(currentPlayer);
        if (!player) return;
        player.score += 1;
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
