// 쉿!그널 관리사무소 화면 (정적 데모: 서버 대신 mock-server.js가 브라우저 안에서 API를 처리)
import { DEMO_SLUG, DEMO_ADMIN_KEY } from './mock-server.js';
const $ = (id) => document.getElementById(id);
const SLUG = DEMO_SLUG;
const API = `api/b/${SLUG}`;
const KEY_STORE = `knock-admin-${SLUG}`;

const state = {
  key: null,
  config: null, // 공개 설정 (공지 종류 등)
  snap: null,
  version: 0,
  pollRun: 0,
  tab: 'board',
  room: null, // 선택한 문의 주민 id
  layout: null, // 편집 중인 배치 { rows, cols, cells }
  layoutDirty: false,
  selected: null, // 선택한 칸 index
  faqs: null,
  faqDirty: false,
  settingsDirty: false,
  openOriginals: new Set(), // 원문을 펼쳐 본 항목 id (필터 기록, 채팅 메시지)
  filterView: 'all',
  codesSig: '', // 세대 QR을 다시 그릴지 판단
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ts) => new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const hhmm = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

async function api(path, body) {
  const res = await fetch(`${API}/admin/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': state.key || '' },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout(data.error);
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || '요청에 실패했어요.');
  return data;
}

// ---------- 로그인 ----------
function logout(msg) {
  state.pollRun++;
  state.key = null;
  localStorage.removeItem(KEY_STORE);
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gate-error').textContent = msg || '';
}

$('gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  start($('gate-key').value.trim());
});
$('logout').addEventListener('click', () => logout());

async function start(key) {
  state.key = key;
  try {
    const d = await api('poll?after=0');
    localStorage.setItem(KEY_STORE, key);
    $('gate').hidden = true;
    $('app').hidden = false;
    apply(d);
    loop();
  } catch (err) {
    $('app').hidden = true;
    $('gate').hidden = false;
    $('gate-error').textContent = err.message;
  }
}

async function loop() {
  const run = ++state.pollRun;
  while (run === state.pollRun) {
    try {
      const d = await api(`poll?after=${state.version}`);
      if (run !== state.pollRun) return;
      apply(d);
    } catch {
      if (!state.key) return;
      await sleep(2000);
    }
  }
}

// ---------- 탭 ----------
document.querySelectorAll('.a-tabs [data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll('.a-tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.a-panel').forEach((p) => (p.hidden = p.dataset.panel !== state.tab));
    if (state.tab === 'chat' && state.room) markRead(state.room);
    if (state.tab === 'board') requestAnimationFrame(() => drawArrows());
  }),
);

// ---------- 스냅샷 반영 ----------
function apply(d) {
  state.version = d.version;
  state.snap = d.snapshot;
  const s = d.snapshot;
  $('a-building').textContent = s.config.name;
  document.title = `관리사무소 · ${s.config.name}`;
  if (!state.layoutDirty) {
    state.layout = structuredClone(s.config.layout);
    state.selected = null;
  }
  if (!state.faqDirty) state.faqs = structuredClone(s.config.faqs);
  renderBoard();
  renderDash();
  renderChats();
  renderReports();
  renderNotices();
  renderFilter();
  renderRelays();
  renderCodes();
  renderLayout();
  renderFaqs();
  renderSettings();
}

// 머리글: 줄 안의 숫자 호수에서 가장 많은 층·라인 번호를 쓴다 (세대를 몇 개 옮겨도 안 흔들리게)
function mode(values) {
  const n = {};
  for (const v of values) n[v] = (n[v] || 0) + 1;
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0];
}
const numeric = (cells) => cells.filter((l) => l && /^\d{3,}$/.test(l));

// 라인(열) 머리글: 끝 두 자리 → "3호", 숫자 호수가 없으면 "3라인"
function colLabel(L, c) {
  const col = [];
  for (let r = 0; r < L.rows; r++) col.push(L.cells[r * L.cols + c]);
  const m = mode(numeric(col).map((l) => Number(l.slice(-2))));
  return m ? `${m}호` : `${c + 1}라인`;
}

function floorLabel(rowCells, r, rows) {
  const m = mode(numeric(rowCells).map((l) => l.slice(0, -2)));
  return m ? `${m}F` : `${rows - r}F`;
}

function renderDash() {
  const s = state.snap;
  const openReports = s.reports.filter((r) => r.status === 'open').length;
  const unread = s.chats.reduce((n, c) => n + c.unread, 0);
  const total7 = s.unitStats.reduce((n, u) => n + u.count, 0);
  const repeat = s.unitStats.filter((u) => u.repeat).sort((a, b) => b.count - a.count);
  $('st-units').textContent = s.active.length;
  $('st-alerts').textContent = total7;
  $('st-repeat').textContent = repeat.length;
  $('st-repeat').parentElement.classList.toggle('alert', repeat.length > 0);
  $('st-reports').textContent = openReports;
  $('st-chats').textContent = unread;
  $('chat-unread').hidden = !unread;
  $('chat-unread').textContent = unread;
  $('report-open').hidden = !openReports;
  $('report-open').textContent = openReports;

  const { quietStart: qs, quietEnd: qe } = s.config;
  $('quiet-now').classList.toggle('on', s.quietNow);
  $('quiet-now').textContent = s.quietNow ? `🌙 지금은 조용한 시간이에요 (${qs}시~${qe}시)` : `☀️ 조용한 시간: ${qs}시~${qe}시`;

  // 소음 지도: 최근 7일 받은 알림 수로 색칠
  const stat = Object.fromEntries(s.unitStats.map((u) => [u.unit, u]));
  const active = new Set(s.active);
  const { rows, cols, cells } = s.config.layout;
  const map = $('heat-map');
  map.style.gridTemplateColumns = `2.4em repeat(${cols}, minmax(0, 1fr))`;
  let html = '<div></div>';
  for (let c = 0; c < cols; c++) html += `<div class="col-label">${esc(colLabel(s.config.layout, c))}</div>`;
  for (let r = 0; r < rows; r++) {
    const rowCells = cells.slice(r * cols, r * cols + cols);
    html += `<div class="floor-label">${floorLabel(rowCells, r, rows)}</div>`;
    for (const l of rowCells) {
      if (!l) {
        html += '<div class="unit-gap"></div>';
        continue;
      }
      const n = stat[l]?.count || 0;
      const lvl = n >= 4 ? 'h3' : n >= 2 ? 'h2' : n === 1 ? 'h1' : '';
      html += `<div class="unit ${lvl} ${active.has(l) ? 'ring' : ''}" title="${esc(l)}호 · 알림 ${n}건">${esc(l)}</div>`;
    }
  }
  map.innerHTML = html;

  // 반복 소음 세대
  $('repeat-desc').textContent = `최근 ${s.repeatDays}일 동안 서로 다른 ${s.repeatSenders}세대 이상에게 알림을 받은 세대예요. "저희 집 아님" 답장이 많으면 소음원이 다른 곳일 수 있어요.`;
  $('repeat-empty').hidden = repeat.length > 0;
  $('repeat-list').innerHTML = repeat
    .map(
      (u) => `<li>
        <div class="a-item-main">
          <div><b>${esc(u.unit)}호</b> · 알림 ${u.count}건 (${u.senders}세대)</div>
          <div class="muted small">🌙 조용한 시간 ${u.night}건 · "저희 집 아님" ${u.notus}건 · 마지막 ${clock(u.last)}</div>
        </div>
      </li>`,
    )
    .join('');

  // 최근 알림
  $('alert-empty').hidden = s.alerts.length > 0;
  $('alert-rows').innerHTML = s.alerts
    .map(
      (a) => `<tr>
        <td>${clock(a.createdAt)}${a.night ? ' 🌙' : ''}</td><td>${esc(a.fromUnit)}호</td><td>${esc(a.toUnit)}호${a.around ? ' <span class="tag">주변 확인</span>' : ''}</td>
        <td>${a.emoji} ${esc(a.typeLabel)}</td>
        <td>${a.reported ? '<span class="tag red">신고됨</span>' : a.replyText ? esc(a.replyText) : '<span class="muted">-</span>'}</td>
      </tr>`,
    )
    .join('');
}

// ---------- 실시간 현황판 ----------
const board = { kpi: {}, seenFeed: null, pingAt: {} };
const DIRS_ARROW = 18; // 서로 주고받은 화살표가 겹치지 않게 휘는 정도(px)
const hms = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function renderBoard() {
  const s = state.snap, bd = s.board;
  $('bd-sub').textContent = `${s.config.name} · 등록 ${bd.today.units}세대 (${bd.today.users}명) · 지금은 ${s.quietNow ? '🌙 조용한 시간' : '☀️ 생활 시간'}`;

  // 숫자 카드 (늘어나면 통통 튄다)
  const rate = bd.today.alerts ? Math.round((bd.today.replied / bd.today.alerts) * 100) : 0;
  const cards = [
    ['alerts', '오늘 소리 민원', bd.today.alerts, `🌙 조용한 시간 ${bd.today.night}건`],
    ['rate', '답장률', `${rate}%`, `${bd.today.replied}건 답장`],
    ['notus', '"저희 집 아님"', bd.today.notus, '소음원이 다른 곳일 수도'],
    ['relays', '관리사무소 경유', bd.today.relays, `연락 전 ${bd.today.relaysOpen}건`, bd.today.relaysOpen > 0 ? 'warn' : ''],
    ['notices', '양해 공지', bd.today.notices, '진행·예정'],
    ['tomato', '🍅 던진 토마토', bd.vent.tomato, '화풀기 누적', 'fun'],
    ['egg', '🥚 던진 계란', bd.vent.egg, '화풀기 누적', 'fun'],
    ['wok', '🍳 토계볶 완성', bd.vent.wok, '10개마다 한 접시', 'fun'],
  ];
  $('bd-kpis').innerHTML = cards
    .map(([k, l, v, sub, cls = '']) => {
      const up = board.kpi[k] !== undefined && String(board.kpi[k]) !== String(v);
      board.kpi[k] = v;
      return `<div class="kpi ${cls} ${up ? 'bump' : ''}"><span class="l">${l}</span><span class="v">${esc(v)}</span><span class="s">${esc(sub)}</span></div>`;
    })
    .join('');

  // 새 소식: 받은 세대 칸을 반짝
  const fresh = board.seenFeed ? bd.feed.filter((f) => !board.seenFeed.has(f.id)) : [];
  for (const f of fresh) board.pingAt[f.to] = Date.now();
  board.seenFeed = new Set(bd.feed.map((f) => f.id));

  renderBoardMap(bd);

  $('bd-feed-empty').hidden = bd.feed.length > 0;
  const freshIds = new Set(fresh.map((f) => f.id));
  const unitTxt = (u) => (/^\d|^[A-Za-z]/.test(u) ? `${u}호` : u);
  $('bd-feed').innerHTML = bd.feed
    .map(
      (f) => `<li class="${freshIds.has(f.id) ? 'new' : ''}">
        <span class="ic">${f.icon}</span>
        <span class="who">${esc(unitTxt(f.from))} → ${esc(unitTxt(f.to))}${f.night ? ' 🌙' : ''}</span>
        <span class="tm">${hms(f.at)}</span>
        <span class="tx">${esc(f.text)}</span>
      </li>`,
    )
    .join('');

  $('bd-pairs').innerHTML = bd.pairs
    .slice(0, 6)
    .map((p) => `<li><b>${esc(p.from)}호 → ${esc(p.to)}호</b> ${p.count}건 <span class="m">${p.relay ? '관리사무소 경유' : `답장 ${p.replied}${p.notus ? ` · 저희 집 아님 ${p.notus}` : ''}`}</span></li>`)
    .join('');
  const ventRow = (r) => `<li><b>${esc(unitTxt(r.unit))}</b> 🍅${r.tomato} 🥚${r.egg} <span class="m">총 ${r.total}</span></li>`;
  $('bd-targets').innerHTML = bd.vent.targets.map(ventRow).join('');
  $('bd-throwers').innerHTML = bd.vent.throwers.map(ventRow).join('');
}

function renderBoardMap(bd) {
  const { rows, cols, cells } = state.snap.config.layout;
  const L = state.snap.config.layout;
  const recv = {};
  for (const p of bd.pairs) recv[p.to] = (recv[p.to] || 0) + p.count;
  const active = new Set(state.snap.active);
  const map = $('bd-map');
  map.style.gridTemplateColumns = `2.4em repeat(${cols}, minmax(0, 1fr))`;
  let html = '<div></div>';
  for (let c = 0; c < cols; c++) html += `<div class="col-label">${esc(colLabel(L, c))}</div>`;
  for (let r = 0; r < rows; r++) {
    const rowCells = cells.slice(r * cols, r * cols + cols);
    html += `<div class="floor-label">${floorLabel(rowCells, r, rows)}</div>`;
    for (const l of rowCells) {
      if (!l) { html += '<div class="unit-gap"></div>'; continue; }
      const n = recv[l] || 0;
      const lvl = n >= 4 ? 'r3' : n >= 2 ? 'r2' : n === 1 ? 'r1' : '';
      const ping = Date.now() - (board.pingAt[l] || 0) < 1600 ? 'ping' : '';
      html += `<div class="unit ${lvl} ${active.has(l) ? 'ring' : ''} ${ping}" data-unit="${esc(l)}" title="${esc(l)}호 · 받은 민원 ${n}건">${esc(l)}</div>`;
    }
  }
  map.innerHTML = html;
  drawArrows(bd);
}

// 보낸 집 → 받은 집 화살표 (SVG를 배치도 위에 겹쳐 그린다)
function drawArrows(bd = state.snap?.board) {
  const svg = $('bd-arrows');
  if (!bd || $('board').hidden) return;
  const wrap = $('bd-map-wrap').getBoundingClientRect();
  const center = (u) => {
    const el = $('bd-map').querySelector(`[data-unit="${CSS.escape(u)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - wrap.left + r.width / 2, y: r.top - wrap.top + r.height / 2 };
  };
  const now = bd.now || Date.now();
  const COL = { normal: '#1f3d36', recent: '#e2a33b', relay: '#8a8f8c' };
  let defs = '<defs>';
  for (const [k, c] of Object.entries(COL)) defs += `<marker id="ah-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`;
  defs += '</defs>';
  let body = '';
  // 오래된 것부터 그려서 최근 화살표가 위에 오게
  for (const p of [...bd.pairs].sort((a, b) => a.last - b.last)) {
    const a = center(p.from), b = center(p.to);
    if (!a || !b) continue;
    const recent = now - p.last < 2 * 60_000;
    const kind = p.relay ? 'relay' : recent ? 'recent' : 'normal';
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    // 칸 가장자리에서 멈추게 양끝을 줄이고, 오른쪽으로 살짝 휘게
    const sx = a.x + (dx / len) * 14, sy = a.y + (dy / len) * 12, ex = b.x - (dx / len) * 16, ey = b.y - (dy / len) * 14;
    const cx = (sx + ex) / 2 - (dy / len) * DIRS_ARROW, cy = (sy + ey) / 2 + (dx / len) * DIRS_ARROW;
    const w = Math.min(7, 1.6 + p.count * 0.9);
    const op = kind === 'normal' ? 0.55 : 0.95;
    body += `<path class="flow ${recent ? 'recent' : ''} ${p.relay ? 'relay' : ''}" d="M${sx},${sy} Q${cx},${cy} ${ex},${ey}" stroke="${COL[kind]}" stroke-width="${w}" opacity="${op}" marker-end="url(#ah-${kind})"/>`;
    if (p.count > 1) {
      const mx = 0.25 * sx + 0.5 * cx + 0.25 * ex, my = 0.25 * sy + 0.5 * cy + 0.25 * ey;
      body += `<g class="cnt"><circle cx="${mx}" cy="${my}" r="9"/><text x="${mx}" y="${my}">${p.count}</text></g>`;
    }
  }
  svg.innerHTML = defs + body;
}
new ResizeObserver(() => drawArrows()).observe($('bd-map-wrap'));

// 마지막 갱신 시각
setInterval(() => {
  if (!state.snap) return;
  const sec = Math.round((Date.now() - (state.snap.board?.now || Date.now())) / 1000);
  $('bd-clock').textContent = `${new Date().toLocaleTimeString('ko-KR', { hour12: false })} · ${sec < 30 ? '실시간 연결됨' : `${sec}초 전 갱신`}`;
}, 1000);

$('bd-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('board').requestFullscreen?.();
});
document.addEventListener('fullscreenchange', () => {
  $('bd-full').textContent = document.fullscreenElement ? '⤫ 전체 화면 끄기' : '⛶ 전체 화면';
  setTimeout(() => drawArrows(), 100);
});

