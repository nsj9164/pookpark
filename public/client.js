// ============================================================
//  Coop Park - 클라이언트
//  - 로비: 방 생성 / 코드 입장 / URL(?room=CODE) 자동 입장
//  - 게임: 키 입력 전송, 서버 상태를 받아 부드럽게 렌더링(보간)
// ============================================================

import { LEVELS } from './shared/levels.js';

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');
const canvas = $('canvas'), ctx = canvas.getContext('2d');

const W = 960, H = 540, P_SIZE = 30;

// 선택 가능한 캐릭터 (선택 안 하면 무조건 커비)
const CHARACTERS = [
  { id: 'kirby', name: '커비' },
  { id: 'dog', name: '강아지' },
  { id: 'cat', name: '고양이' },
  { id: 'bubble', name: '보글보글' },
  { id: 'bear', name: '곰돌이' },
  { id: 'otter', name: '수달' },
  { id: 'pigeon', name: '비둘기' },
  { id: 'rabbit', name: '토끼' },
];
const CHAR_IDS = CHARACTERS.map(c => c.id);
const UNLOCK_SECRET = 'pookvip';   // ?unlock=pookvip 또는 콘솔 unlockCharacters('pookvip')

let ws = null;
let myId = null;
let roomCode = null;

// 서버 상태 보간용
let prevState = null, curState = null, stateTime = 0;

// ---------------- 로비 로직 ----------------
const urlParams = new URLSearchParams(location.search);
const urlRoom = (urlParams.get('room') || '').toUpperCase();

// 저장된 닉네임 복원
$('nameInput').value = localStorage.getItem('coop_name') || '';
if (urlRoom) $('codeInput').value = urlRoom;

// ---------------- 캐릭터 선택 (히든) ----------------
function getChar() {
  const c = localStorage.getItem('coop_char');
  return CHAR_IDS.includes(c) ? c : 'kirby';   // 미선택 시 무조건 커비
}
function buildCharSelect() {
  const grid = $('charGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const cur = getChar();
  for (const ch of CHARACTERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'charBtn' + (ch.id === cur ? ' sel' : '');
    const cv = document.createElement('canvas');
    cv.width = 54; cv.height = 54;
    drawCreature(cv.getContext('2d'), 27, 26, 15, 1, '#ff9ec2', ch.id);
    const lb = document.createElement('span');
    lb.textContent = ch.name;
    btn.appendChild(cv); btn.appendChild(lb);
    btn.onclick = () => { localStorage.setItem('coop_char', ch.id); buildCharSelect(); };
    grid.appendChild(btn);
  }
}
function showCharSelect() {
  const el = $('charSelect');
  if (el) { el.classList.remove('hidden'); buildCharSelect(); }
}
// 콘솔에서 해제: unlockCharacters('코드')
window.unlockCharacters = (code) => {
  if (code === UNLOCK_SECRET) { localStorage.setItem('coop_unlock', '1'); showCharSelect(); return '✨ 캐릭터 선택이 열렸어요!'; }
  return '❌ 코드가 틀렸어요';
};
// URL 로 해제/지정: ?unlock=코드  또는  ?char=cat (특정 사람에게 링크로 부여)
if (urlParams.get('unlock') === UNLOCK_SECRET) localStorage.setItem('coop_unlock', '1');
const urlChar = (urlParams.get('char') || '').toLowerCase();
if (CHAR_IDS.includes(urlChar)) { localStorage.setItem('coop_char', urlChar); localStorage.setItem('coop_unlock', '1'); }
// ART(그리기 정의)가 파일 뒤쪽에 있으므로 로드 완료 후 실행
queueMicrotask(() => {
  buildCharSelect();  // 항상 채워둠 (개발자도구로 hidden 클래스를 지우면 바로 사용 가능)
  if (localStorage.getItem('coop_unlock') === '1') showCharSelect();
});

$('createBtn').onclick = () => connect('');            // 빈 코드 -> 서버가 새 방 생성
$('joinBtn').onclick = () => {
  const code = $('codeInput').value.toUpperCase().trim();
  if (!/^[A-Z0-9]{4}$/.test(code)) return showLobbyMsg('4자리 방 코드를 입력하세요', true);
  connect(code);
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('createBtn').click(); });

// URL 에 room 이 있으면 곧바로 그 방으로 (닉네임만 확인)
if (urlRoom) {
  showLobbyMsg(`방 ${urlRoom} 에 초대되었어요. 닉네임 입력 후 입장하세요.`);
}

function showLobbyMsg(text, isError = false) {
  const el = $('lobbyMsg');
  el.textContent = text;
  el.className = 'msg' + (isError ? ' error' : '');
}

function getName() {
  let n = $('nameInput').value.trim();
  if (!n) n = 'Player' + Math.floor(Math.random() * 900 + 100);
  localStorage.setItem('coop_name', n);
  return n;
}

// ---------------- 연결 ----------------
function connect(code) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'join', room: code, name: getName(), char: getChar() }));
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'joined') {
      myId = msg.id;
      roomCode = msg.room;
      enterGame();
    } else if (msg.t === 'state') {
      prevState = curState;
      curState = msg;
      stateTime = performance.now();
    } else if (msg.t === 'chat') {
      addChat(msg);
    }
  };

  ws.onclose = () => {
    if (!game.classList.contains('hidden')) {
      showLobbyMsg('서버 연결이 끊겼습니다. 새로고침 해주세요.', true);
    }
  };
  ws.onerror = () => showLobbyMsg('연결 오류. 서버가 실행 중인지 확인하세요.', true);
}

function enterGame() {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
  $('roomCode').textContent = roomCode;
  // URL 에 방 코드 반영 (친구에게 공유할 링크)
  history.replaceState(null, '', `?room=${roomCode}`);
  requestAnimationFrame(render);
}

