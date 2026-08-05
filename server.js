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
let aiLeaderboard = [];
const AI_TARGET_SCORE = 15;

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
  const rows = await supabaseRequest(`/rest/v1/player_saves?user_id=eq.${encodeURIComponent(userId)}&select=total_stars,display_name,best_solo_length,best_ai_level,best_ai_score&limit=1`);
  return rows?.[0] ?? { total_stars: 0, best_solo_length: 0, best_ai_level: 0, best_ai_score: 0 };
}

async function refreshSoloLeaderboard() {
  if (!persistenceEnabled) return;
  const rows = await supabaseRequest("/rest/v1/player_saves?select=display_name,best_solo_length&best_solo_length=gt.0&order=best_solo_length.desc&limit=10");
  soloLeaderboard = (rows ?? []).map((row) => ({ name: row.display_name || "Player", length: Number(row.best_solo_length || 0) }));
}

async function refreshAiLeaderboard() {
  if (!persistenceEnabled) return;
  const rows = await supabaseRequest("/rest/v1/player_saves?select=display_name,best_ai_level,best_ai_score&best_ai_level=gt.0&order=best_ai_level.desc,best_ai_score.desc&limit=10");
  aiLeaderboard = (rows ?? []).map((row) => ({ name: row.display_name || "Player", level: Number(row.best_ai_level || 0), score: Number(row.best_ai_score || 0) }));
}

function saveProgress(player) {
  if (!player.authenticated) return;
  supabaseRequest("/rest/v1/player_saves?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: player.id, display_name: player.name, total_stars: player.totalStars, best_solo_length: player.bestSoloLength || 0, best_ai_level: player.bestAiLevel || 0, best_ai_score: player.bestAiScore || 0, updated_at: new Date().toISOString() }),
  }).then(() => player.mode === "solo" ? refreshSoloLeaderboard() : player.mode === "ai" ? refreshAiLeaderboard() : null).catch(() => {});
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

function getRoom(code, mode = "online", difficulty = 1) {
  if (!rooms.has(code)) {
    const room = { players: new Map(), foods: [], boosts: [], mode, difficulty, finished: false };
    rooms.set(code, room);
    addFood(room);
    addBoost(room);
  }
  return rooms.get(code);
}

function snapshot(code, event) {
  const room = getRoom(code);
  return {
    type: "state", room: code, mode: room.mode, difficulty: room.difficulty, targetScore: AI_TARGET_SCORE, gridWidth: GRID_W, gridHeight: GRID_H, foods: room.foods, boosts: room.boosts, soloLeaderboard, aiLeaderboard, event,
    players: [...room.players.values()].map(({ socket, ...player }) => player).sort((a, b) => b.score - a.score || b.snake.length - a.snake.length),
  };
}

function broadcast(code, event) {
  const message = JSON.stringify(snapshot(code, event));
  for (const player of getRoom(code).players.values()) {
    if (player.socket?.readyState === WebSocket.OPEN) player.socket.send(message);
  }
}

function chooseBotDirection(room, player) {
  const directions = ["up", "down", "left", "right"];
  const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const occupied = new Set([...room.players.values()].flatMap((p) => p.snake.slice(0, -1).map((c) => `${c.x},${c.y}`)));
  const safe = directions.filter((direction) => {
    if (opposite(player.dir, direction)) return false;
    const [dx, dy] = delta[direction];
    const head = { x: player.snake[0].x + dx, y: player.snake[0].y + dy };
    return head.x >= 0 && head.x < GRID_W && head.y >= 0 && head.y < GRID_H && !occupied.has(`${head.x},${head.y}`);
  });
  if (!safe.length) return;
  const target = room.foods.reduce((best, food) => {
    const distance = Math.abs(food.x - player.snake[0].x) + Math.abs(food.y - player.snake[0].y);
    return !best || distance < best.distance ? { food, distance } : best;
  }, null)?.food;
  const preferred = safe.sort((a, b) => {
    const [adx, ady] = delta[a], [bdx, bdy] = delta[b];
    return (Math.abs(player.snake[0].x + adx - target.x) + Math.abs(player.snake[0].y + ady - target.y)) - (Math.abs(player.snake[0].x + bdx - target.x) + Math.abs(player.snake[0].y + bdy - target.y));
  })[0];
  player.nextDir = Math.random() < .3 + room.difficulty * .065 ? preferred : safe[Math.floor(Math.random() * safe.length)];
}