// ---------- 1:1 문의 ----------
function renderChats() {
  const chats = state.snap.chats;
  $('chat-empty').hidden = chats.length > 0;
  $('chat-list').innerHTML = chats
    .map((c) => {
      const last = c.messages.at(-1);
      if (last) last.shown = last.delivered ?? last.text; // 목록에도 다듬어진 문장을 보여준다
      return `<li><button data-room="${c.userId}" class="${c.userId === state.room ? 'on' : ''}">
        <span class="room-unit">${esc(c.unit)}호 ${c.active ? '' : '<span class="tag">등록 해제</span>'}</span>
        <span class="room-last">${esc(last?.shown || '')}</span>
        ${c.unread ? `<span class="count">${c.unread}</span>` : ''}
      </button></li>`;
    })
    .join('');
  $('chat-list').querySelectorAll('[data-room]').forEach((b) => b.addEventListener('click', () => openRoom(b.dataset.room)));
  renderRoom();
}

function openRoom(id) {
  state.room = id;
  markRead(id);
  renderChats();
  $('room-input').focus();
}

function markRead(id) {
  const chat = state.snap?.chats.find((c) => c.userId === id);
  if (chat?.unread) api(`chats/${id}/read`, {}).catch(() => {});
}

function renderRoom() {
  const chat = state.snap.chats.find((c) => c.userId === state.room);
  $('room-form').hidden = !chat || !chat.active;
  if (!chat) {
    $('room-title').textContent = '대화를 골라 주세요';
    $('room-status').textContent = '';
    $('room-log').innerHTML = '';
    return;
  }
  $('room-title').textContent = `${chat.unit}호 주민`;
  $('room-status').textContent = chat.active ? '앱 사용 중' : '등록을 해제해서 답장할 수 없어요';
  const who = { user: `<span class="who">${esc(chat.unit)}호 주민</span>`, bot: '<span class="who">🤖 챗봇</span>', admin: '<span class="who">🏢 관리사무소</span>' };
  // 관리사무소 화면에서는 관리사무소 메시지를 오른쪽에 둔다
  const side = { user: 'bot', bot: 'bot', admin: 'user' };
  const log = $('room-log');
  // 주민 메시지는 다듬어진 문장을 기본으로 보여주고, 원문은 눌러야 펼쳐진다
  log.innerHTML = chat.messages
    .map((m) => {
      const body = esc(m.delivered ?? m.text).replace(/\n/g, '<br>');
      let extra = '';
      if (m.from === 'user' && m.filtered) {
        const open = state.openOriginals.has(m.id);
        extra = `<span class="tag warn">🛡️ 다듬어짐</span> <button class="link" data-orig="${m.id}">${open ? '원문 접기' : '원문 보기'}</button>${open ? `<span class="orig">${esc(m.text)}</span>` : ''}`;
      }
      return `<div class="msg ${side[m.from]} from-${m.from}">${who[m.from]}${body}${extra ? `<br>${extra}` : ''}</div>`;
    })
    .join('');
  log.querySelectorAll('[data-orig]').forEach((b) => b.addEventListener('click', () => toggleOriginal(b.dataset.orig, renderRoom, false)));
  log.scrollTop = log.scrollHeight;
  if (state.tab === 'chat' && chat.unread) markRead(chat.userId);
}

