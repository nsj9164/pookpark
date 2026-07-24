// ============================================================
//  Coop Park - 서버 (서버 권위형 물리 + 실시간 동기화)
//  기능: 이동/점프(코요테·버퍼), 움직이는 발판, 가시, 낙하 장애물,
//        개별 죽음/부활, 협동 최종 보스전
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

// ---------------- 상수 ----------------
const TICK = 1000 / 60;
const BROADCAST = 1000 / 30;
const WORLD_W = 960, WORLD_H = 540;
const P_SIZE = 30;
const GRAVITY = 0.7, MOVE_SPEED = 4.2, JUMP_V = -13.5, MAX_FALL = 16;
const COYOTE = 7;        // 발판에서 떨어진 뒤에도 잠깐 점프 허용
const JUMP_BUFFER = 7;   // 착지 직전에 미리 누른 점프 기억
const COLORS = ['#ff5c5c', '#4ea3ff', '#4ee08a', '#ffd23f', '#c76bff', '#ff9e3f', '#3fe0d0', '#ff6bc0'];

// ---------------- 방 ----------------
const rooms = new Map();
let nextId = 1;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; }
  while (rooms.has(code));
  return code;
}

function createRoom(code) {
  const room = {
    code, players: new Map(), levelIndex: 0, keys: [], doorOpen: false,
    winTimer: 0, message: '', nextColor: 0, tick: 0,
    fallers: [], fallerId: 1, rainTimer: 0, plateActive: [], boss: null,
    bubbles: [], bubbleId: 1,
    loop: null, _lastBc: undefined,
  };
  loadLevel(room, Number(process.env.START_LEVEL) || 0);  // START_LEVEL: 테스트/디버그용 시작 스테이지
  rooms.set(code, room);
  return room;
}

function loadLevel(room, index) {
  room.levelIndex = index;
  const lvl = LEVELS[index % LEVELS.length];
  room.keys = lvl.keys.map((k, i) => ({ id: i, x: k.x, y: k.y, collected: false }));
  room.doorOpen = false;
  room.winTimer = 0;
  room.message = lvl.name || '';
  room.tick = 0;
  room.fallers = [];
  room.bubbles = [];
  room.rainTimer = 0;
  room.plateActive = (lvl.boss?.plates || []).map(() => false);
  room.boss = lvl.boss
    ? { hp: lvl.boss.hp, maxHp: lvl.boss.hp, x: (lvl.boss.minX + lvl.boss.maxX) / 2,
        dir: 1, charge: 0, hitCd: 0, flash: 0 }
    : null;
  for (const p of room.players.values()) respawn(p, lvl);
}

function respawn(p, lvl) {
  p.x = lvl.spawn.x + (Math.random() * 16 - 8);
  p.y = lvl.spawn.y;
  p.vx = 0; p.vy = 0; p.onGround = false; p.rideMover = -1;
  p.coyote = 0; p.jumpBuf = 0;
  p.trapped = false; p.trapTaps = 0; p.carrier = -1;
}
function kill(p, lvl) { respawn(p, lvl); p.blink = 42; p.deaths = (p.deaths || 0) + 1; }

// ---------------- 유틸 ----------------
function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
function moverRect(m, tick) {
  const off = Math.sin(tick * m.speed + (m.phase || 0)) * m.dist;
  return m.axis === 'y'
    ? { x: m.x, y: m.y + off, w: m.w, h: m.h }
    : { x: m.x + off, y: m.y, w: m.w, h: m.h };
}
function spawnFaller(room, speed, size) {
  room.fallers.push({
    id: room.fallerId++,
    x: 40 + Math.random() * (WORLD_W - 80 - size),
    y: -size, w: size, h: size,
    vy: speed + Math.random() * 1.5,
  });
}
function spawnBubble(room, p) {
  const dir = p.facing >= 0 ? 1 : -1;
  room.bubbles.push({
    id: room.bubbleId++, owner: p.id,
    x: p.x + P_SIZE / 2 + dir * 24, y: p.y + P_SIZE / 2,
    vx: dir * 6.5, life: 75, hit: false,
  });
}

