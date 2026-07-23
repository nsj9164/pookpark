// ============================================================
//  Coop Park - 서버
//  Express 로 정적 파일 제공 + WebSocket 으로 실시간 멀티플레이
//  물리 시뮬레이션은 서버에서 처리(서버 권위형)해서 동기화를 안정적으로 유지
// ============================================================
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { LEVELS } from './public/shared/levels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------- 게임 상수 ----------------
const TICK = 1000 / 60;           // 물리 60fps
const BROADCAST = 1000 / 30;      // 상태 전송 30fps
const WORLD_W = 960;
const WORLD_H = 540;
const P_SIZE = 30;                // 플레이어 한 변
const GRAVITY = 0.7;
const MOVE_SPEED = 4.2;
const JUMP_V = -13.5;
const MAX_FALL = 16;

const COLORS = ['#ff5c5c', '#4ea3ff', '#4ee08a', '#ffd23f', '#c76bff', '#ff9e3f', '#3fe0d0', '#ff6bc0'];

// ---------------- 방 관리 ----------------
/** roomCode -> room */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  const room = {
    code,
    players: new Map(),   // id -> player
    levelIndex: 0,
    keys: [],             // 현재 레벨의 열쇠 상태
    doorOpen: false,
    winTimer: 0,          // 클리어 후 다음 레벨 전환 딜레이
    message: '',
    nextColor: 0,
    loop: null,
  };
  loadLevel(room, 0);
  rooms.set(code, room);
  return room;
}

function loadLevel(room, index) {
  room.levelIndex = index;
  const level = LEVELS[index % LEVELS.length];
  room.keys = level.keys.map((k, i) => ({ id: i, x: k.x, y: k.y, collected: false }));
  room.doorOpen = false;
  room.winTimer = 0;
  room.message = level.name || '';
  // 플레이어 리스폰
  for (const p of room.players.values()) respawn(p, level);
}

function respawn(p, level) {
  p.x = level.spawn.x + (Math.random() * 20 - 10);
  p.y = level.spawn.y;
  p.vx = 0;
  p.vy = 0;
  p.onGround = false;
}

// ---------------- 물리 ----------------
function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function stepRoom(room) {
  const level = LEVELS[room.levelIndex % LEVELS.length];
  const players = [...room.players.values()];

  for (const p of players) {
    // 좌우 입력
    p.vx = 0;
    if (p.input.left) p.vx -= MOVE_SPEED;
    if (p.input.right) p.vx += MOVE_SPEED;
    if (p.vx < 0) p.facing = -1;
    else if (p.vx > 0) p.facing = 1;

    // 중력
    p.vy += GRAVITY;
    if (p.vy > MAX_FALL) p.vy = MAX_FALL;

    // ---- X축 이동 + 충돌 ----
    p.x += p.vx;
    for (const plat of level.platforms) {
      if (rectsOverlap(p.x, p.y, P_SIZE, P_SIZE, plat.x, plat.y, plat.w, plat.h)) {
        if (p.vx > 0) p.x = plat.x - P_SIZE;
        else if (p.vx < 0) p.x = plat.x + plat.w;
      }
    }
    // 좌우 벽
    if (p.x < 0) p.x = 0;
    if (p.x + P_SIZE > WORLD_W) p.x = WORLD_W - P_SIZE;

    // ---- Y축 이동 + 충돌 ----
    p.onGround = false;
    p.y += p.vy;
    for (const plat of level.platforms) {
      if (rectsOverlap(p.x, p.y, P_SIZE, P_SIZE, plat.x, plat.y, plat.w, plat.h)) {
        if (p.vy > 0) { p.y = plat.y - P_SIZE; p.vy = 0; p.onGround = true; }
        else if (p.vy < 0) { p.y = plat.y + plat.h; p.vy = 0; }
      }
    }
  }

  // ---- 플레이어끼리: 머리 밟고 올라서기 (피코파크식 부스트) ----
  for (const p of players) {
    for (const q of players) {
      if (p === q) continue;
      // p 가 q 의 머리 위로 떨어지는 중이면 착지
      if (p.vy >= 0 &&
          rectsOverlap(p.x, p.y, P_SIZE, P_SIZE, q.x, q.y, P_SIZE, P_SIZE)) {
        const pBottom = p.y + P_SIZE;
        const qTop = q.y;
        // 이전 프레임 기준으로 위에 있었는지 대략 확인
        if (pBottom - p.vy <= qTop + 8) {
          p.y = q.y - P_SIZE;
          p.vy = 0;
          p.onGround = true;
          p.standingOn = q.id;
          // 밑에 깔린 사람이 움직이면 위 사람도 살짝 따라가게
          p.x += q.vx;
        }
      }
    }
  }

  // ---- 낙사 리스폰 ----
  for (const p of players) {
    if (p.y > WORLD_H + 80) respawn(p, level);
  }

  // ---- 점프 처리 (착지 판정 이후) ----
  for (const p of players) {
    if (p.input.up && p.onGround) {
      p.vy = JUMP_V;
      p.onGround = false;
    }
  }

  // ---- 열쇠 획득 ----
  for (const p of players) {
    for (const k of room.keys) {
      if (!k.collected && rectsOverlap(p.x, p.y, P_SIZE, P_SIZE, k.x, k.y, 26, 26)) {
        k.collected = true;
      }
    }
  }
  room.doorOpen = room.keys.length > 0 && room.keys.every(k => k.collected);

  // ---- 클리어 판정: 문 열림 + 모든 플레이어가 문에 닿음 ----
  if (room.doorOpen && players.length > 0) {
    const door = level.door;
    const allAtDoor = players.every(p =>
      rectsOverlap(p.x, p.y, P_SIZE, P_SIZE, door.x, door.y, door.w, door.h));
    if (allAtDoor) {
      room.winTimer += TICK;
      room.message = '클리어! 다음 스테이지로...';
      if (room.winTimer > 1200) {
        loadLevel(room, room.levelIndex + 1);
      }
    } else {
      room.winTimer = 0;
    }
  }
}