$('room-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('room-input').value.trim();
  if (!text || !state.room) return;
  $('room-input').value = '';
  await api(`chats/${state.room}`, { text }).catch((err) => toast(err.message));
});

function toggleOriginal(id, rerender, keepScroll = true) {
  if (state.openOriginals.has(id)) state.openOriginals.delete(id);
  else state.openOriginals.add(id);
  const y = scrollY;
  rerender();
  if (keepScroll) scrollTo(0, y);
}

// ---------- 연락 요청 (앱 미가입 세대) ----------
const RELAY_TAG = { open: '<span class="tag red">연락 전</span>', contacted: '<span class="tag ok">연락함</span>', closed: '<span class="tag">처리 끝</span>' };

function renderRelays() {
  const list = state.snap.relays;
  const open = list.filter((r) => r.status === 'open').length;
  $('relay-open').hidden = !open;
  $('relay-open').textContent = open;
  $('relay-empty').hidden = list.length > 0;
  const ul = $('relay-list');
  if (ul.contains(document.activeElement)) return; // 메모 입력 중에는 다시 그리지 않는다
  ul.innerHTML = list
    .map((r) => {
      const to = r.around ? '주변 세대 (앱 쓰는 집 없음)' : `${esc(r.toUnit)}호${r.dir ? ` · ${{ up: '윗집', down: '아랫집', left: '옆집', right: '옆집' }[r.dir]}` : ''}`;
      return `<li>
        <div class="a-item-main" style="width:100%">
          <div>${r.emoji} <b>${to}</b>에 <b>${esc(r.typeLabel)}</b> 민원 ${RELAY_TAG[r.status]} ${r.night ? '<span class="tag night">🌙 조용한 시간</span>' : ''}</div>
          <div class="muted small">${esc(r.fromUnit)}호가 보냄 · ${clock(r.createdAt)}${r.handledAt ? ` · 처리 ${clock(r.handledAt)}` : ''}</div>
          ${r.message ? `<div class="f-text">${esc(r.message)}</div>` : ''}
          ${r.note ? `<div class="muted small">메모: ${esc(r.note)}</div>` : ''}
          ${r.status === 'open' ? `<input class="note" data-note="${r.id}" maxlength="100" placeholder="보낸 세대에 전할 메모 (선택) 예: 인터폰으로 전달했어요" />` : ''}
        </div>
        ${
          r.status === 'open'
            ? `<div class="a-item-actions">
                <button class="btn primary small auto" data-relay="${r.id}" data-action="contacted">연락했어요</button>
                <button class="btn ghost small" data-relay="${r.id}" data-action="closed">처리 끝</button>
              </div>`
            : ''
        }
      </li>`;
    })
    .join('');
  ul.querySelectorAll('[data-relay]').forEach((b) =>
    b.addEventListener('click', async () => {
      const note = ul.querySelector(`[data-note="${b.dataset.relay}"]`)?.value || '';
      try {
        const r = await api(`relays/${b.dataset.relay}`, { action: b.dataset.action, note });
        toast(r.notified ? '민원을 보낸 세대에 알렸어요' : '처리했어요 (보낸 주민이 등록을 해제해서 알림은 못 보냈어요)');
      } catch (e) {
        toast(e.message);
      }
    }),
  );
}