// ---------------- 초대 링크 복사 ----------------
$('shareBtn').onclick = async () => {
  const url = `${location.origin}/?room=${roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast('복사됨! 친구에게 붙여넣기 하세요');
  } catch {
    // 클립보드 권한 없을 때 fallback
    prompt('이 링크를 복사해서 친구에게 보내세요:', url);
  }
};
// 승리 화면 → 처음부터 다시 (모두 함께 리셋)
$('restartBtn').onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'restart' }));
};

// 스테이지 선택 (방장만) — 드롭다운 채우기 + 선택 시 서버에 전송
(function buildStageSelect() {
  const sel = $('stageSelect');
  sel.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = lv.name || `스테이지 ${i + 1}`;
    sel.appendChild(o);
  });
  sel.addEventListener('change', (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'selectStage', level: Number(e.target.value) }));
  });
})();

function showToast(text) {
  const t = $('copyToast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------------- 입력 ----------------
const input = { left: false, right: false, up: false, shoot: false };
let lastSent = '';

// ---------------- 채팅 ----------------
const chatInput = $('chatInput'), chatLog = $('chatLog');
function addChat(msg) {
  const row = document.createElement('div');
  row.className = 'chatRow';
  const who = document.createElement('span');
  who.className = 'chatName'; who.style.color = msg.color || '#8b93a7';
  who.textContent = msg.name + ': ';
  const txt = document.createElement('span');
  txt.textContent = msg.text;
  row.appendChild(who); row.appendChild(txt);
  chatLog.appendChild(row);
  while (chatLog.children.length > 60) chatLog.removeChild(chatLog.firstChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}
function sendChat() {
  const text = chatInput.value.trim();
  if (text && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'chat', text }));
  chatInput.value = '';
}
chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { sendChat(); chatInput.blur(); }
  else if (e.key === 'Escape') { chatInput.value = ''; chatInput.blur(); }
});

function setKey(e, down) {
  // 채팅 입력 중에는 게임 조작 무시
  if (document.activeElement === chatInput) return;
  // Enter 로 채팅창 포커스 (게임 중)
  if (down && e.code === 'Enter' && !game.classList.contains('hidden')) { e.preventDefault(); chatInput.focus(); return; }
  let changed = true;
  switch (e.code) {
    case 'ArrowLeft': case 'KeyA': input.left = down; break;
    case 'ArrowRight': case 'KeyD': input.right = down; break;
    case 'ArrowUp': case 'KeyW': case 'Space': input.up = down; break;
    case 'KeyF': case 'KeyJ': case 'ShiftLeft': case 'ShiftRight': input.shoot = down; break;
    default: changed = false;
  }
  if (changed) { e.preventDefault(); sendInput(); }
}
function sendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const packed = `${input.left ? 1 : 0}${input.right ? 1 : 0}${input.up ? 1 : 0}${input.shoot ? 1 : 0}`;
  if (packed === lastSent) return;
  lastSent = packed;
  ws.send(JSON.stringify({ t: 'input', left: input.left, right: input.right, up: input.up, shoot: input.shoot }));
}
window.addEventListener('keydown', e => { if (!e.repeat) setKey(e, true); });
window.addEventListener('keyup', e => setKey(e, false));

// ---------------- 렌더링 ----------------
function render() {
  requestAnimationFrame(render);
  if (!curState) return;

  ctx.clearRect(0, 0, W, H);
  drawBackground();

  const s = curState;
  $('levelInfo').textContent = `스테이지 ${s.level + 1} / ${s.totalLevels}  ·  ${s.levelName}`;
  const alpha = interpAlpha();

  // 스테이지 선택 드롭다운: 방장에게만 표시, 현재 스테이지로 동기화
  const isHost = s.hostId === myId;
  const sel = $('stageSelect');
  sel.classList.toggle('hidden', !isHost);
  if (isHost && document.activeElement !== sel) sel.value = String(s.level);

  // 플랫폼
  for (const p of s.platforms) drawPlatform(p);

  // 움직이는 발판 (보간)
  if (s.movers) s.movers.forEach((m, i) => drawMover(lerpRect(prevState?.movers?.[i], m, alpha)));

  // 협동 게이트 + 스위치
  if (s.gates) for (const g of s.gates) drawGate(g);

  // 보스전 빛나는 발판
  if (s.pads) for (const pd of s.pads) drawPad(pd);

  // 가시
  if (s.spikes) for (const sp of s.spikes) drawSpikes(sp);

  // 묘비 (보스전에서 체력 다 닳아 죽은 자리)
  if (s.graves) for (const g of s.graves) drawGrave(g);

  // 월드에 놓인/떨군 열쇠 (아무도 안 든 것)
  for (const k of s.keys) if (k.holder == null) drawKey(k);

  // 문 (보스전은 문이 없음)
  if (s.door) drawDoor(s.door, s.doorOpen);

  // 보스
  if (s.boss) drawBoss(s.boss);

  // 낙하 장애물 (id로 보간)
  if (s.fallers) for (const f of s.fallers) {
    const pf = prevState?.fallers?.find(o => o.id === f.id);
    drawFaller(pf ? lerpRect(pf, f, alpha) : f);
  }

  // 발사된 버블 (id로 보간)
  if (s.bubbles) for (const bb of s.bubbles) {
    const pb = prevState?.bubbles?.find(o => o.id === bb.id);
    const pos = pb ? { x: pb.x + (bb.x - pb.x) * alpha, y: pb.y + (bb.y - pb.y) * alpha } : bb;
    drawBubble(pos.x, pos.y, 15);
  }

  // 플레이어 (이전 상태와 보간)
  const heldByPlayer = {};
  for (const k of s.keys) if (k.holder != null) heldByPlayer[k.holder] = (heldByPlayer[k.holder] || 0) + 1;
  for (const p of s.players) {
    if (p.dead) continue;   // 다운된 사람은 캐릭터 대신 묘로 표시
    const pos = lerpPlayer(p, alpha);
    drawPlayer(pos.x, pos.y, p.color, p.name, p.facing, p.id === myId, p.blink, p.char);
    if (p.trapped) drawTrapBubble(pos.x, pos.y, p.taps, p.id === myId);
    if (heldByPlayer[p.id]) drawHeldKey(pos.x, pos.y, heldByPlayer[p.id]);  // 열쇠 든 사람 표시
    if (s.boss && p.hp != null) drawHpHearts(pos.x, pos.y, p.hp);           // 보스전 체력
    if (p.id === s.hostId) drawCrown(pos.x, pos.y);                          // 방장 왕관
  }

  // 배너 (클리어 / 보스 격파)
  if (!s.finished && s.message && (s.doorOpen || s.message.includes('클리어') || s.message.includes('격파'))) {
    drawBanner(s.message);
  }

  // 전체 클리어 → 승리 화면
  if (s.finished) showWin(s); else hideWin();
}

function drawAmmo(n) {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.font = '600 13px Segoe UI, sans-serif';
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(12, 12, 116, 24, 8); ctx.fill();
  for (let i = 0; i < 5; i++) {
    ctx.beginPath(); ctx.arc(28 + i * 20, 24, 7, 0, Math.PI * 2);
    ctx.fillStyle = i < n ? 'rgba(150,210,255,0.9)' : 'rgba(255,255,255,0.15)';
    ctx.fill();
    if (i < n) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(26 + i * 20, 22, 2, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

let winShown = false;
function showWin(s) {
  if (winShown) return;
  winShown = true;
  const totalDeaths = s.players.reduce((a, p) => a + (p.deaths || 0), 0);
  $('winStats').textContent = `총 ${s.totalLevels}개 스테이지 완주 · 팀 전체 사망 ${totalDeaths}회`;
  $('winScreen').classList.remove('hidden');
}
function hideWin() {
  if (!winShown) return;
  winShown = false;
  $('winScreen').classList.add('hidden');
}

function lerpRect(prev, cur, alpha) {
  if (!prev) return cur;
  return { x: prev.x + (cur.x - prev.x) * alpha, y: prev.y + (cur.y - prev.y) * alpha, w: cur.w, h: cur.h };
}

function interpAlpha() {
  // 30fps 상태를 렌더 시점까지 보간
  const dt = performance.now() - stateTime;
  return Math.min(dt / (1000 / 30), 1);
}
function lerpPlayer(p, alpha) {
  if (!prevState) return { x: p.x, y: p.y };
  const prev = prevState.players.find(o => o.id === p.id);
  if (!prev) return { x: p.x, y: p.y };
  // 화면을 넘어가며 순환(위→아래)할 때 보간 줄무늬 방지: 큰 점프면 스냅
  if (Math.abs(p.y - prev.y) > 200 || Math.abs(p.x - prev.x) > 200) return { x: p.x, y: p.y };
  return { x: prev.x + (p.x - prev.x) * alpha, y: prev.y + (p.y - prev.y) * alpha };
}

// ---------------- 그리기 함수들 ----------------
function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#171b2b');
  g.addColorStop(1, '#0e1018');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 별
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let i = 0; i < 40; i++) {
    const x = (i * 137.5) % W, y = (i * 89.3) % (H - 60);
    ctx.fillRect(x, y, 2, 2);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPlatform(p) {
  ctx.fillStyle = '#39415c';
  roundRect(p.x, p.y, p.w, p.h, 5); ctx.fill();
  ctx.fillStyle = '#4b5678';
  ctx.fillRect(p.x, p.y, p.w, 4);
}

function drawDoor(d, open) {
  ctx.save();
  ctx.fillStyle = open ? '#2a4a2f' : '#3a2a2a';
  roundRect(d.x, d.y, d.w, d.h, 8); ctx.fill();
  ctx.strokeStyle = open ? '#4ee08a' : '#7a5a5a';
  ctx.lineWidth = 3;
  roundRect(d.x + 3, d.y + 3, d.w - 6, d.h - 6, 6); ctx.stroke();
  // 손잡이
  ctx.fillStyle = open ? '#4ee08a' : '#c9a24a';
  ctx.beginPath();
  ctx.arc(d.x + d.w - 14, d.y + d.h / 2, 4, 0, Math.PI * 2); ctx.fill();
  if (open) {
    ctx.fillStyle = 'rgba(78,224,138,0.15)';
    roundRect(d.x, d.y, d.w, d.h, 8); ctx.fill();
  }
  ctx.restore();
}

function drawKey(k) {
  ctx.save();
  const bob = Math.sin(performance.now() / 300 + k.x) * 4;
  ctx.translate(k.x + 13, k.y + 13 + bob);
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.arc(-4, 0, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0e1018';
  ctx.beginPath(); ctx.arc(-4, 0, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(2, -2, 12, 4);
  ctx.fillRect(10, -2, 3, 7);
  ctx.restore();
}

// 색을 밝게/어둡게 (amt<0 이면 어둡게)
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${g},${b})`;
}

