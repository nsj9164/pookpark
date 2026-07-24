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
const MAX_JUMPS = 2;     // 이중 점프 (커비처럼 공중에서 한 번 더)
const BOUNCE_V = -19.5;  // 트램펄린 튕김 세기 (일반 점프보다 훨씬 높이)
const TAP_ESCAPE = 1;    // 버블 탈출에 필요한 스페이스 횟수
const COLORS = ['#ff5c5c', '#4ea3ff', '#4ee08a', '#ffd23f', '#c76bff', '#ff9e3f', '#3fe0d0', '#ff6bc0'];
const CHAR_IDS = ['kirby', 'dog', 'cat', 'bubble', 'bear', 'otter', 'pigeon', 'rabbit'];

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
    code, hostId: null, players: new Map(), levelIndex: 0, keys: [], doorOpen: false,
    winTimer: 0, message: '', nextColor: 0, tick: 0,
    fallers: [], fallerId: 1, rainTimer: 0, plateActive: [], boss: null,
    bubbles: [], bubbleId: 1,
    gateOpen: [], finished: false, wipeTimer: 0,
    loop: null, _lastBc: undefined,
  };
  loadLevel(room, Number(process.env.START_LEVEL) || 0);  // START_LEVEL: 테스트/디버그용 시작 스테이지
  rooms.set(code, room);
  return room;
}

function loadLevel(room, index) {
  room.levelIndex = index;
  const lvl = LEVELS[index % LEVELS.length];
  // 열쇠는 개인이 '들고' 다님: holder=null 이면 월드에 놓인 상태, 아니면 그 사람이 소지
  room.keys = lvl.keys.map((k, i) => ({ id: i, x: k.x, y: k.y, hx: k.x, hy: k.y, holder: null }));
  room.doorOpen = false;
  room.winTimer = 0;
  room.message = lvl.name || '';
  room.tick = 0;
  room.fallers = [];
  room.bubbles = [];
  room.rainTimer = 0;
  room.wipeTimer = 0;
  room.gateOpen = (lvl.gates || []).map(() => false);
  room.padLit = (lvl.boss?.pads || []).map(() => false);
  room.padActive = (lvl.boss?.pads || []).map(() => false);
  room.boss = lvl.boss
    ? { hp: lvl.boss.hp, maxHp: lvl.boss.hp,
        x: lvl.boss.cx - lvl.boss.w / 2, y: lvl.boss.cy - lvl.boss.h / 2,
        charge: 0, hitCd: 0, flash: 0, seqIdx: 0, moveT: 0 }
    : null;
  for (const p of room.players.values()) { respawn(p, lvl); p.hp = 5; }
}

const PLAYER_HP = 5;
// 보스전 데미지: 체력 1 감소, 0이면 그 자리에 쓰러짐(다운)
function damage(p, lvl, room, fromCx) {
  if (p.blink > 0 || p.trapped || p.dead) return;
  p.hp -= 1;
  p.blink = 45;                                   // 잠깐 무적(연속 데미지 방지)
  p.vy = -5;                                       // 살짝 넉백
  if (fromCx != null) p.x += (p.x + P_SIZE / 2 < fromCx ? -14 : 14);
  if (p.hp <= 0) downPlayer(p, lvl, room);
}

function respawn(p, lvl) {
  p.x = lvl.spawn.x + (Math.random() * 16 - 8);
  p.y = lvl.spawn.y;
  p.vx = 0; p.vy = 0; p.onGround = false; p.rideMover = -1;
  p.coyote = 0; p.jumpBuf = 0; p.jumpsLeft = MAX_JUMPS;
  p.trapped = false; p.trapTaps = 0; p.carrier = -1;
  p.dead = false;
}
// 열쇠가 가시(장애물)와 겹치면 옆의 안전한 자리로 밀어냄
function safeDropPos(lvl, x, y) {
  const kw = 26, kh = 26;
  const hits = (kx) => (lvl.spikes || []).some(s => overlap(kx, y, kw, kh, s.x, s.y, s.w, s.h));
  if (!hits(x)) return { x, y };
  for (let d = 4; d <= 260; d += 4) {
    if (x + d + kw <= WORLD_W && !hits(x + d)) return { x: x + d, y };
    if (x - d >= 0 && !hits(x - d)) return { x: x - d, y };
  }
  return { x, y };
}