// ---------- 메시지 필터 ----------
const KIND_LABEL = { neighbor: '✉️ 이웃 메시지', reply: '↩️ 직접 쓴 답장', notice: '🙏 양해 공지', office: '🏢 관리사무소 문의' };
const SEVERITY = { none: '<span class="tag ok">문제 없음</span>', mild: '<span class="tag warn">감정 표현 다듬음</span>', severe: '<span class="tag red">욕설·공격 다듬음</span>' };

function renderFilter() {
  const { filterLog, llm } = state.snap;
  $('llm-status').textContent = llm.enabled ? `AI 필터 사용 중 · ${llm.model}` : llm.demo ? '정적 데모 · 규칙 필터로 동작 (원래 버전은 AI가 다듬어요)' : 'AI 키 없음 · 기본 규칙 필터로 동작 중';
  $('llm-status').className = `tag ${llm.enabled ? 'ok' : 'warn'}`;
  const flagged = filterLog.filter((f) => f.blocked || f.severity === 'severe').length;
  $('filter-flag').hidden = !flagged;
  $('filter-flag').textContent = flagged;
  const list = filterLog.filter((f) =>
    state.filterView === 'blocked' ? f.blocked : state.filterView === 'changed' ? f.delivered !== f.original : true,
  );
  $('filter-empty').hidden = list.length > 0;
  $('filter-list').innerHTML = list
    .map((f) => {
      const open = state.openOriginals.has(f.id);
      const changed = f.delivered !== f.original;
      return `<li>
        <div class="f-head">
          <b>${KIND_LABEL[f.kind]}</b>
          <span class="muted">${esc(f.fromUnit)}호 → ${esc(f.toUnit)} · ${clock(f.at)}</span>
          ${f.blocked ? '<span class="tag red">전달 차단</span>' : ''}${SEVERITY[f.severity] || ''}
          <span class="tag">${f.source === 'llm' ? 'AI' : f.fallback ? '규칙 (AI 실패)' : '규칙'}</span>
        </div>
        <div class="f-text"><b>${f.blocked ? '다듬은 문장 (전달 안 됨)' : '전달된 문장'}</b>${esc(f.delivered)}</div>
        ${f.reason ? `<div class="f-reason muted small">💡 ${esc(f.reason)}</div>` : ''}
        ${changed ? `<button class="link" data-orig="${f.id}">${open ? '원문 접기' : '🔒 원문 보기 (관리사무소만)'}</button>` : '<div class="muted small">원문과 같아요</div>'}
        ${open ? `<div class="f-text original"><b>원문</b>${esc(f.original)}</div>` : ''}
      </li>`;
    })
    .join('');
  $('filter-list').querySelectorAll('[data-orig]').forEach((b) => b.addEventListener('click', () => toggleOriginal(b.dataset.orig, renderFilter)));
}
document.querySelectorAll('input[name=ff]').forEach((r) =>
  r.addEventListener('change', () => {
    state.filterView = r.value;
    renderFilter();
  }),
);

