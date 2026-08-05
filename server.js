import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const port = Number(process.env.PORT || 10000);
const rooms = new Map();
const GRID_W = 60;
const GRID_H = 40;
const FOOD_COUNT = 10;
const TICK_MS = 60;
const NORMAL_MOVE_MS = 125;
const BOOST_MOVE_MS = 65;
const BOOST_DURATION_MS = 5000;
const FRUIT_TYPES = [
  { kind: "apple", points: 1, growth: 2, weight: 34 },
  { kind: "orange", points: 1, growth: 2, weight: 26 },
  { kind: "grape", points: 2, growth: 3, weight: 18 },
  { kind: "banana", points: 2, growth: 3, weight: 14 },
  { kind: "watermelon", points: 3, growth: 4, weight: 8 },
];
const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseServiceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const persistenceEnabled = Boolean(supabaseUrl && supabaseServiceKey);
let soloLeaderboard = [];

async function supabaseRequest(path, options = {}) {
  if (!persistenceEnabled) return null;
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: { apikey: supabaseServiceKey, "content-type": "application/json", ...options.headers },
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
  const rows = await supabaseRequest(`/rest/v1/player_saves?user_id=eq.${encodeURIComponent(userId)}&select=total_stars,display_name,best_solo_length&limit=1`);
  return rows?.[0] ?? { total_stars: 0, best_solo_length: 0 };
}

async function refreshSoloLeaderboard() {
  if (!persistenceEnabled) return;
  const rows = await supabaseRequest("/rest/v1/player_saves?select=display_name,best_solo_length&best_solo_length=gt.0&order=best_solo_length.desc&limit=10");
  soloLeaderboard = (rows ?? []).map((row) => ({ name: row.display_name || "Player", length: Number(row.best_solo_length || 0) }));
}

function saveProgress(player) {
  if (!player.authenticated) return;
  supabaseRequest("/rest/v1/player_saves?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: player.id, display_name: player.name, total_stars: player.totalStars, best_solo_length: player.bestSoloLength || 0, updated_at: new Date().toISOString() }),
  }).then(() => player.mode === "solo" && refreshSoloLeaderboard()).catch(() => {});
}

function clean(value, max = 24) {
  return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max);
}

function freeCell(room) {
  const occupied = new Set([
    ...room.foods.map((c) => `${c.x},${c.y}`),
    ...room.boosts.map((c) => `${c.x},${c.y}`),
    ...[...room.players.values()].flatMap((p) => p.snake.map((c) => `${c.x},${c.y}`)),
  ]);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const cell = { x: 2 + Math.floor(Math.random() * (GRID_W - 4)), y: 2 + Math.floor(Math.random() * (GRID_H - 4)) };
    if (!occupied.has(`${cell.x},${cell.y}`)) return cell;
  }
  return { x: 3, y: 3 };
}

function spawnSnake(room) {
  const head = freeCell(room);
  const startX = Math.max(5, head.x);
  return [0, 1, 2, 3].map((offset) => ({ x: startX - offset, y: head.y }));
}

function randomFruit() {
  let roll = Math.random() * FRUIT_TYPES.reduce((sum, fruit) => sum + fruit.weight, 0);
  for (const fruit of FRUIT_TYPES) {
    roll -= fruit.weight;
    if (roll <= 0) return fruit;
  }
  return FRUIT_TYPES[0];
}

function addFood(room) {
  while (room.foods.length < FOOD_COUNT) {
    const cell = freeCell(room);
    room.foods.push({ ...cell, ...randomFruit() });
  }
}

function addBoost(room) {
  if (!room.boosts.length) room.boosts.push(freeCell(room));
}

function getRoom(code, mode = "online") {
  if (!rooms.has(code)) {
    const room = { players: new Map(), foods: [], boosts: [], mode };
    rooms.set(code, room);
    addFood(room);
    addBoost(room);
  }
  return rooms.get(code);
}

function snapshot(code, event) {
  const room = getRoom(code);
  return {
    type: "state", room: code, mode: room.mode, gridWidth: GRID_W, gridHeight: GRID_H, foods: room.foods, boosts: room.boosts, soloLeaderboard, event,
    players: [...room.players.values()].map(({ socket, ...player }) => player).sort((a, b) => b.score - a.score || b.snake.length - a.snake.length),
  };
}

function broadcast(code, event) {
  const message = JSON.stringify(snapshot(code, event));
  for (const player of getRoom(code).players.values()) {
    if (player.socket.readyState === WebSocket.OPEN) player.socket.send(message);
  }
}

function opposite(a, b) {
  return (a === "up" && b === "down") || (a === "down" && b === "up") || (a === "left" && b === "right") || (a === "right" && b === "left");
}

function nextHead(player) {
  const head = player.snake[0];
  const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[player.nextDir];
  player.dir = player.nextDir;
  return { x: head.x + delta[0], y: head.y + delta[1] };
}

function respawn(room, player) {
  player.snake = spawnSnake(room);
  player.dir = "right";
  player.nextDir = "right";
  player.alive = true;
  player.grow = 0;
  player.boostUntil = 0;
  player.nextMoveAt = Date.now();
}

