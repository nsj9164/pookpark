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
const input = { left: false, right: false, up: false, shoot: false };
let lastSent = '';

function setKey(e, down) {
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

  // 플랫폼
  for (const p of s.platforms) drawPlatform(p);

  // 움직이는 발판 (보간)
  if (s.movers) s.movers.forEach((m, i) => drawMover(lerpRect(prevState?.movers?.[i], m, alpha)));

  // 보스 스위치(발판)
  if (s.plates) for (const pl of s.plates) drawPlate(pl);

  // 가시
  if (s.spikes) for (const sp of s.spikes) drawSpikes(sp);

  // 문 (보스전은 문이 없음)
  if (s.door) drawDoor(s.door, s.doorOpen);

  // 열쇠
  for (const k of s.keys) if (!k.collected) drawKey(k);

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
  for (const p of s.players) {
    const pos = lerpPlayer(p, alpha);
    drawPlayer(pos.x, pos.y, p.color, p.name, p.facing, p.id === myId, p.blink);
    if (p.trapped) drawTrapBubble(pos.x, pos.y, p.taps, p.id === myId);
  }

  // 배너 (클리어 / 보스 격파)
  if (s.message && (s.doorOpen || s.message.includes('클리어') || s.message.includes('격파'))) {
    drawBanner(s.message);
  }
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

// 커비 스타일의 동글동글 귀여운 캐릭터
function drawPlayer(x, y, color, name, facing, isMe, blink) {
  ctx.save();
  // 부활 직후 무적: 깜빡임
  if (blink) ctx.globalAlpha = 0.35 + 0.35 * Math.sin(performance.now() / 60);
  const cx = x + P_SIZE / 2;
  const bob = Math.sin(performance.now() / 280 + x * 0.05) * 1.2;  // 살랑살랑
  const cy = y + 14 + bob;
  const r = 15;
  const dir = facing >= 0 ? 1 : -1;
  const foot = shade(color, -55);

  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(cx, y + P_SIZE + 2, 13, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // 발 (몸통 뒤)
  ctx.fillStyle = foot;
  ctx.beginPath();
  ctx.ellipse(cx - 8, y + P_SIZE - 3 + bob * 0.5, 7, 4.5, -0.25 * dir, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + 8, y + P_SIZE - 3 + bob * 0.5, 7, 4.5, 0.25 * dir, 0, Math.PI * 2);
  ctx.fill();

  // 팔 (작은 동그라미, 몸통 뒤)
  ctx.fillStyle = shade(color, -18);
  ctx.beginPath(); ctx.ellipse(cx - r + 2, cy + 3, 5, 6, 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + r - 2, cy + 3, 5, 6, -0.4, 0, Math.PI * 2); ctx.fill();

  // 내 캐릭터 표시: 부드러운 링
  if (isMe) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc(cx, cy, r + 3.5, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  // 몸통 (동그란 원)
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

  // 광택 하이라이트 (왼쪽 위)
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.beginPath(); ctx.ellipse(cx - 5, cy - 6, 5.5, 4, -0.5, 0, Math.PI * 2); ctx.fill();

  // 볼터치 (분홍)
  ctx.fillStyle = 'rgba(255,120,150,0.55)';
  ctx.beginPath(); ctx.ellipse(cx - 8 * dir, cy + 3, 3.2, 2.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(cx + 4 * dir, cy + 3, 3.2, 2.2, 0, 0, Math.PI * 2); ctx.fill();

  // 눈 (세로로 긴 커비 눈 + 반짝임)
  const eyeY = cy - 3;
  const ex1 = cx - 3 + dir * 1.5;
  const ex2 = cx + 3 + dir * 1.5;
  for (const ex of [ex1, ex2]) {
    ctx.fillStyle = '#2b3a67';
    ctx.beginPath(); ctx.ellipse(ex, eyeY, 2.3, 4, 0, 0, Math.PI * 2); ctx.fill();
    // 흰 반짝임
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(ex - 0.6, eyeY - 1.6, 0.9, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 0.6, eyeY + 1.6, 0.7, 0, Math.PI * 2); ctx.fill();
  }

  // 입 (작은 미소)
  ctx.strokeStyle = 'rgba(120,40,60,0.7)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.arc(cx + dir * 1.5, cy + 5, 2.4, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  // 이름표
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.font = '600 12px Segoe UI, sans-serif';
  const tw = ctx.measureText(name).width;
  roundRect(cx - tw / 2 - 5, y - 22, tw + 10, 16, 5); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
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

// 보스 스위치 (밟으면 초록으로 켜짐)
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

  // 탈출 게이지 (10번 눌러야 터짐)
  const left = Math.max(0, 10 - taps);
  ctx.fillStyle = '#ffd23f';
  ctx.font = '700 13px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(isMe ? `스페이스 ${left}번!` : `${left}`, cx, y - 28);
  // 게이지 바
  const bw = 40, bx = cx - bw / 2, by = y - 24;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  roundRect(bx, by, bw, 5, 3); ctx.fill();
  ctx.fillStyle = '#4ee08a';
  roundRect(bx, by, bw * (taps / 10), 5, 3); ctx.fill();
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