// 다운(사망): 그 자리에 쓰러져 묘가 됨. 자동 부활 없음 — 다른 사람이 묘를 터치해야 부활
function downPlayer(p, lvl, room) {
  if (p.dead) return;
  const offscreen = p.y > WORLD_H;   // 낙사 등은 시작 위치에 묘를 둠(못 줍는 곳 방지)
  p.dead = true;
  p.deadX = offscreen ? lvl.spawn.x : Math.max(4, Math.min(WORLD_W - P_SIZE - 4, p.x));
  p.deadY = offscreen ? lvl.spawn.y : Math.min(p.y, WORLD_H - P_SIZE - 6);
  p.hp = 0; p.trapped = false; p.trapTaps = 0; p.vx = 0; p.vy = 0; p.carrier = -1;
  p.reviveProgress = 0;
  p.deaths = (p.deaths || 0) + 1;
  // 들고 있던 열쇠는 쓰러진 자리에 떨굼
  if (room) for (const k of room.keys) if (k.holder === p.id) {
    k.holder = null;
    const pos = safeDropPos(lvl, p.deadX, Math.min(p.deadY, WORLD_H - 70));
    k.x = pos.x; k.y = pos.y;
  }
}
// 살아있는 사람이 묘를 '3초 동안' 계속 터치하면 그 자리에서 부활
const REVIVE_TICKS = 60;   // 1초 (60fps)
function reviveByTouch(players) {
  for (const D of players) {
    if (!D.dead) continue;
    const touched = players.some(L => !L.dead && !L.trapped && L !== D
      && overlap(L.x, L.y, P_SIZE, P_SIZE, D.deadX, D.deadY, P_SIZE, P_SIZE));
    if (touched) {
      D.reviveProgress = (D.reviveProgress || 0) + 1;
      if (D.reviveProgress >= REVIVE_TICKS) {
        D.dead = false; D.x = D.deadX; D.y = D.deadY;
        D.vx = 0; D.vy = 0; D.hp = PLAYER_HP; D.blink = 55; D.carrier = -1; D.reviveProgress = 0;
      }
    } else {
      D.reviveProgress = Math.max(0, (D.reviveProgress || 0) - 3);   // 손 떼면 서서히 감소
    }
  }
}