const TAU = Math.PI * 2;

// ---- 공용 얼굴 파츠 ----
function eyesKirby(c, cx, cy, dir) {
  const eyeY = cy - 3;
  for (const ex of [cx - 3 + dir * 1.5, cx + 3 + dir * 1.5]) {
    c.fillStyle = '#2b3a67'; c.beginPath(); c.ellipse(ex, eyeY, 2.3, 4, 0, 0, TAU); c.fill();
    c.fillStyle = '#fff';
    c.beginPath(); c.ellipse(ex - 0.6, eyeY - 1.6, 0.9, 1.6, 0, 0, TAU); c.fill();
    c.beginPath(); c.arc(ex + 0.6, eyeY + 1.6, 0.7, 0, TAU); c.fill();
  }
}
function eyesDot(c, cx, cy, dir, sep = 4, ey = -3, sz = 2.5) {
  const eyeY = cy + ey;
  for (const ex of [cx - sep + dir * 1.2, cx + sep + dir * 1.2]) {
    c.fillStyle = '#2b2b3a'; c.beginPath(); c.arc(ex, eyeY, sz, 0, TAU); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(ex - 0.7, eyeY - 0.9, sz * 0.35, 0, TAU); c.fill();
  }
}
function cheeks(c, cx, cy, dir) {
  c.fillStyle = 'rgba(255,120,150,0.5)';
  c.beginPath(); c.ellipse(cx - 9 * dir, cy + 3, 3, 2, 0, 0, TAU); c.fill();
  c.beginPath(); c.ellipse(cx + 5 * dir, cy + 3, 3, 2, 0, 0, TAU); c.fill();
}
function smile(c, cx, cy, dir) {
  c.strokeStyle = 'rgba(120,40,60,0.7)'; c.lineWidth = 1.3;
  c.beginPath(); c.arc(cx + dir * 1.5, cy + 5, 2.4, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
}
function eyePair(c, lx, rx, ey, sz = 2.3) {
  for (const ex of [lx, rx]) {
    c.fillStyle = '#2b2b3a'; c.beginPath(); c.arc(ex, ey, sz, 0, TAU); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(ex - sz * 0.35, ey - sz * 0.4, sz * 0.35, 0, TAU); c.fill();
  }
}

// ---- 캐릭터별 아트: 각자 고유한 몸 실루엣으로 전신을 그림 (c, cx, cy=몸 중심, dir, color) ----
const ART = {
  // 커비: 동그란 분홍 퍼프
  kirby(c, cx, cy, dir, color) {
    const gy = cy + 14;
    c.fillStyle = shade(color, -55);
    c.beginPath(); c.ellipse(cx - 8, gy, 7, 4.5, -0.25 * dir, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 8, gy, 7, 4.5, 0.25 * dir, 0, TAU); c.fill();
    c.fillStyle = shade(color, -18);
    c.beginPath(); c.ellipse(cx - 14, cy + 3, 5, 6, 0.4, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 14, cy + 3, 5, 6, -0.4, 0, TAU); c.fill();
    c.fillStyle = color; c.beginPath(); c.arc(cx, cy, 15, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.28)'; c.beginPath(); c.ellipse(cx - 5, cy - 6, 5.5, 4, -0.5, 0, TAU); c.fill();
    eyesKirby(c, cx, cy, dir); cheeks(c, cx, cy, dir); smile(c, cx, cy, dir);
  },

  // 강아지: 처진 귀 + 주둥이 + 꼬리
  dog(c, cx, cy, dir, color) {
    const gy = cy + 14;
    c.fillStyle = shade(color, -12);   // 꼬리
    c.beginPath(); c.ellipse(cx - dir * 13, cy + 3, 4, 7, dir * 0.7, 0, TAU); c.fill();
    c.fillStyle = color;               // 몸통
    c.beginPath(); c.ellipse(cx, cy + 7, 11, 9, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, 25);    // 앞발
    c.beginPath(); c.ellipse(cx - 5, gy, 4.5, 3.2, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 5, gy, 4.5, 3.2, 0, 0, TAU); c.fill();
    c.fillStyle = color;               // 머리
    c.beginPath(); c.arc(cx, cy - 4, 11, 0, TAU); c.fill();
    c.fillStyle = shade(color, -35);   // 처진 귀
    c.beginPath(); c.ellipse(cx - 10, cy - 3, 4.5, 9, 0.4, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 10, cy - 3, 4.5, 9, -0.4, 0, TAU); c.fill();
    c.fillStyle = shade(color, 45);    // 주둥이
    c.beginPath(); c.ellipse(cx, cy + 1, 7, 5.5, 0, 0, TAU); c.fill();
    eyePair(c, cx - 5, cx + 5, cy - 6, 2.3);
    c.fillStyle = '#2a2320';           // 코
    c.beginPath(); c.ellipse(cx, cy - 2, 2.6, 2, 0, 0, TAU); c.fill();
    c.strokeStyle = '#2a2320'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx, cy + 3); c.stroke();
  },

  // 고양이: 뾰족 귀 + 긴 꼬리 + 수염
  cat(c, cx, cy, dir, color) {
    const gy = cy + 14;
    c.strokeStyle = color; c.lineWidth = 5; c.lineCap = 'round';  // 긴 꼬리
    c.beginPath(); c.moveTo(cx - dir * 9, cy + 9); c.quadraticCurveTo(cx - dir * 19, cy + 2, cx - dir * 15, cy - 7); c.stroke();
    c.lineCap = 'butt';
    c.fillStyle = color;               // 몸통
    c.beginPath(); c.ellipse(cx, cy + 7, 10, 9, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, 20);    // 앞발
    c.beginPath(); c.ellipse(cx - 4, gy, 3.6, 2.8, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 4, gy, 3.6, 2.8, 0, 0, TAU); c.fill();
    c.fillStyle = color;               // 머리
    c.beginPath(); c.arc(cx, cy - 5, 10, 0, TAU); c.fill();
    for (const s of [-1, 1]) {         // 뾰족 귀
      c.fillStyle = color;
      c.beginPath(); c.moveTo(cx + s * 9, cy - 10); c.lineTo(cx + s * 5, cy - 17); c.lineTo(cx + s * 1, cy - 10); c.closePath(); c.fill();
      c.fillStyle = 'rgba(255,150,180,0.9)';
      c.beginPath(); c.moveTo(cx + s * 7, cy - 11); c.lineTo(cx + s * 5, cy - 15); c.lineTo(cx + s * 3.5, cy - 11); c.closePath(); c.fill();
    }
    c.fillStyle = '#2b3a2a';           // 아몬드 눈
    c.beginPath(); c.ellipse(cx - 4, cy - 5, 1.9, 3.1, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 4, cy - 5, 1.9, 3.1, 0, 0, TAU); c.fill();
    c.fillStyle = '#ff8fa8';           // 코
    c.beginPath(); c.moveTo(cx - 1.6, cy - 1); c.lineTo(cx + 1.6, cy - 1); c.lineTo(cx, cy + 1); c.closePath(); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 0.7;  // 수염
    for (const dyw of [0, 2.5]) {
      c.beginPath(); c.moveTo(cx - 3, cy + dyw); c.lineTo(cx - 13, cy - 1 + dyw); c.stroke();
      c.beginPath(); c.moveTo(cx + 3, cy + dyw); c.lineTo(cx + 13, cy - 1 + dyw); c.stroke();
    }
  },

  // 보글보글 공룡(Bub): 통통한 몸 + 등가시 + 큰 눈 + 배
  bubble(c, cx, cy, dir, color) {
    const gy = cy + 14;
    c.fillStyle = shade(color, -20);   // 꼬리
    c.beginPath(); c.moveTo(cx - dir * 10, cy + 8); c.lineTo(cx - dir * 19, cy + 4); c.lineTo(cx - dir * 10, cy + 13); c.closePath(); c.fill();
    c.fillStyle = shade(color, -30);   // 등가시
    for (let i = -1; i <= 1; i++) { c.beginPath(); c.moveTo(cx + i * 6 - 3, cy - 9); c.lineTo(cx + i * 6, cy - 15); c.lineTo(cx + i * 6 + 3, cy - 9); c.closePath(); c.fill(); }
    c.fillStyle = color;               // 몸통
    c.beginPath(); c.ellipse(cx, cy + 2, 13, 14, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, 60);    // 배
    c.beginPath(); c.ellipse(cx, cy + 6, 8, 8, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, -15);   // 발
    c.beginPath(); c.ellipse(cx - 6, gy, 5, 3, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 6, gy, 5, 3, 0, 0, TAU); c.fill();
    for (const s of [-1, 1]) {         // 큰 눈
      const ex = cx + s * 5 + dir * 0.5;
      c.fillStyle = '#fff'; c.beginPath(); c.ellipse(ex, cy - 7, 4.5, 5.5, 0, 0, TAU); c.fill();
      c.fillStyle = '#2b2b3a'; c.beginPath(); c.arc(ex + dir * 0.6, cy - 6, 2, 0, TAU); c.fill();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(ex + dir * 0.6 - 0.7, cy - 7, 0.8, 0, TAU); c.fill();
    }
    c.strokeStyle = '#2a5a3a'; c.lineWidth = 1.6; c.beginPath(); c.arc(cx + dir, cy + 1, 5, 0.1 * Math.PI, 0.9 * Math.PI); c.stroke();
  },

  // 곰돌이: 둥근 귀 + 주둥이
  bear(c, cx, cy, dir, color) {
    const gy = cy + 14;
    c.fillStyle = color;               // 몸통
    c.beginPath(); c.ellipse(cx, cy + 7, 12, 10, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, -15);   // 다리
    c.beginPath(); c.ellipse(cx - 6, gy, 5, 3.5, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 6, gy, 5, 3.5, 0, 0, TAU); c.fill();
    c.fillStyle = color;               // 머리
    c.beginPath(); c.arc(cx, cy - 5, 11, 0, TAU); c.fill();
    c.beginPath(); c.arc(cx - 9, cy - 13, 4.5, 0, TAU); c.fill();  // 둥근 귀
    c.beginPath(); c.arc(cx + 9, cy - 13, 4.5, 0, TAU); c.fill();
    c.fillStyle = shade(color, 40);
    c.beginPath(); c.arc(cx - 9, cy - 13, 2.2, 0, TAU); c.fill();
    c.beginPath(); c.arc(cx + 9, cy - 13, 2.2, 0, TAU); c.fill();
    c.fillStyle = shade(color, 55);    // 주둥이
    c.beginPath(); c.ellipse(cx, cy - 1, 6.5, 5, 0, 0, TAU); c.fill();
    eyePair(c, cx - 5, cx + 5, cy - 6, 2.2);
    c.fillStyle = '#2a2320'; c.beginPath(); c.ellipse(cx, cy - 3, 2.4, 1.8, 0, 0, TAU); c.fill();
  },

  // 수달: 긴 몸 + 밝은 배 + 수염 + 두꺼운 꼬리
  otter(c, cx, cy, dir, color) {
    const gy = cy + 14;
    c.fillStyle = shade(color, -20);   // 두꺼운 꼬리
    c.beginPath(); c.ellipse(cx - dir * 13, cy + 9, 8, 4, dir * 0.3, 0, TAU); c.fill();
    c.fillStyle = color;               // 몸통
    c.beginPath(); c.ellipse(cx, cy + 6, 11, 11, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, 45);    // 밝은 배
    c.beginPath(); c.ellipse(cx, cy + 8, 6, 7, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, -10);   // 앞발 + 발
    c.beginPath(); c.ellipse(cx - 3, cy + 9, 2.5, 2, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 3, cy + 9, 2.5, 2, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx - 6, gy, 4, 2.5, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 6, gy, 4, 2.5, 0, 0, TAU); c.fill();
    c.fillStyle = color;               // 머리
    c.beginPath(); c.arc(cx, cy - 5, 10, 0, TAU); c.fill();
    c.fillStyle = shade(color, -25);   // 작은 귀
    c.beginPath(); c.arc(cx - 8, cy - 11, 2.6, 0, TAU); c.fill();
    c.beginPath(); c.arc(cx + 8, cy - 11, 2.6, 0, TAU); c.fill();
    c.fillStyle = shade(color, 55);    // 밝은 주둥이
    c.beginPath(); c.ellipse(cx, cy - 2, 7, 5.5, 0, 0, TAU); c.fill();
    eyePair(c, cx - 4, cx + 4, cy - 6, 2);
    c.fillStyle = '#4a3630'; c.beginPath(); c.ellipse(cx, cy - 4, 2.4, 1.8, 0, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.6)'; c.lineWidth = 0.7;
    for (const s of [-1, 1]) for (const dyw of [0, 2]) { c.beginPath(); c.moveTo(cx + s * 3, cy - 2 + dyw); c.lineTo(cx + s * 12, cy - 3 + dyw); c.stroke(); }
  },

  // 비둘기: 통통한 새 + 부리 + 날개 + 다리 + 꽁지
  pigeon(c, cx, cy, dir, color) {
    const gy = cy + 14;
    c.fillStyle = shade(color, -25);   // 꽁지깃
    c.beginPath(); c.moveTo(cx - dir * 8, cy + 4); c.lineTo(cx - dir * 18, cy + 8); c.lineTo(cx - dir * 8, cy + 11); c.closePath(); c.fill();
    c.strokeStyle = '#f5a623'; c.lineWidth = 1.6;  // 다리
    c.beginPath(); c.moveTo(cx - 3, cy + 14); c.lineTo(cx - 3, gy + 3); c.stroke();
    c.beginPath(); c.moveTo(cx + 3, cy + 14); c.lineTo(cx + 3, gy + 3); c.stroke();
    c.fillStyle = color;               // 몸통(세로로 통통)
    c.beginPath(); c.ellipse(cx + dir * 1, cy + 5, 10, 12, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, -18);   // 날개
    c.beginPath(); c.ellipse(cx - dir * 3, cy + 5, 5, 9, dir * 0.15, 0, TAU); c.fill();
    c.fillStyle = color;               // 머리
    c.beginPath(); c.arc(cx + dir * 2, cy - 7, 7.5, 0, TAU); c.fill();
    c.fillStyle = 'rgba(120,220,180,0.35)';  // 목 광택
    c.beginPath(); c.ellipse(cx + dir * 1, cy - 1, 6, 4, 0, 0, TAU); c.fill();
    c.fillStyle = '#f5a623';           // 부리
    c.beginPath(); c.moveTo(cx + dir * 8, cy - 8); c.lineTo(cx + dir * 15, cy - 6); c.lineTo(cx + dir * 8, cy - 4); c.closePath(); c.fill();
    c.fillStyle = '#2b2b3a'; c.beginPath(); c.arc(cx + dir * 3, cy - 8, 1.8, 0, TAU); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(cx + dir * 2.5, cy - 8.6, 0.7, 0, TAU); c.fill();
  },

  // 토끼: 긴 귀 + 앞니 + 뭉툭 꼬리
  rabbit(c, cx, cy, dir, color) {
    const gy = cy + 14;
    c.fillStyle = shade(color, 60);    // 뭉툭 꼬리
    c.beginPath(); c.arc(cx - dir * 11, cy + 8, 4, 0, TAU); c.fill();
    c.fillStyle = color;               // 몸통
    c.beginPath(); c.ellipse(cx, cy + 7, 11, 10, 0, 0, TAU); c.fill();
    c.fillStyle = shade(color, 20);    // 앞발
    c.beginPath(); c.ellipse(cx - 4, gy, 4, 3, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 4, gy, 4, 3, 0, 0, TAU); c.fill();
    c.fillStyle = color;               // 긴 귀
    c.beginPath(); c.ellipse(cx - 4, cy - 16, 3.5, 10, 0.12, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 4, cy - 16, 3.5, 10, -0.12, 0, TAU); c.fill();
    c.fillStyle = 'rgba(255,150,180,0.85)';
    c.beginPath(); c.ellipse(cx - 4, cy - 16, 1.5, 7, 0.12, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(cx + 4, cy - 16, 1.5, 7, -0.12, 0, TAU); c.fill();
    c.fillStyle = color;               // 머리
    c.beginPath(); c.arc(cx, cy - 4, 10, 0, TAU); c.fill();
    eyePair(c, cx - 4, cx + 4, cy - 5, 2.2);
    c.fillStyle = 'rgba(255,120,150,0.45)';
    c.beginPath(); c.arc(cx - 7, cy - 2, 2, 0, TAU); c.fill();
    c.beginPath(); c.arc(cx + 7, cy - 2, 2, 0, TAU); c.fill();
    c.fillStyle = '#ff8fa8';           // 코
    c.beginPath(); c.moveTo(cx - 1.5, cy - 1); c.lineTo(cx + 1.5, cy - 1); c.lineTo(cx, cy + 1); c.closePath(); c.fill();
    c.fillStyle = '#fff'; c.fillRect(cx - 2, cy + 1, 4, 3);  // 앞니
    c.strokeStyle = 'rgba(0,0,0,0.2)'; c.lineWidth = 0.5; c.beginPath(); c.moveTo(cx, cy + 1); c.lineTo(cx, cy + 4); c.stroke();
  },
};

// 캐릭터 하나를 그린다 (게임/미리보기 공용). c=2D 컨텍스트, (cx,cy)=몸 중심
function drawCreature(c, cx, cy, r, dir, color, char) {
  (ART[char] || ART.kirby)(c, cx, cy, dir, color);
}

function drawPlayer(x, y, color, name, facing, isMe, blink, char) {
  ctx.save();
  if (blink) ctx.globalAlpha = 0.35 + 0.35 * Math.sin(performance.now() / 60);
  const cx = x + P_SIZE / 2;
  const bob = Math.sin(performance.now() / 280 + x * 0.05) * 1.2;
  const cy = y + 14 + bob;
  const r = 15, dir = facing >= 0 ? 1 : -1;

  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(cx, y + P_SIZE + 2, 13, 4, 0, 0, TAU); ctx.fill();
  // 내 캐릭터 링
  if (isMe) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2.5; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  }

  drawCreature(ctx, cx, cy, r, dir, color, char || 'kirby');

  // 이름표
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.font = '600 12px Segoe UI, sans-serif';
  const tw = ctx.measureText(name).width;
  roundRect(cx - tw / 2 - 5, y - 22, tw + 10, 16, 5); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.fillText(name, cx, y - 10);
  ctx.restore();
}