// ---------------- 물리 스텝 ----------------
function stepRoom(room) {
  const lvl = LEVELS[room.levelIndex % LEVELS.length];
  const players = [...room.players.values()];
  room.tick++;

  // 입력 에지(누른 순간) 계산 — 점프/발사/버블탈출에 사용
  for (const p of players) {
    p.upEdge = p.input.up && !p.prevUp;
    p.shootEdge = p.input.shoot && !p.prevShoot;
    p.prevUp = p.input.up; p.prevShoot = p.input.shoot;
    p._px = p.x;
  }

  // 움직이는 발판: 현재/이전 위치와 이동량
  const movers = lvl.movers || [];
  const curM = movers.map(m => moverRect(m, room.tick));
  const prevM = movers.map(m => moverRect(m, room.tick - 1));
  const deltaM = curM.map((c, i) => ({ dx: c.x - prevM[i].x, dy: c.y - prevM[i].y }));
  const solids = lvl.platforms.concat(curM);
  const moverStart = lvl.platforms.length;

  // 발판에 탄 플레이어를 함께 이동
  for (const p of players) {
    if (!p.trapped && p.rideMover >= 0 && p.rideMover < deltaM.length) {
      p.x += deltaM[p.rideMover].dx;
      p.y += deltaM[p.rideMover].dy;
    }
  }

  // 버블에 갇힌 플레이어: 물리 무시, 위로 둥실 → 스페이스 10번 눌러 탈출
  for (const p of players) {
    if (!p.trapped) continue;
    p.vx = 0; p.vy = 0; p.rideMover = -1; p.carrier = -1;
    if (p.y > 66) p.y -= 2.2; else p.y = 66 + Math.sin(room.tick * 0.09) * 7;
    p.x += Math.sin(room.tick * 0.05 + p.id) * 0.6;
    if (p.x < 0) p.x = 0; if (p.x + P_SIZE > WORLD_W) p.x = WORLD_W - P_SIZE;
    if (p.upEdge) {
      p.trapTaps++;
      if (p.trapTaps >= 10) { p.trapped = false; p.trapTaps = 0; p.vy = -4; }
    }
  }

  // 일반 플레이어 물리
  for (const p of players) {
    if (p.trapped) continue;
    p.vx = 0;
    if (p.input.left) p.vx -= MOVE_SPEED;
    if (p.input.right) p.vx += MOVE_SPEED;
    if (p.vx < 0) p.facing = -1; else if (p.vx > 0) p.facing = 1;

    p.vy = Math.min(p.vy + GRAVITY, MAX_FALL);

    // X 이동
    p.x += p.vx;
    for (const s of solids) {
      if (overlap(p.x, p.y, P_SIZE, P_SIZE, s.x, s.y, s.w, s.h)) {
        if (p.vx > 0) p.x = s.x - P_SIZE;
        else if (p.vx < 0) p.x = s.x + s.w;
      }
    }
    if (p.x < 0) p.x = 0;
    if (p.x + P_SIZE > WORLD_W) p.x = WORLD_W - P_SIZE;

    // Y 이동
    p.onGround = false; p.rideMover = -1;
    p.y += p.vy;
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      if (overlap(p.x, p.y, P_SIZE, P_SIZE, s.x, s.y, s.w, s.h)) {
        if (p.vy > 0) {
          p.y = s.y - P_SIZE; p.vy = 0; p.onGround = true;
          if (i >= moverStart) p.rideMover = i - moverStart;
        } else if (p.vy < 0) { p.y = s.y + s.h; p.vy = 0; }
      }
    }
  }

  // 스택: 친구 머리 위 착지 판정 → carrier 설정(한번 붙으면 유지, 아래 참조에서 해제)
  for (const p of players) {
    if (p.trapped) continue;
    for (const q of players) {
      if (p === q || q.trapped) continue;
      const horiz = p.x < q.x + P_SIZE && p.x + P_SIZE > q.x;
      if (horiz && p.vy >= 0 && p.y + P_SIZE >= q.y - 2 && p.y + P_SIZE <= q.y + 14 && p.y < q.y) {
        p.y = q.y - P_SIZE; p.vy = 0; p.onGround = true; p.carrier = q.id;
      }
    }
  }

  // 점프 (코요테 타임 + 점프 버퍼) — 방향키와 독립. 점프하면 목마에서 내려옴
  for (const p of players) {
    if (p.trapped) continue;
    if (p.onGround) p.coyote = COYOTE; else if (p.coyote > 0) p.coyote--;
    if (p.upEdge) p.jumpBuf = JUMP_BUFFER; else if (p.jumpBuf > 0) p.jumpBuf--;
    if (p.jumpBuf > 0 && p.coyote > 0) {
      p.vy = JUMP_V; p.onGround = false; p.coyote = 0; p.jumpBuf = 0; p.carrier = -1;
    }
  }

  // 목마 태우기: 아래 사람의 이동을 위 사람에게 전달 → 점프/이동해도 안 떨어지고 같이
  const byId = new Map(players.map(p => [p.id, p]));
  const order = [...players].sort((a, b) => b.y - a.y);  // 아래(y 큰) 사람 먼저 확정
  for (const p of order) {
    if (p.trapped || p.carrier < 0) continue;
    const b = byId.get(p.carrier);
    if (!b || b.trapped) { p.carrier = -1; continue; }
    const horiz = p.x < b.x + P_SIZE && p.x + P_SIZE > b.x;
    const above = p.y <= b.y - 4;             // 아직 머리 위쪽인가
    if (!horiz || !above) { p.carrier = -1; continue; }   // 옆으로 벗어나거나 떨어지면 해제
    p.x += (b.x - b._px);                     // 아래 사람이 이동한 만큼 같이
    if (p.x < 0) p.x = 0; if (p.x + P_SIZE > WORLD_W) p.x = WORLD_W - P_SIZE;
    p.y = b.y - P_SIZE;                        // 항상 머리 위에 붙어서
    p.vy = 0;                                  // 낙하속도 누적 방지
    p.onGround = true; p.coyote = COYOTE;      // 위 사람도 언제든 점프해서 내릴 수 있게
  }

  // 버블 발사
  for (const p of players) {
    if (p.trapped) continue;
    if (p.shootCd > 0) p.shootCd--;
    if (p.shootEdge && p.shootCd <= 0) { spawnBubble(room, p); p.shootCd = 25; }
  }
  // 버블 이동 + 충돌(상대를 가둠)
  for (const b of room.bubbles) { b.x += b.vx; b.life--; }
  for (const b of room.bubbles) {
    if (b.hit) continue;
    for (const q of players) {
      if (q.id === b.owner || q.trapped) continue;
      if (overlap(b.x - 16, b.y - 16, 32, 32, q.x, q.y, P_SIZE, P_SIZE)) {
        q.trapped = true; q.trapTaps = 0; q.vx = 0; q.vy = 0; q.carrier = -1; b.hit = true; break;
      }
    }
  }
  room.bubbles = room.bubbles.filter(b => !b.hit && b.life > 0 && b.x > -30 && b.x < WORLD_W + 30);

  // 낙사
  for (const p of players) if (!p.trapped && p.y > WORLD_H + 80) respawn(p, lvl);

  // 가시 (밟으면 죽고 그 사람만 시작지점 부활)
  for (const p of players) {
    if (p.trapped || p.blink > 0) continue;
    for (const sp of (lvl.spikes || [])) {
      if (overlap(p.x + 4, p.y + 4, P_SIZE - 8, P_SIZE - 8, sp.x, sp.y, sp.w, sp.h)) { kill(p, lvl); break; }
    }
  }

  // 낙하 장애물
  updateRain(room, lvl, players);

  // 보스 or 일반 레벨 진행
  if (room.boss) stepBoss(room, lvl, players);
  else stepGoal(room, lvl, players);

  // 무적 깜빡임 감소
  for (const p of players) if (p.blink > 0) p.blink--;
}