// ---------------- 유틸 ----------------
function overlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
// 문 근처 안전지대 — 여기 있으면 장애물에 안 죽음
function nearDoor(p, lvl) {
  const d = lvl.door;
  if (!d) return false;
  const m = 44;
  return overlap(p.x, p.y, P_SIZE, P_SIZE, d.x - m, d.y - m, d.w + 2 * m, d.h + 2 * m);
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

  // 협동 문(게이트): 연결된 스위치 중 하나라도 밟고 있으면 열림(통과 가능)
  const gates = lvl.gates || [];
  const onSwitch = (sw) => sw && players.some(p => !p.trapped && overlap(p.x, p.y, P_SIZE, P_SIZE, sw.x, sw.y, sw.w, sw.h));
  room.gateOpen = gates.map(g => onSwitch(g.sw) || onSwitch(g.sw2));
  const closedGates = gates.filter((g, i) => !room.gateOpen[i]).map(g => ({ x: g.x, y: g.y, w: g.w, h: g.h }));

  const tramps = lvl.tramps || [];
  const solids = lvl.platforms.concat(curM, closedGates, tramps);
  const moverStart = lvl.platforms.length;
  const moverEnd = moverStart + curM.length;         // 이 범위만 '탈 수 있는' 발판
  const trampStart = moverEnd + closedGates.length;  // 이 이후는 트램펄린(튕김)

  // 발판에 탄 플레이어를 함께 이동
  for (const p of players) {
    if (!p.trapped && p.rideMover >= 0 && p.rideMover < deltaM.length) {
      p.x += deltaM[p.rideMover].dx;
      p.y += deltaM[p.rideMover].dy;
    }
  }

  // 버블에 갇힌 플레이어: 물리 무시, 계속 위로 → 하늘을 넘으면 아래에서 다시 올라옴(순환)
  for (const p of players) {
    if (!p.trapped) continue;
    p.vx = 0; p.vy = 0; p.rideMover = -1; p.carrier = -1;
    p.y -= 2.4;                                       // 쭈우욱 위로
    if (p.y + P_SIZE < -4) p.y = WORLD_H + 4;         // 하늘을 넘어가면 화면 아래에서 재등장
    p.x += Math.sin(room.tick * 0.05 + p.id) * 0.6;
    if (p.x < 0) p.x = 0; if (p.x + P_SIZE > WORLD_W) p.x = WORLD_W - P_SIZE;
    if (p.upEdge) {
      p.trapTaps++;
      if (p.trapTaps >= TAP_ESCAPE) { p.trapped = false; p.trapTaps = 0; p.vy = -4; }
    }
  }

  // 일반 플레이어 물리
  for (const p of players) {
    if (p.trapped || p.dead) continue;
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
          p.y = s.y - P_SIZE;
          if (i >= trampStart) { p.vy = BOUNCE_V; p.jumpsLeft = MAX_JUMPS; p.coyote = 0; }  // 트램펄린 튕김
          else { p.vy = 0; p.onGround = true; if (i >= moverStart && i < moverEnd) p.rideMover = i - moverStart; }
        } else if (p.vy < 0) { p.y = s.y + s.h; p.vy = 0; }
      }
    }
  }

  // 스택: 친구 머리 위 착지 판정 → carrier 설정(한번 붙으면 유지, 아래 참조에서 해제)
  for (const p of players) {
    if (p.trapped || p.dead) continue;
    for (const q of players) {
      if (p === q || q.trapped || q.dead) continue;
      const horiz = p.x < q.x + P_SIZE && p.x + P_SIZE > q.x;
      if (horiz && p.vy >= 0 && p.y + P_SIZE >= q.y - 2 && p.y + P_SIZE <= q.y + 14 && p.y < q.y) {
        p.y = q.y - P_SIZE; p.vy = 0; p.onGround = true; p.carrier = q.id;
      }
    }
  }

  // 점프 (코요테 + 버퍼 + 이중 점프) — 방향키와 독립. 점프하면 목마에서 내려옴
  for (const p of players) {
    if (p.trapped || p.dead) continue;
    if (p.onGround) { p.coyote = COYOTE; p.jumpsLeft = MAX_JUMPS; } else if (p.coyote > 0) p.coyote--;
    if (p.upEdge) p.jumpBuf = JUMP_BUFFER; else if (p.jumpBuf > 0) p.jumpBuf--;
    if (p.jumpBuf > 0 && p.coyote > 0 && p.jumpsLeft > 0) {
      // 1단 점프 (지면/코요테, 버퍼 허용)
      p.vy = JUMP_V; p.onGround = false; p.coyote = 0; p.jumpBuf = 0; p.carrier = -1; p.jumpsLeft--;
    } else if (p.upEdge && !p.onGround && p.coyote <= 0 && p.jumpsLeft > 0) {
      // 공중 이중 점프 (누른 순간 즉시)
      p.vy = JUMP_V; p.jumpBuf = 0; p.carrier = -1; p.jumpsLeft--;
    }
  }

  // 목마 태우기: 아래 사람의 이동을 위 사람에게 전달 → 점프/이동해도 안 떨어지고 같이
  const byId = new Map(players.map(p => [p.id, p]));
  const order = [...players].sort((a, b) => b.y - a.y);  // 아래(y 큰) 사람 먼저 확정
  for (const p of order) {
    if (p.trapped || p.dead || p.carrier < 0) continue;
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

  // 버블 발사 (횟수 제한 없음, 짧은 연사 쿨다운만)
  for (const p of players) {
    if (p.trapped || p.dead) continue;
    if (p.shootCd > 0) p.shootCd--;
    if (p.shootEdge && p.shootCd <= 0) { spawnBubble(room, p); p.shootCd = 12; }
  }
  // 버블 이동 + 충돌(상대를 가둠)
  for (const b of room.bubbles) { b.x += b.vx; b.life--; }
  for (const b of room.bubbles) {
    if (b.hit) continue;
    const owner = byId.get(b.owner);
    for (const q of players) {
      if (q.id === b.owner || q.trapped || q.dead) continue;
      // 같은 목마(스택)에 있는 사람은 쏜 사람 버블에 안 맞음
      if (q.carrier === b.owner || (owner && owner.carrier === q.id)) continue;
      if (overlap(b.x - 16, b.y - 16, 32, 32, q.x, q.y, P_SIZE, P_SIZE)) {
        q.trapped = true; q.trapTaps = 0; q.vx = 0; q.vy = 0; q.carrier = -1; b.hit = true; break;
      }
    }
  }
  room.bubbles = room.bubbles.filter(b => !b.hit && b.life > 0 && b.x > -30 && b.x < WORLD_W + 30);

  // 갇힌 사람의 버블을 다른 사람이 건드리면 터지며 사망(다운) — 모든 스테이지
  for (const T of players) {
    if (!T.trapped) continue;
    for (const L of players) {
      if (L === T || L.dead || L.trapped) continue;
      if (overlap(L.x, L.y, P_SIZE, P_SIZE, T.x - 4, T.y - 4, P_SIZE + 8, P_SIZE + 8)) { downPlayer(T, lvl, room); break; }
    }
  }

  // 살아있는 사람이 묘를 터치하면 부활
  reviveByTouch(players);

  // 낙사 → 다운
  for (const p of players) if (!p.trapped && !p.dead && p.y > WORLD_H + 80) downPlayer(p, lvl, room);

  // 가시 → 다운 (문 근처는 안전)
  for (const p of players) {
    if (p.trapped || p.dead || p.blink > 0 || nearDoor(p, lvl)) continue;
    for (const sp of (lvl.spikes || [])) {
      if (overlap(p.x + 4, p.y + 4, P_SIZE - 8, P_SIZE - 8, sp.x, sp.y, sp.w, sp.h)) { downPlayer(p, lvl, room); break; }
    }
  }

  // 낙하 장애물
  updateRain(room, lvl, players);

  // 보스 or 일반 레벨 진행
  if (room.boss) stepBoss(room, lvl, players);
  else stepGoal(room, lvl, players);

  // 무적 깜빡임 감소
  for (const p of players) if (p.blink > 0) p.blink--;

  // 전멸(모두 다운) 방지: 아무도 안 살아있으면 잠시 후 시작 위치에서 전원 부활
  if (players.length > 0 && players.every(p => p.dead)) {
    if (++room.wipeTimer > 150) { for (const p of players) { respawn(p, lvl); p.hp = PLAYER_HP; p.blink = 55; } room.wipeTimer = 0; }
  } else room.wipeTimer = 0;
}