// ---------- 세대 QR ----------
function unitUrl(code) {
  return new URL(`app.html?code=${code}`, location.href).href;
}

function renderCodes() {
  const s = state.snap;
  const units = s.config.layout.cells.filter(Boolean);
  const sig = JSON.stringify([units, s.unitCodes, s.households, s.config.name]);
  if (sig === state.codesSig) return; // 바뀐 게 없으면 QR을 다시 만들지 않는다
  state.codesSig = sig;
  $('codes-origin').textContent = `QR 주소: ${unitUrl('…')} — 터널 주소는 켤 때마다 바뀌니, 인쇄용은 고정 주소에서 만드세요.`;
  const grid = $('codes-grid');
  grid.innerHTML = units
    .map((u) => {
      const n = s.households[u] || 0;
      return `<div class="code-card">
        <div class="bname">${esc(s.config.name)}</div>
        <div class="unit-no">${esc(u)}호</div>
        <div class="qr" data-code="${esc(s.unitCodes[u])}"></div>
        <code>${esc(s.unitCodes[u])}</code>
        <div class="meta">${n ? `가족 ${n}명 등록` : '아직 등록 없음'}</div>
        <button class="btn ghost small" data-reissue="${esc(u)}">다시 발급</button>
      </div>`;
    })
    .join('');
  grid.querySelectorAll('.qr').forEach((el) => {
    if (window.QRCode) new QRCode(el, { text: unitUrl(el.dataset.code), width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
    else el.textContent = 'QR 라이브러리를 불러오지 못했어요';
  });
  grid.querySelectorAll('[data-reissue]').forEach((b) =>
    b.addEventListener('click', async () => {
      const u = b.dataset.reissue;
      if (b.dataset.confirm !== '1') {
        b.dataset.confirm = '1';
        b.textContent = '정말 다시 발급?';
        b.classList.add('danger-text');
        return;
      }
      try {
        const r = await api(`codes/${encodeURIComponent(u)}/reissue`, {});
        toast(`${u}호 QR을 새로 발급했어요${r.kicked ? ` · 등록된 ${r.kicked}명은 새 QR로 다시 등록해야 해요` : ''}`);
      } catch (e) {
        toast(e.message);
      }
    }),
  );
}
$('codes-print').addEventListener('click', () => print());

// ---------- 신고 ----------
const REPORT_STATUS = { open: '<span class="tag red">처리 전</span>', blocked: '<span class="tag">제한함</span>', dismissed: '<span class="tag">무시함</span>' };

function renderReports() {
  const { reports, blocked } = state.snap;
  $('report-empty').hidden = reports.length > 0;
  $('report-list').innerHTML = reports
    .map(
      (r) => `<li>
        <div class="a-item-main">
          <div><b>${esc(r.senderUnit)}호</b>가 보낸 <b>${esc(r.alertLabel)}</b> 알림 ${REPORT_STATUS[r.status]}</div>
          <div class="muted small">${clock(r.at)} · ${esc(r.reporterUnit)}호 신고 · "${esc(r.reasonText)}" · 이 주민 누적 ${r.senderCount}건${r.senderBlocked ? ' · 제한 중' : ''}</div>
        </div>
        ${
          r.status === 'open'
            ? `<div class="a-item-actions">
                ${r.senderBlocked ? '' : `<button class="btn ghost small danger-text" data-report="${r.id}" data-action="block">알림 제한</button>`}
                <button class="btn ghost small" data-report="${r.id}" data-action="dismiss">무시</button>
              </div>`
            : ''
        }
      </li>`,
    )
    .join('');
  $('report-list').querySelectorAll('[data-report]').forEach((b) =>
    b.addEventListener('click', () => api(`reports/${b.dataset.report}`, { action: b.dataset.action }).catch((e) => toast(e.message))),
  );

  $('blocked-empty').hidden = blocked.length > 0;
  $('blocked-list').innerHTML = blocked
    .map(
      (b) => `<li>
        <div class="a-item-main">
          <div><b>${esc(b.unit ?? '-')}호</b> 주민 (제한 당시)</div>
          <div class="muted small">${clock(b.at)} · ${esc(b.reason)}</div>
        </div>
        <div class="a-item-actions"><button class="btn ghost small" data-unblock="${esc(b.deviceId)}">제한 해제</button></div>
      </li>`,
    )
    .join('');
  $('blocked-list').querySelectorAll('[data-unblock]').forEach((b) =>
    b.addEventListener('click', () => api('unblock', { deviceId: b.dataset.unblock }).then(() => toast('제한을 풀었어요')).catch((e) => toast(e.message))),
  );
}

// ---------- 공지 ----------
function renderNotices() {
  const list = state.snap.notices;
  const now = Date.now();
  $('an-empty').hidden = list.length > 0;
  $('an-list').innerHTML = list
    .map(
      (n) => `<li>
        <div class="a-item-main">
          <div>${n.emoji} <b>${esc(n.label)}</b> · ${n.byAdmin ? '🏢 관리사무소' : `${esc(n.unit)}호`} ${n.startAt <= now ? '<span class="tag">진행 중</span>' : ''}</div>
          <div class="muted small">${clock(n.startAt)} ~ ${hhmm(n.endAt)}${n.text ? ` · ${esc(n.text)}` : ''}${n.thanks ? ` · 👍 ${n.thanks}` : ''}</div>
        </div>
        <div class="a-item-actions"><button class="btn ghost small danger-text" data-del="${n.id}">내리기</button></div>
      </li>`,
    )
    .join('');
  $('an-list').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => api(`notices/${b.dataset.del}/delete`, {}).then(() => toast('공지를 내렸어요')).catch((e) => toast(e.message))),
  );
}