function updateRain(room, lvl, players) {
  // 일반 레벨의 상시 낙하(rain) — 보스는 stepBoss에서 별도로 생성
  if (lvl.rain && !room.boss) {
    room.rainTimer++;
    if (room.rainTimer >= lvl.rain.interval) {
      room.rainTimer = 0;
      spawnFaller(room, lvl.rain.speed, lvl.rain.size);
    }
  }
  for (const f of room.fallers) f.y += f.vy;
  // 충돌 → 죽음
  for (const p of players) {
    if (p.trapped || p.blink > 0) continue;
    for (const f of room.fallers) {
      if (overlap(p.x + 3, p.y + 3, P_SIZE - 6, P_SIZE - 6, f.x, f.y, f.w, f.h)) {
        kill(p, lvl); f.y = WORLD_H + 999; break;
      }
    }
  }
  room.fallers = room.fallers.filter(f => f.y < WORLD_H + 40);
}

function stepGoal(room, lvl, players) {
  for (const p of players)
    for (const k of room.keys)
      if (!k.collected && overlap(p.x, p.y, P_SIZE, P_SIZE, k.x, k.y, 26, 26)) k.collected = true;

  room.doorOpen = room.keys.length > 0 && room.keys.every(k => k.collected);

  if (room.doorOpen && players.length > 0) {
    const d = lvl.door;
    const allAtDoor = players.every(p => overlap(p.x, p.y, P_SIZE, P_SIZE, d.x, d.y, d.w, d.h));
    if (allAtDoor) {
      room.winTimer += TICK;
      room.message = '클리어! 다음 스테이지로...';
      if (room.winTimer > 1200) loadLevel(room, room.levelIndex + 1);
    } else room.winTimer = 0;
  }
}