function updateRain(room, lvl, players) {
  // 일반 레벨의 상시 낙하(rain) — 후반 스테이지일수록 더 자주, 더 빠르게, 더 많이
  if (lvl.rain && !room.boss) {
    const d = room.levelIndex;
    const interval = Math.max(10, lvl.rain.interval - d * 2);
    const speed = lvl.rain.speed + d * 0.2;
    room.rainTimer++;
    if (room.rainTimer >= interval) {
      room.rainTimer = 0;
      spawnFaller(room, speed, lvl.rain.size);
      if (Math.random() < d * 0.03) spawnFaller(room, speed, lvl.rain.size);  // 후반엔 다발
    }
  }
  for (const f of room.fallers) f.y += f.vy;
  // 충돌 — 보스전에선 체력 1 감소, 그 외엔 다운(문 근처는 안전)
  for (const p of players) {
    if (p.trapped || p.dead || p.blink > 0 || nearDoor(p, lvl)) continue;
    for (const f of room.fallers) {
      if (overlap(p.x + 3, p.y + 3, P_SIZE - 6, P_SIZE - 6, f.x, f.y, f.w, f.h)) {
        if (room.boss) damage(p, lvl, room, f.x + f.w / 2);
        else downPlayer(p, lvl, room);
        f.y = WORLD_H + 999; break;
      }
    }
  }
  room.fallers = room.fallers.filter(f => f.y < WORLD_H + 40);
}

function stepGoal(room, lvl, players) {
  const byId = new Map(players.map(p => [p.id, p]));
  // 수집: 월드에 놓인 열쇠를 밟으면 그 사람이 '들고' 있게 됨
  for (const p of players) {
    if (p.trapped || p.dead) continue;
    for (const k of room.keys)
      if (k.holder === null && overlap(p.x, p.y, P_SIZE, P_SIZE, k.x, k.y, 26, 26)) k.holder = p.id;
  }
  // 들고 있는 열쇠는 주인을 따라다님(표시/드롭 위치용)
  for (const k of room.keys) {
    if (k.holder !== null) {
      const h = byId.get(k.holder);
      if (h) { k.x = h.x + 2; k.y = h.y - 16; }
    }
  }
  room.doorOpen = room.keys.length > 0 && room.keys.every(k => k.holder !== null);

  // 문은 '전원'이 살아서 다 모여야 통과 (죽은 사람은 부활시켜 데려와야 함)
  if (room.doorOpen && players.length > 0) {
    const d = lvl.door;
    const allAtDoor = players.every(p => !p.dead && overlap(p.x, p.y, P_SIZE, P_SIZE, d.x, d.y, d.w, d.h));
    if (allAtDoor) {
      room.winTimer += TICK;
      room.message = '클리어! 다음 스테이지로...';
      if (room.winTimer > 1200) loadLevel(room, room.levelIndex + 1);
    } else room.winTimer = 0;
  }
}