function tickRoom(code, room) {
  if (!room.players.size) return;
  const now = Date.now();
  const bodies = new Map();
  for (const player of room.players.values()) {
    if (!player.alive) continue;
    player.snake.forEach((cell, index) => bodies.set(`${cell.x},${cell.y}`, { player, index }));
  }

  let event;
  for (const player of room.players.values()) {
    if (!player.alive) continue;
    if (now < player.nextMoveAt) continue;
    player.nextMoveAt = now + (player.boostUntil > now ? BOOST_MOVE_MS : NORMAL_MOVE_MS);
    const head = nextHead(player);
    const outside = head.x < 0 || head.x >= GRID_W || head.y < 0 || head.y >= GRID_H;
    const hit = bodies.get(`${head.x},${head.y}`);
    if (outside || hit) {
      player.alive = false;
      player.deaths += 1;
      event = { type: "death", victimId: player.id, killerId: hit && hit.player.id !== player.id ? hit.player.id : null };
      if (hit && hit.player.id !== player.id) {
        hit.player.score += 2;
        hit.player.totalStars += 2;
        hit.player.grow += 2;
        hit.player.kills += 1;
        saveProgress(hit.player);
      }
      setTimeout(() => {
        if (room.players.has(player.id)) {
          respawn(room, player);
          broadcast(code, { type: "respawn", playerId: player.id });
        }
      }, 1800);
      continue;
    }

    player.snake.unshift(head);
    const boostIndex = room.boosts.findIndex((boost) => boost.x === head.x && boost.y === head.y);
    if (boostIndex >= 0) {
      room.boosts.splice(boostIndex, 1);
      player.boostUntil = now + BOOST_DURATION_MS;
      player.nextMoveAt = now + BOOST_MOVE_MS;
      event = { type: "speed", playerId: player.id, duration: BOOST_DURATION_MS };
      addBoost(room);
    }
    const foodIndex = room.foods.findIndex((food) => food.x === head.x && food.y === head.y);
    if (foodIndex >= 0) {
      const [fruit] = room.foods.splice(foodIndex, 1);
      player.score += fruit.points;
      player.totalStars += fruit.points;
      player.grow += fruit.growth;
      event = { type: "fruit", playerId: player.id, kind: fruit.kind, points: fruit.points };
      saveProgress(player);
      addFood(room);
    }
    if (player.grow > 0) player.grow -= 1;
    else player.snake.pop();
    if (player.mode === "solo" && player.authenticated && player.snake.length > player.bestSoloLength) {
      player.bestSoloLength = player.snake.length;
      saveProgress(player);
    }
  }
  broadcast(code, event);
}

setInterval(() => {
  for (const [code, room] of rooms) tickRoom(code, room);
}, TICK_MS);
refreshSoloLeaderboard().catch(() => {});
setInterval(() => refreshSoloLeaderboard().catch(() => {}), 30000);

const server = http.createServer((_request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ ok: true, service: "snake-arena-server", rooms: rooms.size, persistence: persistenceEnabled ? "supabase" : "memory" }));
});

const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  let currentRoom = "";
  let currentPlayer = "";

  socket.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "join") {
        // Login/save outages must never prevent a player from entering the arena.
        const user = await authenticatedUser(data.accessToken).catch((error) => {
          console.error("Auth lookup failed; continuing as guest:", error.message);
          return null;
        });
        currentPlayer = user?.id || clean(data.playerId, 48);
        if (!currentPlayer) return;
        const mode = data.mode === "solo" ? "solo" : "online";
        currentRoom = mode === "solo" ? `SOLO-${currentPlayer}` : (clean(data.room, 6).toUpperCase() || "SNAKE1");
        const room = getRoom(currentRoom, mode);
        const previous = room.players.get(currentPlayer);
        const saved = user
          ? await loadSave(user.id).catch((error) => {
              console.error("Save lookup failed; starting with zero:", error.message);
              return { total_stars: 0, best_solo_length: 0 };
            })
          : { total_stars: 0, best_solo_length: 0 };
        const player = {
          id: currentPlayer, name: clean(data.name, 16) || "Player",
          color: /^#[0-9a-f]{6}$/i.test(data.color ?? "") ? data.color : "#4dabf7",
          score: previous?.score ?? 0, totalStars: Number(saved.total_stars || 0), authenticated: Boolean(user),
          mode, bestSoloLength: Number(saved.best_solo_length || 0),
          socket, snake: previous?.snake ?? [], dir: "right", nextDir: "right", grow: 0,
          boostUntil: previous?.boostUntil ?? 0, nextMoveAt: Date.now(),
          alive: true, kills: previous?.kills ?? 0, deaths: previous?.deaths ?? 0,
        };
        if (!player.snake.length) player.snake = spawnSnake(room);
        room.players.set(currentPlayer, player);
        broadcast(currentRoom, { type: "join", playerId: currentPlayer });
      }
      if (data.type === "turn" && currentRoom) {
        const player = getRoom(currentRoom).players.get(currentPlayer);
        const direction = clean(data.direction, 5);
        if (player?.alive && ["up", "down", "left", "right"].includes(direction) && !opposite(player.dir, direction)) player.nextDir = direction;
      }
    } catch {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "error", message: "invalid message" }));
    }
  });

  socket.on("close", () => {
    if (!currentRoom || !currentPlayer) return;
    const room = getRoom(currentRoom);
    room.players.delete(currentPlayer);
    if (!room.players.size) rooms.delete(currentRoom);
    else broadcast(currentRoom, { type: "leave", playerId: currentPlayer });
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Snake Arena server listening on ${port}`));