function drawBanner(text) {
  ctx.save();
  ctx.fillStyle = 'rgba(78,224,138,0.12)';
  ctx.fillRect(0, H / 2 - 40, W, 80);
  ctx.fillStyle = '#4ee08a';
  ctx.font = '700 30px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, H / 2 + 10);
  ctx.restore();
}

// 움직이는 발판 (노란 줄무늬 + 방향 화살표 느낌)
function drawMover(m) {
  ctx.save();
  ctx.fillStyle = '#7a6a3a';
  roundRect(m.x, m.y, m.w, m.h, 5); ctx.fill();
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(m.x, m.y, m.w, 4);
  // 줄무늬
  ctx.strokeStyle = 'rgba(255,210,63,0.5)';
  ctx.lineWidth = 2;
  for (let i = 8; i < m.w - 4; i += 14) {
    ctx.beginPath(); ctx.moveTo(m.x + i, m.y + m.h - 3); ctx.lineTo(m.x + i + 6, m.y + 5); ctx.stroke();
  }
  ctx.restore();
}

// 열쇠를 든 사람 머리 위에 작은 열쇠 뱃지 (개수 포함)
function drawHeldKey(x, y, count) {
  ctx.save();
  const cx = x + P_SIZE / 2, cy = y - 30 + Math.sin(performance.now() / 250 + x) * 2;
  ctx.translate(cx, cy);
  ctx.scale(0.8, 0.8);
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.arc(-4, 0, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0e1018';
  ctx.beginPath(); ctx.arc(-4, 0, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(2, -2, 11, 4); ctx.fillRect(9, -2, 3, 6);
  ctx.restore();
  if (count > 1) {
    ctx.save();
    ctx.fillStyle = '#fff'; ctx.font = '700 11px Segoe UI, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('×' + count, cx + 8, cy + 4);
    ctx.restore();
  }
}

// 방장 왕관 (이름표 왼쪽 위에 작게)
function drawCrown(x, y) {
  ctx.save();
  const bx = x + P_SIZE / 2 - 8, by = y - 30;
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.moveTo(bx, by + 7);
  ctx.lineTo(bx, by + 1);
  ctx.lineTo(bx + 4, by + 4);
  ctx.lineTo(bx + 8, by - 2);
  ctx.lineTo(bx + 12, by + 4);
  ctx.lineTo(bx + 16, by + 1);
  ctx.lineTo(bx + 16, by + 7);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#e0a800';
  ctx.fillRect(bx, by + 6, 16, 2);
  ctx.restore();
}

// 묘비 (닉네임 새김) — 체력 다 닳아 죽은 자리
function drawGrave(g) {
  ctx.save();
  const bx = g.x, by = g.y, w = 28, h = 40;
  // 봉분 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(bx + w / 2, by + h, 20, 5, 0, 0, Math.PI * 2); ctx.fill();
  // 비석
  ctx.fillStyle = '#8a93a6';
  ctx.beginPath();
  ctx.moveTo(bx, by + h);
  ctx.lineTo(bx, by + 12);
  ctx.arc(bx + w / 2, by + 12, w / 2, Math.PI, 0);
  ctx.lineTo(bx + w, by + h);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#6c7488';
  ctx.fillRect(bx + 2, by + h - 4, w - 4, 4);
  // R.I.P + 십자
  ctx.strokeStyle = '#4a5062'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(bx + w / 2, by + 8); ctx.lineTo(bx + w / 2, by + 22); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx + w / 2 - 5, by + 13); ctx.lineTo(bx + w / 2 + 5, by + 13); ctx.stroke();
  // 부활 안내 (반짝반짝) — 다가가 터치하면 살아남
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
  ctx.globalAlpha = 0.5 + 0.5 * pulse;
  ctx.fillStyle = '#7fe0a0';
  ctx.font = '700 10px Segoe UI, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('터치해 부활!', bx + w / 2, by - 30);
  ctx.globalAlpha = 1;
  // 닉네임 팻말
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font = '600 11px Segoe UI, sans-serif';
  const tw = ctx.measureText(g.name).width;
  roundRect(bx + w / 2 - tw / 2 - 4, by - 15, tw + 8, 15, 4); ctx.fill();
  ctx.fillStyle = '#e8ecf5'; ctx.textAlign = 'center';
  ctx.fillText(g.name, bx + w / 2, by - 4);
  ctx.restore();
}

// 보스전 체력 하트 (머리 위)
function drawHpHearts(x, y, hp) {
  ctx.save();
  const n = 5, cx = x + P_SIZE / 2, top = y - 40;
  for (let i = 0; i < n; i++) {
    const hx = cx - (n - 1) * 5 + i * 10, hy = top;
    ctx.fillStyle = i < hp ? '#ff5c7a' : 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(hx, hy + 2);
    ctx.bezierCurveTo(hx, hy, hx - 4, hy, hx - 4, hy + 2.5);
    ctx.bezierCurveTo(hx - 4, hy + 5, hx, hy + 6.5, hx, hy + 8);
    ctx.bezierCurveTo(hx, hy + 6.5, hx + 4, hy + 5, hx + 4, hy + 2.5);
    ctx.bezierCurveTo(hx + 4, hy, hx, hy, hx, hy + 2);
    ctx.fill();
  }
  ctx.restore();
}

// 협동 게이트 (닫히면 벽, 열리면 반투명) + 연결된 스위치
function drawGate(g) {
  ctx.save();
  for (const sw of [g.sw, g.sw2]) {
    if (!sw) continue;
    const on = g.open;
    ctx.fillStyle = on ? '#2f6b3a' : '#5a3a2a';
    roundRect(sw.x, sw.y - 4, sw.w, sw.h + 4, 4); ctx.fill();
    ctx.fillStyle = on ? '#4ee08a' : '#e0a24a';
    ctx.fillRect(sw.x, sw.y - 4, sw.w, 4);
    ctx.fillStyle = on ? '#dfffe9' : '#f0d8b0';
    ctx.font = '700 11px Segoe UI, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(on ? 'OPEN' : '밟기', sw.x + sw.w / 2, sw.y - 8);
  }
  if (g.open) {
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#4ee08a';
    roundRect(g.x, g.y, g.w, g.h, 4); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(78,224,138,0.5)'; ctx.lineWidth = 2;
    roundRect(g.x, g.y, g.w, g.h, 4); ctx.stroke(); ctx.setLineDash([]);
  } else {
    ctx.fillStyle = '#6b4a2a';
    roundRect(g.x, g.y, g.w, g.h, 4); ctx.fill();
    ctx.fillStyle = '#8a6438';
    for (let yy = g.y + 6; yy < g.y + g.h - 4; yy += 16) ctx.fillRect(g.x + 3, yy, g.w - 6, 8);
    ctx.strokeStyle = '#3a2814'; ctx.lineWidth = 2; roundRect(g.x, g.y, g.w, g.h, 4); ctx.stroke();
  }
  ctx.restore();
}

// 떨어진 열쇠(죽은 자리) — 은은하게 반짝이는 유령 열쇠
function drawDropKey(dk) {
  ctx.save();
  const bob = Math.sin(performance.now() / 260 + dk.x) * 3;
  ctx.globalAlpha = 0.65 + 0.2 * Math.sin(performance.now() / 200 + dk.id);
  ctx.translate(dk.x + 13, dk.y + 13 + bob);
  ctx.fillStyle = '#afe9ff';
  ctx.beginPath(); ctx.arc(-4, 0, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0e1018';
  ctx.beginPath(); ctx.arc(-4, 0, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#afe9ff';
  ctx.fillRect(2, -2, 12, 4); ctx.fillRect(10, -2, 3, 7);
  ctx.restore();
}

// 보스전 발판: 빛나면(lit) 노랗게 반짝, 밟으면(active) 초록
function drawPad(pd) {
  ctx.save();
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180 + pd.x);
  if (pd.active) {
    ctx.fillStyle = '#2f6b3a';
    roundRect(pd.x, pd.y - 4, pd.w, pd.h + 4, 4); ctx.fill();
    ctx.fillStyle = '#4ee08a'; ctx.fillRect(pd.x, pd.y - 4, pd.w, 4);
    ctx.fillStyle = 'rgba(78,224,138,0.30)'; ctx.fillRect(pd.x, pd.y - 40, pd.w, 40);
  } else if (pd.lit) {
    // 빛나는 목표 발판 — 위로 뻗는 빛기둥 + 반짝임
    ctx.globalAlpha = 0.15 + 0.2 * pulse;
    const g = ctx.createLinearGradient(0, pd.y - 120, 0, pd.y);
    g.addColorStop(0, 'rgba(255,220,80,0)'); g.addColorStop(1, 'rgba(255,220,80,0.8)');
    ctx.fillStyle = g; ctx.fillRect(pd.x, pd.y - 120, pd.w, 120);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(60,45,15,0.9)`;
    roundRect(pd.x, pd.y - 4, pd.w, pd.h + 4, 4); ctx.fill();
    ctx.fillStyle = `rgba(255,${200 + pulse * 55 | 0},60,1)`;
    ctx.fillRect(pd.x, pd.y - 4, pd.w, 5);
    ctx.fillStyle = '#fff7c0'; ctx.font = '700 12px Segoe UI, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('여기!', pd.x + pd.w / 2, pd.y - 10);
  } else {
    ctx.fillStyle = 'rgba(60,66,90,0.55)';
    roundRect(pd.x, pd.y - 2, pd.w, pd.h + 2, 4); ctx.fill();
  }
  ctx.restore();
}

// (구) 보스 스위치 — 미사용
function drawPlate(pl) {
  ctx.save();
  const on = pl.active;
  ctx.fillStyle = on ? '#2f6b3a' : '#402a2a';
  roundRect(pl.x, pl.y - 4, pl.w, pl.h + 4, 4); ctx.fill();
  ctx.fillStyle = on ? '#4ee08a' : '#c76b6b';
  ctx.fillRect(pl.x, pl.y - 4, pl.w, 4);
  if (on) {
    ctx.fillStyle = 'rgba(78,224,138,0.25)';
    ctx.fillRect(pl.x, pl.y - 30, pl.w, 30);
  }
  ctx.fillStyle = on ? '#dfffe9' : '#e8c4c4';
  ctx.font = '700 11px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(on ? 'ON' : '밟기', pl.x + pl.w / 2, pl.y - 8);
  ctx.restore();
}

// 가시 (밟으면 죽음)
function drawSpikes(sp) {
  ctx.save();
  const n = Math.max(2, Math.floor(sp.w / 12));
  const tw = sp.w / n;
  ctx.fillStyle = '#c9d2e0';
  ctx.strokeStyle = '#8b93a6';
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const x0 = sp.x + i * tw;
    ctx.beginPath();
    ctx.moveTo(x0, sp.y + sp.h);
    ctx.lineTo(x0 + tw / 2, sp.y - 4);
    ctx.lineTo(x0 + tw, sp.y + sp.h);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = '#5a6072';
  ctx.fillRect(sp.x, sp.y + sp.h - 3, sp.w, 3);
  ctx.restore();
}

// 낙하 장애물 (운석/바위)
function drawFaller(f) {
  ctx.save();
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2, r = f.w / 2;
  // 꼬리 (불꽃)
  const g = ctx.createLinearGradient(cx, cy - r, cx, cy - r - 22);
  g.addColorStop(0, 'rgba(255,140,60,0.7)');
  g.addColorStop(1, 'rgba(255,140,60,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(cx - r * 0.6, cy); ctx.lineTo(cx + r * 0.6, cy); ctx.lineTo(cx, cy - r - 22); ctx.closePath(); ctx.fill();
  // 바위
  ctx.fillStyle = '#6b5140';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#4a382c';
  ctx.beginPath(); ctx.arc(cx + r * 0.3, cy + r * 0.2, r * 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.25, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 날아가는 버블
function drawBubble(cx, cy, r) {
  ctx.save();
  ctx.fillStyle = 'rgba(140,210,255,0.18)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(180,230,255,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 갇힌 플레이어를 감싸는 버블 + 탈출 게이지
function drawTrapBubble(x, y, taps, isMe) {
  ctx.save();
  const cx = x + P_SIZE / 2, cy = y + P_SIZE / 2, r = 26;
  // 무지갯빛 버블
  const g = ctx.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, r);
  g.addColorStop(0, 'rgba(255,255,255,0.5)');
  g.addColorStop(0.6, 'rgba(150,210,255,0.15)');
  g.addColorStop(1, 'rgba(150,210,255,0.05)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(190,235,255,0.9)';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath(); ctx.arc(cx - 9, cy - 9, 4, 0, Math.PI * 2); ctx.fill();

  // 탈출 안내 (스페이스 한 번이면 터짐)
  ctx.fillStyle = '#ffd23f';
  ctx.font = '700 13px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(isMe ? '스페이스로 탈출!' : '🫧', cx, y - 26);
  ctx.restore();
}

// 보스 (성난 얼굴 + HP + 충전 게이지)
function drawBoss(b) {
  ctx.save();
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const hit = b.flash > 0 && Math.floor(performance.now() / 60) % 2 === 0;

  // 몸통
  ctx.fillStyle = hit ? '#ffffff' : '#8a2ea0';
  ctx.beginPath(); ctx.ellipse(cx, cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hit ? '#ffdada' : '#6d2380';
  ctx.beginPath(); ctx.ellipse(cx, cy + 6, b.w / 2 - 6, b.h / 2 - 8, 0, 0, Math.PI * 2); ctx.fill();

  // 성난 눈
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.ellipse(cx - 22, cy - 6, 12, 14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + 22, cy - 6, 12, 14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e03030';
  ctx.beginPath(); ctx.arc(cx - 20, cy - 2, 5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + 20, cy - 2, 5, 0, Math.PI * 2); ctx.fill();
  // 눈썹 (화남)
  ctx.strokeStyle = '#2a0a30'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(cx - 34, cy - 20); ctx.lineTo(cx - 12, cy - 12); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx + 34, cy - 20); ctx.lineTo(cx + 12, cy - 12); ctx.stroke();
  // 입
  ctx.beginPath(); ctx.arc(cx, cy + 26, 12, Math.PI, Math.PI * 2); ctx.stroke();

  // HP 하트
  for (let i = 0; i < b.maxHp; i++) {
    ctx.fillStyle = i < b.hp ? '#ff5c7a' : 'rgba(255,255,255,0.2)';
    const hx = cx - (b.maxHp - 1) * 12 + i * 24, hy = b.y - 16;
    ctx.beginPath();
    ctx.moveTo(hx, hy + 4);
    ctx.bezierCurveTo(hx, hy, hx - 8, hy, hx - 8, hy + 5);
    ctx.bezierCurveTo(hx - 8, hy + 9, hx, hy + 12, hx, hy + 15);
    ctx.bezierCurveTo(hx, hy + 12, hx + 8, hy + 9, hx + 8, hy + 5);
    ctx.bezierCurveTo(hx + 8, hy, hx, hy, hx, hy + 4);
    ctx.fill();
  }

  // 충전 게이지 (양쪽 스위치 동시에 밟는 중일 때 참)
  if (b.charge > 0) {
    const bw = 160, bx = cx - bw / 2, by = b.y + b.h + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    roundRect(bx, by, bw, 10, 5); ctx.fill();
    ctx.fillStyle = '#ffd23f';
    roundRect(bx, by, bw * (b.charge / b.chargeMax), 10, 5); ctx.fill();
  }
  ctx.restore();
}