function serializeState(room) {
  const level = LEVELS[room.levelIndex % LEVELS.length];
  return {
    t: 'state',
    level: room.levelIndex,
    levelName: level.name,
    totalLevels: LEVELS.length,
    platforms: level.platforms,
    door: level.door,
    doorOpen: room.doorOpen,
    keys: room.keys,
    message: room.message,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: Math.round(p.x), y: Math.round(p.y), facing: p.facing,
    })),
  };
}

function broadcast(room, data) {
  const msg = JSON.stringify(data);
  for (const p of room.players.values()) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}

function startRoomLoop(room) {
  let lastBroadcast = 0;
  let acc = 0;
  let last = performance.now();
  room.loop = setInterval(() => {
    const now = performance.now();
    acc += now - last;
    last = now;
    // 물리 스텝 (밀린 만큼 따라잡기)
    let steps = 0;
    while (acc >= TICK && steps < 5) { stepRoom(room); acc -= TICK; steps++; }
    // 상태 전송
    lastBroadcast += TICK;
    if (now - room._lastBc >= BROADCAST || room._lastBc === undefined) {
      broadcast(room, serializeState(room));
      room._lastBc = now;
    }
  }, TICK);
}

function stopRoomIfEmpty(room) {
  if (room.players.size === 0) {
    clearInterval(room.loop);
    rooms.delete(room.code);
    console.log(`[room ${room.code}] 비어서 종료`);
  }
}

// ---------------- WebSocket 연결 ----------------
let nextId = 1;

wss.on('connection', (ws) => {
  let player = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      let code = (msg.room || '').toUpperCase().trim();
      if (!code || !rooms.has(code)) {
        // 방이 없으면 새로 생성 (요청한 코드가 유효하면 그걸 사용)
        code = /^[A-Z0-9]{4}$/.test(code) ? code : makeRoomCode();
        room = createRoom(code);
        startRoomLoop(room);
        console.log(`[room ${code}] 생성됨`);
      } else {
        room = rooms.get(code);
      }
      const level = LEVELS[room.levelIndex % LEVELS.length];
      player = {
        id: nextId++,
        name: (msg.name || 'Player').slice(0, 12),
        color: COLORS[room.nextColor++ % COLORS.length],
        ws,
        input: { left: false, right: false, up: false },
        facing: 1,
        x: 0, y: 0, vx: 0, vy: 0, onGround: false,
      };
      respawn(player, level);
      room.players.set(player.id, player);
      ws.send(JSON.stringify({ t: 'joined', id: player.id, room: code }));
      console.log(`[room ${code}] ${player.name} 입장 (총 ${room.players.size}명)`);
    }

    else if (msg.t === 'input' && player) {
      player.input.left = !!msg.left;
      player.input.right = !!msg.right;
      player.input.up = !!msg.up;
    }
  });

  ws.on('close', () => {
    if (room && player) {
      room.players.delete(player.id);
      console.log(`[room ${room.code}] ${player.name} 퇴장 (남은 ${room.players.size}명)`);
      stopRoomIfEmpty(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🎮 Coop Park 서버 실행 중`);
  console.log(`  ▶ 내 PC:      http://localhost:${PORT}`);
  console.log(`  ▶ 같은 와이파이 친구에게는 아래 주소 중 하나를 공유하세요:`);
  printLanAddresses(PORT);
  console.log('');
});

function printLanAddresses(port) {
  import('os').then(os => {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`     http://${net.address}:${port}`);
        }
      }
    }
  });
}