function addAiPlayer(room, code) {
  const id = `BOT-${code}`;
  if (room.players.has(id)) return;
  room.players.set(id, { id, name: `AI Lv.${room.difficulty}`, color: "#ff3b5c", score: 0, totalStars: 0, authenticated: false, socket: null, snake: spawnSnake(room), dir: "left", nextDir: "left", grow: 0, boostUntil: 0, nextMoveAt: Date.now(), moveMs: 185 - room.difficulty * 10, alive: true, kills: 0, deaths: 0, mode: "ai", isBot: true, bestSoloLength: 0, bestAiLevel: 0, bestAiScore: 0 });
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
    if (player.isBot) chooseBotDirection(room, player);
    player.nextMoveAt = now + (player.boostUntil > now ? BOOST_MOVE_MS : (player.moveMs || NORMAL_MOVE_MS));
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
  if (room.mode === "ai" && !room.finished) {
    const winner = [...room.players.values()].find((player) => player.score >= AI_TARGET_SCORE);
    if (winner) {
      room.finished = true;
      const human = [...room.players.values()].find((player) => !player.isBot);
      if (!winner.isBot && human?.authenticated) {
        if (room.difficulty > human.bestAiLevel || (room.difficulty === human.bestAiLevel && human.score > human.bestAiScore)) {
          human.bestAiLevel = room.difficulty;
          human.bestAiScore = human.score;
          saveProgress(human);
        }
      }
      event = { type: "matchEnd", winnerId: winner.id, playerId: human?.id, difficulty: room.difficulty };
      setTimeout(() => {
        if (!rooms.has(code)) return;
        for (const player of room.players.values()) { player.score = 0; respawn(room, player); }
        room.finished = false;
        broadcast(code, { type: "newMatch" });
      }, 3500);
    }
  }
  broadcast(code, event);
}

setInterval(() => {
  for (const [code, room] of rooms) tickRoom(code, room);
}, TICK_MS);
refreshSoloLeaderboard().catch(() => {});
refreshAiLeaderboard().catch(() => {});
setInterval(() => refreshSoloLeaderboard().catch(() => {}), 30000);
setInterval(() => refreshAiLeaderboard().catch(() => {}), 30000);

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
        const mode = data.mode === "solo" ? "solo" : data.mode === "ai" ? "ai" : "online";
        const difficulty = Math.max(1, Math.min(10, Number(data.difficulty) || 1));
        currentRoom = mode === "solo" ? `SOLO-${currentPlayer}` : mode === "ai" ? `AI-${currentPlayer}` : (clean(data.room, 6).toUpperCase() || "SNAKE1");
        const room = getRoom(currentRoom, mode, difficulty);
        const previous = room.players.get(currentPlayer);
        const saved = user
          ? await loadSave(user.id).catch((error) => {
              console.error("Save lookup failed; starting with zero:", error.message);
              return { total_stars: 0, best_solo_length: 0, best_ai_level: 0, best_ai_score: 0 };
            })
          : { total_stars: 0, best_solo_length: 0, best_ai_level: 0, best_ai_score: 0 };
        const player = {
          id: currentPlayer, name: clean(data.name, 16) || "Player",
          color: /^#[0-9a-f]{6}$/i.test(data.color ?? "") ? data.color : "#4dabf7",
          score: previous?.score ?? 0, totalStars: Number(saved.total_stars || 0), authenticated: Boolean(user),
          mode, bestSoloLength: Number(saved.best_solo_length || 0),
          bestAiLevel: Number(saved.best_ai_level || 0), bestAiScore: Number(saved.best_ai_score || 0), moveMs: NORMAL_MOVE_MS, isBot: false,
          socket, snake: previous?.snake ?? [], dir: "right", nextDir: "right", grow: 0,
          boostUntil: previous?.boostUntil ?? 0, nextMoveAt: Date.now(),
          alive: true, kills: previous?.kills ?? 0, deaths: previous?.deaths ?? 0,
        };
        if (!player.snake.length) player.snake = spawnSnake(room);
        room.players.set(currentPlayer, player);
        if (mode === "ai") addAiPlayer(room, currentRoom);
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
    if (room.mode !== "online" || ![...room.players.values()].some((player) => !player.isBot)) rooms.delete(currentRoom);
    else broadcast(currentRoom, { type: "leave", playerId: currentPlayer });
  });
});

server.listen(port, "0.0.0.0", () => console.log(`Snake Arena server listening on ${port}`));