function stepBoss(room, lvl, players) {
  const b = lvl.boss, rb = room.boss;

  // 보스 좌우 이동
  rb.x += rb.dir * b.speed;
  if (rb.x <= b.minX) { rb.x = b.minX; rb.dir = 1; }
  if (rb.x >= b.maxX) { rb.x = b.maxX; rb.dir = -1; }

  // 발판(스위치) 동시 점유 판정 — 멀리 떨어져 있어 여러 명이 필요
  room.plateActive = b.plates.map(pl =>
    players.some(p => overlap(p.x, p.y, P_SIZE, P_SIZE, pl.x, pl.y, pl.w, pl.h)));
  const allHeld = room.plateActive.length > 0 && room.plateActive.every(Boolean);

  if (rb.hp > 0) {
    if (allHeld && rb.hitCd <= 0) {
      rb.charge++;
      if (rb.charge >= b.chargeMax) { rb.hp--; rb.charge = 0; rb.hitCd = 70; rb.flash = 24; }
    } else if (!allHeld) {
      rb.charge = Math.max(0, rb.charge - 2);
    }
    if (rb.hitCd > 0) rb.hitCd--;
    if (rb.flash > 0) rb.flash--;

    // 공격: HP가 낮을수록 돌이 더 자주/많이 떨어짐
    const phase = rb.maxHp - rb.hp;               // 0,1,2
    const interval = Math.max(16, 40 - phase * 9);
    room.rainTimer++;
    if (room.rainTimer >= interval) {
      room.rainTimer = 0;
      spawnFaller(room, 4.5 + phase, 26);
      if (phase >= 2) spawnFaller(room, 4.5 + phase, 26);  // 마지막 페이즈 2연발
    }
    room.message = `보스 HP ${rb.hp} · 양쪽 발판을 동시에 밟아 공격!`;
  } else {
    room.winTimer += TICK;
    room.message = '보스 격파!! 🎉 최고의 팀워크!';
    if (room.winTimer > 2000) loadLevel(room, room.levelIndex + 1);
  }
}