function stepBoss(room, lvl, players) {
  const b = lvl.boss, rb = room.boss;
  const pads = b.pads;

  // 보스: 느린 리사주 패턴으로 이리저리 날아다님
  rb.moveT++;
  rb.x = (b.cx - b.w / 2) + Math.sin(rb.moveT * b.wx) * b.ampX;
  rb.y = (b.cy - b.h / 2) + Math.sin(rb.moveT * b.wy) * b.ampY;
  if (rb.x < 0) rb.x = 0; if (rb.x + b.w > WORLD_W) rb.x = WORLD_W - b.w;
  if (rb.y < 0) rb.y = 0; if (rb.y + b.h > 320) rb.y = 320 - b.h;   // 위/아래 범위 제한

  // 보스 몸에 닿으면 체력 1 감소 (0이면 다운)
  for (const p of players) {
    if (p.dead || p.trapped) continue;
    if (overlap(p.x + 3, p.y + 3, P_SIZE - 6, P_SIZE - 6, rb.x, rb.y, b.w, b.h)) damage(p, lvl, room, rb.x + b.w / 2);
  }

  // 이번 라운드에 빛나는 두 발판
  const [ia, ib] = b.sequence[rb.seqIdx % b.sequence.length];
  const occ = (i) => players.some(p => !p.trapped && !p.dead && overlap(p.x, p.y, P_SIZE, P_SIZE, pads[i].x, pads[i].y, pads[i].w, pads[i].h));
  room.padLit = pads.map((_, i) => i === ia || i === ib);
  room.padActive = pads.map((_, i) => (i === ia || i === ib) && occ(i));
  const bothOn = occ(ia) && occ(ib);

  if (rb.hp > 0) {
    if (bothOn && rb.hitCd <= 0) {
      rb.charge++;
      if (rb.charge >= b.chargeMax) {   // 충전 완료 → 데미지 + 빛이 다음 위치로
        rb.hp--; rb.charge = 0; rb.hitCd = 40; rb.flash = 24; rb.seqIdx++;
      }
    } else if (!bothOn) {
      rb.charge = Math.max(0, rb.charge - 1);
    }
    if (rb.hitCd > 0) rb.hitCd--;
    if (rb.flash > 0) rb.flash--;

    // 공격: HP가 낮을수록 돌이 더 자주/많이 (초반보다 훨씬 거세게)
    const phase = b.hp - rb.hp;                    // 0..4
    const interval = Math.max(10, 32 - phase * 4);
    room.rainTimer++;
    if (room.rainTimer >= interval) {
      room.rainTimer = 0;
      spawnFaller(room, 5 + phase * 0.6, 26);
      if (phase >= 2) spawnFaller(room, 5 + phase * 0.6, 26);
      if (phase >= 4) spawnFaller(room, 5 + phase * 0.6, 26);  // 막판 3연발
    }
    room.message = `보스 HP ${rb.hp} · 빛나는 발판 2곳을 동시에 밟아라!`;
  } else {
    // 리얼 보스 격파 → 전체 클리어! (더 이상 진행 없음)
    if (!room.finished) { room.finished = true; room.fallers = []; }
    room.message = '보스 격파!! 🎉 전체 클리어!';
  }
}

