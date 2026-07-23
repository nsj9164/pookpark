// ============================================================
//  Coop Park - 클라이언트
//  - 로비: 방 생성 / 코드 입장 / URL(?room=CODE) 자동 입장
//  - 게임: 키 입력 전송, 서버 상태를 받아 부드럽게 렌더링(보간)
// ============================================================

const $ = (id) => document.getElementById(id);
const lobby = $('lobby'), game = $('game');
const canvas = $('canvas'), ctx = canvas.getContext('2d');

const W = 960, H = 540, P_SIZE = 30;

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
    ws.send(JSON.stringify({ t: 'join', room: code, name: getName() }));
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
function showToast(text) {
  const t = $('copyToast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------------- 입력 ----------------
const input = { left: false, right: false, up: false };
let lastSent = '';

function setKey(e, down) {
  let changed = true;
  switch (e.code) {
    case 'ArrowLeft': case 'KeyA': input.left = down; break;
    case 'ArrowRight': case 'KeyD': input.right = down; break;
    case 'ArrowUp': case 'KeyW': case 'Space': input.up = down; break;
    default: changed = false;
  }
  if (changed) { e.preventDefault(); sendInput(); }
}
function sendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const packed = `${input.left ? 1 : 0}${input.right ? 1 : 0}${input.up ? 1 : 0}`;
  if (packed === lastSent) return;
  lastSent = packed;
  ws.send(JSON.stringify({ t: 'input', left: input.left, right: input.right, up: input.up }));
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

  // 플랫폼
  for (const p of s.platforms) drawPlatform(p);

  // 문
  drawDoor(s.door, s.doorOpen);

  // 열쇠
  for (const k of s.keys) if (!k.collected) drawKey(k);

  // 플레이어 (이전 상태와 보간)
  const alpha = interpAlpha();
  for (const p of s.players) {
    const pos = lerpPlayer(p, alpha);
    drawPlayer(pos.x, pos.y, p.color, p.name, p.facing, p.id === myId);
  }

  // 클리어 메시지
  if (s.message && (s.doorOpen || s.message.includes('클리어'))) {
    drawBanner(s.message);
  }
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

function drawPlayer(x, y, color, name, facing, isMe) {
  ctx.save();
  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x + P_SIZE / 2, y + P_SIZE + 2, P_SIZE / 2, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // 몸통
  ctx.fillStyle = color;
  roundRect(x, y, P_SIZE, P_SIZE, 7); ctx.fill();

  // 내 캐릭터 표시 테두리
  if (isMe) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    roundRect(x - 1, y - 1, P_SIZE + 2, P_SIZE + 2, 8); ctx.stroke();
  }

  // 눈
  ctx.fillStyle = '#fff';
  const ex = facing >= 0 ? x + 18 : x + 6;
  ctx.beginPath(); ctx.arc(ex, y + 11, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(ex + facing * 1.5, y + 11, 2.2, 0, Math.PI * 2); ctx.fill();

  // 이름표
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.font = '600 12px Segoe UI, sans-serif';
  const tw = ctx.measureText(name).width;
  roundRect(x + P_SIZE / 2 - tw / 2 - 5, y - 20, tw + 10, 16, 5); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(name, x + P_SIZE / 2, y - 8);
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