$('an-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const [y, mo, dd] = $('an-date').value.split('-').map(Number);
  const base = new Date(y, mo - 1, dd);
  const at = (v) => {
    const [h, m] = v.split(':').map(Number);
    const d = new Date(base);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const startAt = at($('an-start').value);
  let endAt = at($('an-end').value);
  if (endAt <= startAt) endAt += 86_400_000;
  try {
    await api('notices', { type: $('an-type').value, text: $('an-text').value, startAt, endAt });
    $('an-text').value = '';
    $('an-msg').textContent = '';
    toast('모든 주민에게 공지했어요');
  } catch (err) {
    $('an-msg').textContent = err.message;
  }
});

// ---------- 세대 배치 편집 (레고) ----------
const TOOL_HINT = {
  place: '빈 칸을 누르거나 문질러서 세대를 놓아요. 호수는 층·라인에 맞춰 자동으로 붙어요.',
  erase: '세대를 누르거나 문질러서 지워요 (상가·필로티·엘리베이터 자리 등).',
  move: '세대를 끌어서 다른 칸에 놓아요. 세대가 있는 칸에 놓으면 서로 자리를 바꿔요.',
  edit: '세대를 누르고 아래에서 호수를 고쳐요.',
};
state.tool = 'place';
state.axis = null; // { kind: 'row' | 'col', index }

// 칸 위치로 기본 호수 계산: 그 줄의 층 번호(없으면 가까운 층에서 한 층씩 세어서) + 라인 번호
function floorNum(L, r) {
  const rowNum = (rr) => {
    const m = mode(numeric(L.cells.slice(rr * L.cols, rr * L.cols + L.cols)).map((l) => Number(l.slice(0, -2))));
    return m ? Number(m) : null;
  };
  for (let d = 0; d < L.rows; d++) {
    if (r + d < L.rows && rowNum(r + d) != null) return rowNum(r + d) + d; // 아래층 + d
    if (r - d >= 0 && rowNum(r - d) != null) return rowNum(r - d) - d; // 위층 - d
  }
  return L.rows - r;
}
function lineNum(L, c) {
  const col = [];
  for (let r = 0; r < L.rows; r++) col.push(L.cells[r * L.cols + c]);
  const m = mode(numeric(col).map((l) => Number(l.slice(-2))));
  return m ? Number(m) : c + 1;
}
const autoLabel = (i, L = state.layout) =>
  `${floorNum(L, Math.floor(i / L.cols))}${String(lineNum(L, i % L.cols)).padStart(2, '0')}`;

function renderLayout() {
  const L = state.layout;
  if (!L) return;
  const busy = new Set(state.snap.active);
  const labels = L.cells.filter(Boolean);
  const dups = new Set(labels.filter((l, i) => labels.indexOf(l) !== i));
  const grid = $('lay-grid');
  grid.style.gridTemplateColumns = `auto repeat(${L.cols}, minmax(52px, 1fr))`;
  let html = '<div class="corner">층 \\ 라인</div>';
  for (let c = 0; c < L.cols; c++) {
    const on = state.axis?.kind === 'col' && state.axis.index === c;
    html += `<button type="button" class="axis col ${on ? 'on' : ''}" data-col="${c}">${esc(colLabel(L, c))} ▾</button>`;
  }
  for (let r = 0; r < L.rows; r++) {
    const on = state.axis?.kind === 'row' && state.axis.index === r;
    html += `<button type="button" class="axis ${on ? 'on' : ''}" data-row="${r}">${esc(floorLabel(L.cells.slice(r * L.cols, r * L.cols + L.cols), r, L.rows))} ▸</button>`;
    for (let c = 0; c < L.cols; c++) {
      const i = r * L.cols + c;
      const label = L.cells[i];
      const cls = ['brick', label && 'filled', label && busy.has(label) && 'busy', label && dups.has(label) && 'dup', i === state.selected && 'selected'].filter(Boolean).join(' ');
      html += `<button type="button" class="${cls}" data-i="${i}" title="${label ? `${esc(label)}호` : '빈 칸'}">${label ? esc(label) : '+'}</button>`;
    }
  }
  grid.innerHTML = html;
  grid.querySelectorAll('[data-row]').forEach((b) => b.addEventListener('click', () => openAxis('row', Number(b.dataset.row))));
  grid.querySelectorAll('[data-col]').forEach((b) => b.addEventListener('click', () => openAxis('col', Number(b.dataset.col))));
  renderAxisMenu();

  document.querySelectorAll('.lego-tools .tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool)));
  $('lay-hint').textContent = TOOL_HINT[state.tool];
  const sel = state.tool === 'edit' && state.selected != null ? L.cells[state.selected] : null;
  $('lay-edit').hidden = !sel;
  if (sel && document.activeElement !== $('lay-label')) $('lay-label').value = sel;
  $('lay-size').textContent = `${L.rows}층 × ${L.cols}라인`;
  $('lay-count').textContent = `세대 ${labels.length}개${dups.size ? ` · 겹치는 호수 ${[...dups].join(', ')}` : ''}${state.layoutDirty ? ' · 저장 안 됨' : ''}`;
}

function markLayoutDirty() {
  state.layoutDirty = true;
  $('lay-msg').textContent = '';
  renderLayout();
}

document.querySelectorAll('.lego-tools .tool').forEach((b) =>
  b.addEventListener('click', () => {
    state.tool = b.dataset.tool;
    state.selected = null;
    renderLayout();
  }),
);

// 누르고 문지르기(놓기·지우기), 끌어서 옮기기 — 마우스와 터치 모두 pointer 이벤트로 처리
const drag = { active: false, from: null, over: null };
const cellAt = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#lay-grid [data-i]');

function paint(i) {
  const L = state.layout;
  if (state.tool === 'place' && !L.cells[i]) L.cells[i] = autoLabel(i);
  else if (state.tool === 'erase' && L.cells[i]) L.cells[i] = null;
  else return false;
  return true;
}

$('lay-grid').addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-i]');
  if (!el) return;
  e.preventDefault();
  const i = Number(el.dataset.i);
  state.axis = null;
  if (state.tool === 'edit') {
    state.selected = state.layout.cells[i] ? (state.selected === i ? null : i) : null;
    return renderLayout();
  }
  if (state.tool === 'move') {
    if (!state.layout.cells[i]) return;
    drag.active = true;
    drag.from = i;
    el.classList.add('drag-from');
    return;
  }
  drag.active = true;
  if (paint(i)) markLayoutDirty();
});