// ---------------- 직렬화/전송 ----------------
function serializeState(room) {
  const lvl = LEVELS[room.levelIndex % LEVELS.length];
  const movers = (lvl.movers || []).map(m => moverRect(m, room.tick));
  return {
    t: 'state',
    level: room.levelIndex, levelName: lvl.name, totalLevels: LEVELS.length,
    hostId: room.hostId, finished: room.finished,
    platforms: lvl.platforms, movers,
    tramps: lvl.tramps || [],
    spikes: lvl.spikes || [],
    gates: (lvl.gates || []).map((g, i) => ({
      x: g.x, y: g.y, w: g.w, h: g.h, open: !!room.gateOpen[i],
      sw: g.sw, sw2: g.sw2 || null,
    })),
    door: lvl.door || null, doorOpen: room.doorOpen,
    message: room.message,
    keys: room.keys.map(k => ({ id: k.id, x: Math.round(k.x), y: Math.round(k.y), holder: k.holder })),
    fallers: room.fallers.map(f => ({ id: f.id, x: Math.round(f.x), y: Math.round(f.y), w: f.w, h: f.h })),
    bubbles: room.bubbles.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y) })),
    boss: room.boss ? {
      x: Math.round(room.boss.x), y: Math.round(room.boss.y), w: lvl.boss.w, h: lvl.boss.h,
      hp: room.boss.hp, maxHp: room.boss.maxHp,
      charge: room.boss.charge, chargeMax: lvl.boss.chargeMax, flash: room.boss.flash,
    } : null,
    pads: (lvl.boss?.pads || []).map((pd, i) => ({ x: pd.x, y: pd.y, w: pd.w, h: pd.h, lit: !!room.padLit[i], active: !!room.padActive[i] })),
    graves: [...room.players.values()].filter(p => p.dead).map(p => ({ x: p.deadX, y: p.deadY, name: p.name, prog: Math.min(1, (p.reviveProgress || 0) / REVIVE_TICKS) })),
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, char: p.char,
      x: Math.round(p.x), y: Math.round(p.y), facing: p.facing,
      blink: p.blink > 0 ? 1 : 0, deaths: p.deaths || 0,
      trapped: p.trapped ? 1 : 0, taps: p.trapTaps || 0,
      hp: p.hp, dead: p.dead ? 1 : 0,
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
        char: CHAR_IDS.includes(msg.char) ? msg.char : 'kirby',   // 미선택/이상값 → 커비
        color: COLORS[room.nextColor++ % COLORS.length], ws,
        input: { left: false, right: false, up: false, shoot: false },
        prevUp: false, prevShoot: false, upEdge: false, shootEdge: false,
        facing: 1, x: 0, y: 0, vx: 0, vy: 0, _px: 0, onGround: false,
        rideMover: -1, coyote: 0, jumpBuf: 0, jumpsLeft: MAX_JUMPS, blink: 0, deaths: 0,
        shootCd: 0, trapped: false, trapTaps: 0, carrier: -1, hp: 5,
        dead: false, deadX: 0, deadY: 0,
      };
      respawn(player, lvl);
      room.players.set(player.id, player);
      if (room.hostId == null) room.hostId = player.id;   // 방을 처음 만든 사람이 방장
      ws.send(JSON.stringify({ t: 'joined', id: player.id, room: code }));
      console.log(`[room ${code}] ${player.name} 입장 (총 ${room.players.size}명)`);
    }
    else if (msg.t === 'input' && player) {
      player.input.left = !!msg.left;
      player.input.right = !!msg.right;
      player.input.up = !!msg.up;
      player.input.shoot = !!msg.shoot;
    }
    else if (msg.t === 'restart' && room) {
      room.finished = false;
      loadLevel(room, 0);
    }
    else if (msg.t === 'chat' && player && room) {
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (text) broadcast(room, { t: 'chat', id: player.id, name: player.name, color: player.color, text });
    }
    else if (msg.t === 'selectStage' && room && player && player.id === room.hostId) {
      const n = Number(msg.level);
      if (Number.isInteger(n) && n >= 0 && n < LEVELS.length) {
        room.finished = false;
        loadLevel(room, n);
        console.log(`[room ${room.code}] 방장이 스테이지 ${n + 1} 선택`);
      }
    }
  });

  ws.on('close', () => {
    if (room && player) {
      // 나간 사람이 들고 있던 열쇠는 원래 자리로 되돌림(게임이 막히지 않게)
      for (const k of room.keys) if (k.holder === player.id) { k.holder = null; k.x = k.hx; k.y = k.hy; }
      room.players.delete(player.id);
      // 방장이 나가면 남은 사람 중 한 명에게 방장 위임
      if (room.hostId === player.id) {
        const next = room.players.keys().next();
        room.hostId = next.done ? null : next.value;
      }
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