// ---------------- 직렬화/전송 ----------------
function serializeState(room) {
  const lvl = LEVELS[room.levelIndex % LEVELS.length];
  const movers = (lvl.movers || []).map(m => moverRect(m, room.tick));
  return {
    t: 'state',
    level: room.levelIndex, levelName: lvl.name, totalLevels: LEVELS.length,
    platforms: lvl.platforms, movers,
    spikes: lvl.spikes || [],
    door: lvl.door || null, doorOpen: room.doorOpen,
    keys: room.keys, message: room.message,
    fallers: room.fallers.map(f => ({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), w: f.w, h: f.h })),
    bubbles: room.bubbles.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y) })),
    boss: room.boss ? {
      x: Math.round(room.boss.x), y: lvl.boss.y, w: lvl.boss.w, h: lvl.boss.h,
      hp: room.boss.hp, maxHp: room.boss.maxHp,
      charge: room.boss.charge, chargeMax: lvl.boss.chargeMax, flash: room.boss.flash,
    } : null,
    plates: (lvl.boss?.plates || []).map((pl, i) => ({ ...pl, active: !!room.plateActive[i] })),
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color,
      x: Math.round(p.x), y: Math.round(p.y), facing: p.facing,
      blink: p.blink > 0 ? 1 : 0, deaths: p.deaths || 0,
      trapped: p.trapped ? 1 : 0, taps: p.trapTaps || 0,
    })),
  };
}

function broadcast(room, data) {
  const msg = JSON.stringify(data);
  for (const p of room.players.values())
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
}

function startRoomLoop(room) {
  let acc = 0, last = performance.now();
  room.loop = setInterval(() => {
    const now = performance.now();
    acc += now - last; last = now;
    let steps = 0;
    while (acc >= TICK && steps < 5) { stepRoom(room); acc -= TICK; steps++; }
    if (room._lastBc === undefined || now - room._lastBc >= BROADCAST) {
      broadcast(room, serializeState(room)); room._lastBc = now;
    }
  }, TICK);
}

function stopRoomIfEmpty(room) {
  if (room.players.size === 0) {
    clearInterval(room.loop); rooms.delete(room.code);
    console.log(`[room ${room.code}] 비어서 종료`);
  }
}

// ---------------- WebSocket ----------------
wss.on('connection', (ws) => {
  let player = null, room = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      let code = (msg.room || '').toUpperCase().trim();
      if (!code || !rooms.has(code)) {
        code = /^[A-Z0-9]{4}$/.test(code) ? code : makeRoomCode();
        room = createRoom(code); startRoomLoop(room);
        console.log(`[room ${code}] 생성됨`);
      } else room = rooms.get(code);

      const lvl = LEVELS[room.levelIndex % LEVELS.length];
      player = {
        id: nextId++, name: (msg.name || 'Player').slice(0, 12),
        color: COLORS[room.nextColor++ % COLORS.length], ws,
        input: { left: false, right: false, up: false, shoot: false },
        prevUp: false, prevShoot: false, upEdge: false, shootEdge: false,
        facing: 1, x: 0, y: 0, vx: 0, vy: 0, _px: 0, onGround: false,
        rideMover: -1, coyote: 0, jumpBuf: 0, blink: 0, deaths: 0,
        shootCd: 0, trapped: false, trapTaps: 0, carrier: -1,
      };
      respawn(player, lvl);
      room.players.set(player.id, player);
      ws.send(JSON.stringify({ t: 'joined', id: player.id, room: code }));
      console.log(`[room ${code}] ${player.name} 입장 (총 ${room.players.size}명)`);
    }
    else if (msg.t === 'input' && player) {
      player.input.left = !!msg.left;
      player.input.right = !!msg.right;
      player.input.up = !!msg.up;
      player.input.shoot = !!msg.shoot;
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
  console.log(`  ▶ 같은 와이파이 친구에게 공유:`);
  import('os').then(os => {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets))
      for (const net of nets[name])
        if (net.family === 'IPv4' && !net.internal) console.log(`     http://${net.address}:${PORT}`);
  });
  console.log('');
});