$('lay-grid').addEventListener('pointermove', (e) => {
  if (!drag.active) return;
  const el = cellAt(e);
  if (!el) return;
  const i = Number(el.dataset.i);
  if (state.tool === 'move') {
    if (drag.over === i) return;
    $('lay-grid').querySelector('.drop-to')?.classList.remove('drop-to');
    if (i !== drag.from) el.classList.add('drop-to');
    drag.over = i;
  } else if (paint(i)) markLayoutDirty();
});

addEventListener('pointerup', (e) => {
  if (!drag.active) return;
  drag.active = false;
  if (state.tool === 'move' && drag.from != null) {
    const el = cellAt(e);
    const to = el ? Number(el.dataset.i) : null;
    const cells = state.layout.cells;
    if (to != null && to !== drag.from) {
      [cells[to], cells[drag.from]] = [cells[drag.from], cells[to]];
      drag.from = null;
      drag.over = null;
      return markLayoutDirty();
    }
  }
  drag.from = null;
  drag.over = null;
  renderLayout();
});

// 층·라인 머리글 메뉴: 그 자리에 넣기·복제·빼기
function openAxis(kind, index) {
  state.axis = state.axis?.kind === kind && state.axis.index === index ? null : { kind, index };
  state.selected = null;
  renderLayout();
}

function renderAxisMenu() {
  const box = $('lay-axis');
  const a = state.axis;
  box.hidden = !a;
  if (!a) return;
  const L = state.layout;
  if (a.kind === 'row') {
    const name = floorLabel(L.cells.slice(a.index * L.cols, a.index * L.cols + L.cols), a.index, L.rows);
    box.innerHTML = `<b>${esc(name)}</b>
      <button class="btn ghost small" data-op="row-above">위에 층 넣기</button>
      <button class="btn ghost small" data-op="row-below">아래에 층 넣기</button>
      <button class="btn ghost small" data-op="row-copy">이 층 모양 위로 복제</button>
      <button class="btn ghost small danger-text" data-op="row-del">이 층 빼기</button>`;
  } else {
    box.innerHTML = `<b>${esc(colLabel(L, a.index))} 라인</b>
      <button class="btn ghost small" data-op="col-left">왼쪽에 라인 넣기</button>
      <button class="btn ghost small" data-op="col-right">오른쪽에 라인 넣기</button>
      <button class="btn ghost small danger-text" data-op="col-del">이 라인 빼기</button>`;
  }
  box.querySelectorAll('[data-op]').forEach((b) => b.addEventListener('click', () => axisOp(b.dataset.op)));
}

function axisOp(op) {
  const L = state.layout;
  const { index } = state.axis;
  const rows = [];
  for (let r = 0; r < L.rows; r++) rows.push(L.cells.slice(r * L.cols, r * L.cols + L.cols));
  const empty = () => Array(L.cols).fill(null);
  let cols = L.cols;
  if (op === 'row-above' || op === 'row-below' || op === 'row-copy') {
    if (rows.length >= 50) return toast('층은 50개까지 만들 수 있어요');
    const at = op === 'row-below' ? index + 1 : index;
    const shape = op === 'row-copy' ? rows[index].map((l) => (l ? '?' : null)) : empty();
    rows.splice(at, 0, shape);
  } else if (op === 'row-del') {
    if (rows.length <= 1) return toast('층이 하나는 있어야 해요');
    rows.splice(index, 1);
  } else if (op === 'col-left' || op === 'col-right') {
    if (cols >= 10) return toast('라인은 10개까지 만들 수 있어요');
    const at = op === 'col-right' ? index + 1 : index;
    rows.forEach((row) => row.splice(at, 0, null));
    cols++;
  } else if (op === 'col-del') {
    if (cols <= 1) return toast('라인이 하나는 있어야 해요');
    rows.forEach((row) => row.splice(index, 1));
    cols--;
  }
  state.layout = { rows: rows.length, cols, cells: rows.flat() };
  // 복제한 층은 위치에 맞는 호수로 채운다
  state.layout.cells = state.layout.cells.map((l, i) => (l === '?' ? autoLabel(i) : l));
  state.axis = null;
  state.selected = null;
  markLayoutDirty();
}

$('lay-add-top').addEventListener('click', () => {
  state.axis = { kind: 'row', index: 0 };
  axisOp('row-above');
});
$('lay-add-right').addEventListener('click', () => {
  state.axis = { kind: 'col', index: state.layout.cols - 1 };
  axisOp('col-right');
});

$('lay-label').addEventListener('input', () => {
  if (state.selected == null) return;
  state.layout.cells[state.selected] = $('lay-label').value.trim() || state.layout.cells[state.selected];
  markLayoutDirty();
});

$('lay-delete').addEventListener('click', () => {
  if (state.selected == null) return;
  state.layout.cells[state.selected] = null;
  state.selected = null;
  markLayoutDirty();
});

// 다시 매기기: 맨 아래 줄 = 가장 낮은 층 번호(지금 배치 기준, 없으면 1층)부터 위로 한 층씩, 라인은 왼쪽부터 1호
$('lay-renumber').addEventListener('click', () => {
  const L = state.layout;
  const nums = numeric(L.cells.slice((L.rows - 1) * L.cols)).map((l) => Number(l.slice(0, -2)));
  const bottom = nums.length ? Number(mode(nums)) : 1;
  state.layout.cells = L.cells.map((l, i) => (l ? `${bottom + (L.rows - 1 - Math.floor(i / L.cols))}${String((i % L.cols) + 1).padStart(2, '0')}` : null));
  markLayoutDirty();
});
$('lay-fill').addEventListener('click', () => {
  state.layout.cells = state.layout.cells.map((l, i) => l || autoLabel(i));
  markLayoutDirty();
});
$('lay-reset').addEventListener('click', () => {
  state.layoutDirty = false;
  state.layout = structuredClone(state.snap.config.layout);
  state.selected = null;
  state.axis = null;
  $('lay-msg').textContent = '';
  renderLayout();
});

$('lay-save').addEventListener('click', async () => {
  try {
    const res = await api('layout', state.layout);
    // 실시간 갱신이 저장 응답보다 먼저 올 수 있으므로 여기서 직접 다시 그린다
    state.layoutDirty = false;
    state.selected = null;
    renderLayout();
    toast(res.kicked.length ? `저장했어요. ${res.kicked.join(', ')}호 주민은 다시 등록해야 해요.` : '세대 배치를 저장했어요');
  } catch (err) {
    $('lay-msg').textContent = err.message;
  }
});

// ---------- FAQ ----------
function renderFaqs() {
  if (!state.faqs) return;
  const list = $('faq-list');
  if (list.contains(document.activeElement)) return; // 입력 중에는 다시 그리지 않는다
  list.innerHTML = '';
  state.faqs.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'faq-edit';
    row.innerHTML = `
      <input type="text" maxlength="80" placeholder="질문" value="${esc(f.q)}" data-k="q" />
      <textarea rows="2" maxlength="500" placeholder="답변" data-k="a">${esc(f.a)}</textarea>
      <button type="button" class="btn ghost small" data-del>삭제</button>`;
    row.querySelectorAll('[data-k]').forEach((el) =>
      el.addEventListener('input', () => {
        state.faqs[i][el.dataset.k] = el.value;
        state.faqDirty = true;
      }),
    );
    row.querySelector('[data-del]').addEventListener('click', () => {
      state.faqs.splice(i, 1);
      state.faqDirty = true;
      renderFaqs();
    });
    list.appendChild(row);
  });
}

$('faq-add').addEventListener('click', () => {
  state.faqs.push({ q: '', a: '' });
  state.faqDirty = true;
  renderFaqs();
  $('faq-list').lastElementChild?.querySelector('input')?.focus();
});

$('faq-save').addEventListener('click', async () => {
  try {
    const res = await api('faqs', { faqs: state.faqs });
    state.faqDirty = false;
    state.faqs = res.faqs;
    document.activeElement?.blur();
    renderFaqs();
    $('faq-msg').textContent = '';
    toast(`질문 ${res.faqs.length}개를 저장했어요`);
  } catch (err) {
    $('faq-msg').textContent = err.message;
  }
});

// ---------- 설정 ----------
function renderSettings() {
  const s = state.snap;
  $('addr-user').textContent = new URL('app.html', location.href).href;
  $('addr-admin').textContent = new URL('admin.html', location.href).href;
  $('link-user').href = 'app.html';
  if (state.settingsDirty) return;
  $('set-name').value = s.config.name;
  $('set-manual').checked = s.config.allowManualJoin;
  const hours = (sel) => Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${h}시</option>`).join('');
  $('set-qs').innerHTML = hours(s.config.quietStart);
  $('set-qe').innerHTML = hours(s.config.quietEnd);
}
$('settings-form').addEventListener('input', () => (state.settingsDirty = true));
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('settings', {
      name: $('set-name').value,
      quietStart: Number($('set-qs').value),
      quietEnd: Number($('set-qe').value),
      allowManualJoin: $('set-manual').checked,
    });
    state.settingsDirty = false;
    $('set-msg').textContent = '';
    toast('설정을 저장했어요');
  } catch (err) {
    $('set-msg').textContent = err.message;
  }
});

// ---------- 시작 ----------
async function init() {
  if (!SLUG) return;
  const cfg = await fetch(`${API}/config`).then((r) => (r.ok ? r.json() : null));
  if (!cfg) {
    $('gate').hidden = false;
    $('gate-building').textContent = '없는 건물이에요.';
    $('gate-form').hidden = true;
    return;
  }
  state.config = cfg;
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const max = new Date();
  max.setDate(max.getDate() + cfg.noticeMaxDays);
  Object.assign($('an-date'), { value: ymd(new Date()), min: ymd(new Date()), max: ymd(max) });
  $('gate-building').textContent = cfg.name;
  $('an-type').innerHTML = Object.entries(cfg.noticeTypes)
    .map(([k, t]) => `<option value="${k}" ${k === 'construction' ? 'selected' : ''}>${t.emoji} ${t.label}</option>`)
    .join('');
  // 등록 직후 링크(#key=...)로 들어오면 키를 저장하고 주소창에서 지운다
  const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
  if (hashKey) history.replaceState(null, '', location.pathname);
  const key = hashKey || localStorage.getItem(KEY_STORE) || DEMO_ADMIN_KEY; // 데모: 키 없이 바로 들어간다
  if (key) start(key);
  else $('gate').hidden = false;
}

init();
