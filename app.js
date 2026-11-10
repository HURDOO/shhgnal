// 쉿!그널 주민 앱 (정적 데모: 서버 대신 mock-server.js가 브라우저 안에서 API를 처리)
import { DEMO_SLUG } from './mock-server.js';
const $ = (id) => document.getElementById(id);

const SLUG = DEMO_SLUG;
const API = `api/b/${SLUG}`;
// 데모에서는 브라우저 탭 하나가 한 세대의 폰이다. 주소의 ?unit=호수 별로 등록 정보를 따로 둔다.
let slot = new URLSearchParams(location.search).get('unit') || 'default';
const TOKEN_KEY = () => `knock-token-${SLUG}-${slot}`;
const DEVICE_KEY = (u = slot) => `knock-device-${u}`; // 기기 식별 (신고 누적 제한용, 등록 해제해도 유지)
const SEEN_ADMIN_KEY = () => `knock-seen-admin-${SLUG}-${slot}`; // 마지막으로 확인한 관리사무소 답변 id
// 등록한 호수로 이 탭의 자리를 옮기고 주소를 ?unit=호수로 맞춘다 (새로고침해도 같은 세대로 열리게)
function bindUnit(unit, token) {
  if (slot !== unit) {
    localStorage.removeItem(TOKEN_KEY());
    slot = unit;
  }
  localStorage.setItem(TOKEN_KEY(), token);
  history.replaceState(null, '', `${location.pathname}?unit=${encodeURIComponent(unit)}`);
}
const safeGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const DIR_LABEL = { up: '윗집', down: '아랫집', left: '옆집', right: '옆집' };

const state = {
  config: null,
  token: safeGet(TOKEN_KEY()),
  unit: null,
  active: [],
  history: [],
  relays: [], // 앱 미가입 세대로 보낸 민원 (관리사무소 경유)
  notices: [],
  cal: { month: null, day: null }, // 양해 공지 캘린더
  chat: [],
  blocked: false,
  pollRun: 0,
  swReg: null,
  pushOn: false, // 웹 푸시 구독 완료 여부 (앱이 닫혀도 알림 수신)
  installPrompt: null,
  code: new URLSearchParams(location.search).get('code'), // 세대 QR 등록 코드
  compose: { target: null, type: null, preview: null },
  notice: { type: null, day: 0 },
  incomingQueue: [],
  reportingId: null,
};

// 데모: 호수마다 다른 기기로 본다 (같은 브라우저의 여러 탭이 서로 다른 세대 역할을 하므로)
function deviceId(u = slot) {
  u = String(u).replace(/호$/, '');
  let id = localStorage.getItem(DEVICE_KEY(u));
  if (!id) {
    // randomUUID는 https·localhost에서만 있어서, 내부망 http 접속에서도 되는 getRandomValues를 쓴다
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(DEVICE_KEY(u), id);
  }
  return id;
}

// ---------- 공통 ----------
async function api(path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '요청에 실패했어요.');
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function show(view) {
  for (const v of ['missing', 'join', 'home']) $(`view-${v}`).hidden = v !== view;
}

const openSheet = (id) => ($(id).hidden = false);
const closeSheet = (id) => ($(id).hidden = true);
// 시트 바깥(어두운 배경)을 누르면 닫기
for (const id of ['compose', 'report', 'move', 'chat', 'notice-sheet', 'calendar']) {
  $(id).addEventListener('click', (e) => e.target === $(id) && closeSheet(id));
}
$('admin-reply').addEventListener('click', (e) => e.target === $('admin-reply') && closeAdminReply());

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  return ['오늘', '내일', '모레'][diff] || d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' });
}

function applyBuildingName() {
  document.querySelectorAll('[data-building-name]').forEach((el) => (el.textContent = state.config.name));
  document.title = `쉿!그널 · ${state.config.name}`;
}

// 호수가 모두 숫자면 숫자 키패드를 띄운다
function applyUnitInputMode() {
  const numeric = state.config.layout.cells.filter(Boolean).every((l) => /^\d+$/.test(l));
  for (const id of ['unit-input', 'move-input']) $(id).inputMode = numeric ? 'numeric' : 'text';
}

// 배치도에서 위·아래·양옆 세대
function neighbors(unit) {
  const { rows, cols, cells } = state.config.layout;
  const i = cells.indexOf(unit);
  if (i < 0) return {};
  const r = Math.floor(i / cols);
  const c = i % cols;
  const at = (rr, cc) => (rr >= 0 && rr < rows && cc >= 0 && cc < cols ? cells[rr * cols + cc] : null);
  return { up: at(r - 1, c), down: at(r + 1, c), left: at(r, c - 1), right: at(r, c + 1) };
}

// ---------- 조용한 시간 ----------
function seoulHour() {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Seoul' }).format(Date.now()));
}
function isQuietNow() {
  const { quietStart: s, quietEnd: e } = state.config;
  const h = seoulHour();
  return s > e ? h >= s || h < e : h >= s && h < e;
}
function renderQuiet() {
  const { quietStart: s, quietEnd: e } = state.config;
  const quiet = isQuietNow();
  const el = $('quiet-banner');
  el.classList.toggle('on', quiet);
  el.textContent = quiet
    ? `🌙 지금은 조용한 시간이에요 (${s}시~${e}시). 작은 소리도 크게 울려요.`
    : `☀️ 조용한 시간은 ${s}시부터 ${e}시까지예요.`;
}
setInterval(() => state.config && state.token && renderQuiet(), 60_000);

// ---------- 알림 권한 / 서비스워커 / 푸시 ----------
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    state.swReg = await navigator.serviceWorker.register('sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open-alert') openIncomingById(e.data.id);
      if (e.data?.type === 'open-chat') openChat();
      if (e.data?.type === 'replied') applyAlertUpdate(e.data.alert);
      if (e.data?.type === 'do-reply' && e.data.url === location.pathname + location.search) sendReply(e.data.id, e.data.reply); // 알림의 답장 버튼
    });
  } catch (e) {
    console.warn('서비스워커 등록 실패', e);
  }
}

async function requestNotify() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  }
  return Notification.permission;
}

const isIOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// 웹 푸시 구독 → 서버에 등록. 서버가 재시작돼도 다시 등록되도록 들어올 때마다 호출한다.
async function subscribePush() {
  state.pushOn = false;
  if (!state.config.vapidPublicKey) return false; // 정적 데모: 웹 푸시 없음 (열려 있는 탭이 알림을 띄운다)
  if (!('PushManager' in window) || Notification.permission !== 'granted' || !state.token) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const key = urlBase64ToUint8Array(state.config.vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    // 서버 키가 바뀌었으면 기존 구독은 못 쓰므로 새로 만든다
    const oldKey = sub?.options?.applicationServerKey;
    if (sub && oldKey && new Uint8Array(oldKey).toString() !== key.toString()) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('push/subscribe', { token: state.token, subscription: sub.toJSON() });
    state.pushOn = true;
  } catch (e) {
    console.warn('푸시 구독 실패', e);
  }
  return state.pushOn;
}

function renderNotifStatus() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const badge = $('notif-badge');
  badge.textContent = state.pushOn ? '🔔 푸시 켜짐' : perm === 'granted' ? '🔔 앱 알림' : '🔕 알림 꺼짐';
  badge.classList.toggle('off', !state.pushOn);

  let warn = null;
  if (!window.isSecureContext) warn = 'https 주소로 접속해야 푸시 알림을 받을 수 있어요. 지금은 앱을 열어둔 동안만 알림이 떠요.';
  else if (isIOS && !isStandalone) warn = '아이폰은 공유 버튼 → "홈 화면에 추가" 후, 홈 화면 아이콘으로 열어야 알림을 받을 수 있어요.';
  else if (perm === 'denied') warn = '알림이 차단돼 있어요. 브라우저 사이트 설정에서 알림을 허용해 주세요.';
  else if (perm === 'default') warn = state.config.demo ? '알림을 허용하면 다른 탭을 보고 있어도 이웃의 알림이 떠요. (데모는 이 탭이 열려 있을 때만)' : '알림을 허용하면 앱을 닫아도 이웃의 알림을 받을 수 있어요.';
  else if (!state.pushOn && !state.config.demo) warn = '푸시 등록에 실패해서 앱을 열어둔 동안만 알림이 떠요.';
  $('notif-warning').hidden = !warn;
  $('notif-warning-text').textContent = warn || '';
  $('notif-retry').hidden = perm !== 'default';
}

async function systemNotify(title, options) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = state.swReg || (await navigator.serviceWorker?.ready);
    if (reg) return reg.showNotification(title, options);
    new Notification(title, options); // 서비스워커가 없을 때 (데스크톱)
  } catch (e) {
    console.warn('알림 표시 실패', e);
  }
}

// ---------- 1. 세대 등록 / 호수 변경 / 등록 해제 ----------
$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('join-error').textContent = '';
  const unit = $('unit-input').value.trim();
  // 사용자 제스처 안에서 바로 권한을 요청해야 브라우저가 막지 않는다
  const permPromise = requestNotify();
  try {
    const res = await api('join', { unit, token: state.token, deviceId: deviceId(unit) });
    state.token = res.token;
    state.unit = res.unit;
    bindUnit(res.unit, res.token);
    enterHome();
    if (res.household > 1) toast(`${res.unit}호 가족 ${res.household}명이 함께 쓰고 있어요`);
    // 권한 팝업에 응답하지 않아도 등록은 진행하고, 응답이 오면 상태만 갱신
    permPromise.then(async () => {
      await subscribePush();
      renderNotifStatus();
    });
  } catch (err) {
    $('join-error').textContent = err.message;
  }
});

// 세대 QR로 등록 (코드 → 호수는 서버가 정한다)
$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('code-error').textContent = '';
  const permPromise = requestNotify();
  try {
    const res = await api('join', { code: state.code, token: state.token, deviceId: deviceId(state.codeUnit || slot) });
    state.token = res.token;
    state.unit = res.unit;
    state.code = null;
    bindUnit(res.unit, res.token); // 주소창에 코드가 남지 않게 ?unit=호수로 바꾼다
    enterHome();
    if (res.household > 1) toast(`${res.unit}호 가족 ${res.household}명이 함께 쓰고 있어요`);
    permPromise.then(async () => {
      await subscribePush();
      renderNotifStatus();
    });
  } catch (err) {
    $('code-error').textContent = err.message;
  }
});

// 등록 화면: 세대 QR이 있으면 확인 카드, 없으면 안내 (시연용 직접 입력이 켜져 있으면 입력칸)
async function renderJoin() {
  $('code-form').hidden = true;
  $('need-code').hidden = true;
  $('join-form').hidden = true;
  if (state.code) {
    try {
      const { unit } = await api(`unit-code?code=${encodeURIComponent(state.code)}`);
      $('code-unit').textContent = unit;
      state.codeUnit = unit;
      $('code-form').hidden = false;
      return;
    } catch (err) {
      state.code = null;
      history.replaceState(null, '', location.pathname);
      toast(err.message);
    }
  }
  if (state.config.allowManualJoin) $('join-form').hidden = false;
  else $('need-code').hidden = false;
}

function applyJoinMode() {
  $('move-btn').hidden = !state.config.allowManualJoin; // QR 등록 모드에서는 새 세대 QR을 찍어서 옮긴다
}

$('notif-retry').addEventListener('click', async () => {
  await requestNotify();
  await subscribePush();
  renderNotifStatus();
});

$('move-btn').addEventListener('click', () => {
  $('move-input').value = '';
  $('move-error').textContent = '';
  openSheet('move');
  $('move-input').focus();
});
$('move-cancel').addEventListener('click', () => closeSheet('move'));
$('move-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const unit = $('move-input').value.trim().replace(/호$/, '');
  if (unit === state.unit) return ($('move-error').textContent = '지금 등록된 호수예요.');
  try {
    const res = await api('join', { unit, token: state.token, deviceId: deviceId(unit) });
    closeSheet('move');
    bindUnit(res.unit, state.token);
    toast(`${res.unit}호로 바꿨어요`);
    state.incomingQueue = [];
    connect(); // 새 호수 기준으로 기록을 다시 받는다
  } catch (err) {
    $('move-error').textContent = err.message;
  }
});

$('leave-btn').addEventListener('click', async () => {
  await api('leave', { token: state.token }).catch(() => {});
  resetToJoin();
  $('unit-input').value = '';
  toast('등록을 해제했어요');
});

function resetToJoin() {
  state.pollRun++;
  state.token = null;
  state.unit = null;
  state.incomingQueue = [];
  localStorage.removeItem(TOKEN_KEY());
  for (const id of ['compose', 'incoming', 'report', 'move', 'chat', 'admin-reply', 'notice-sheet', 'calendar', 'vent']) closeSheet(id);
  show('join');
  renderJoin();
}

function enterHome() {
  $('my-unit').textContent = state.unit;
  renderNotifStatus();
  renderQuiet();
  show('home');
  connect();
  subscribePush().then(renderNotifStatus);
}

// ---------- 실시간 연결 (롱폴링) ----------
const handlers = {
  hello(d) {
    state.unit = d.unit;
    state.active = d.active;
    state.history = d.history;
    state.relays = d.relays || [];
    state.notices = d.notices;
    state.chat = d.chat;
    state.blocked = d.blocked;
    $('my-unit').textContent = d.unit;
    renderAll();
    renderChat();
    // 답장 안 한 받은 알림이 있으면 바로 보여준다
    const pending = d.history.filter((a) => a.direction === 'received' && !a.reply && !a.reported);
    if (pending.length && $('incoming').hidden) queueIncoming(pending.reverse());
    // 앱을 닫아둔 사이 온 관리사무소 답변도 팝업으로 알려준다
    checkAdminReplies();
  },

  state(d) {
    state.active = d.active;
    renderTargets();
    renderMap();
  },

  layout(d) {
    state.config.layout = d.layout;
    state.active = d.active;
    applyUnitInputMode();
    renderTargets();
    renderMap();
    toast('세대 배치가 바뀌었어요');
  },

  config(d) {
    Object.assign(state.config, d);
    applyBuildingName();
    applyJoinMode();
    renderFaqCards();
    renderQuiet();
  },

  // 3. 소음 알림 수신
  alert(a) {
    if (state.history.some((h) => h.id === a.id)) return;
    state.history.unshift(a);
    renderHistory();
    queueIncoming([a]);
    navigator.vibrate?.([120, 60, 120]);
    // 푸시가 켜져 있으면 서비스워커가 알림을 띄우므로, 여기서는 푸시가 없을 때만 대신 띄운다
    if (!state.pushOn)
      systemNotify(`${a.emoji} ${incomingTitle(a)}`, {
        body: alertSentence(a),
        tag: a.id,
        requireInteraction: true,
        data: { id: a.id, kind: 'alert', url: location.pathname + location.search },
        actions: [
          { action: 'sorry', title: '죄송해요, 조심할게요' },
          { action: 'notus', title: '저희 집 아니에요' },
        ],
      });
  },

  // 보낸 알림에 온 답장, 또는 가족이 대신 답장·신고한 경우
  reply(a) {
    applyAlertUpdate(a);
    if (a.direction === 'sent') {
      toast(`${a.toUnit}호: "${a.replyText}"`);
      if (!state.pushOn) systemNotify(`${a.toUnit}호에서 답장이 왔어요`, { body: a.replyText, tag: `reply-${a.id}` });
    } else if (state.incomingQueue.some((q) => q.id === a.id)) {
      toast('가족이 이 알림에 먼저 답했어요');
      dropIncoming(a.id);
    }
  },

  // 관리사무소가 앱 미가입 세대에 대신 연락했을 때
  relay(r) {
    const i = state.relays.findIndex((x) => x.id === r.id);
    if (i >= 0) state.relays[i] = r;
    else state.relays.unshift(r);
    renderHistory();
    const where = r.around ? '주변 세대' : `${r.toUnit}호`;
    const msg = r.status === 'contacted' ? `🏢 관리사무소가 ${where}에 연락했어요` : '🏢 관리사무소가 민원 처리를 마쳤어요';
    toast(r.note ? `${msg}: ${r.note}` : msg);
    navigator.vibrate?.([80, 40, 80]);
    if (!state.pushOn) systemNotify(msg, { body: r.note || '', tag: `relay-${r.id}` });
  },

  notices(list) {
    const fresh = list.filter((n) => !n.mine && !state.notices.some((o) => o.id === n.id));
    state.notices = list;
    renderNotices();
    if (fresh.length) toast(`${fresh[0].emoji} ${fresh[0].byAdmin ? '관리사무소 공지가 올라왔어요' : `${fresh[0].unit}호가 미리 양해를 구했어요`}`);
  },

  chat(messages) {
    for (const m of messages) if (!state.chat.some((c) => c.id === m.id)) state.chat.push(m);
    renderChat();
    if (messages.some((m) => m.from === 'admin')) {
      navigator.vibrate?.([80, 40, 80]);
      checkAdminReplies();
      if (!state.pushOn) systemNotify('💬 관리사무소 답변이 왔어요', { body: messages.at(-1).text, tag: 'chat' });
    }
  },

  blocked(d) {
    state.blocked = d.blocked;
    renderBlocked();
    toast(d.blocked ? '신고 누적으로 알림 보내기가 제한됐어요' : '알림 보내기 제한이 풀렸어요');
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const run = ++state.pollRun; // 새 연결이 시작되면 이전 루프는 멈춘다
  let after = null; // null = 첫 요청 (hello 받기)
  while (run === state.pollRun && state.token) {
    try {
      const q = after == null ? '' : `&after=${after}`;
      const res = await fetch(`${API}/poll?token=${encodeURIComponent(state.token)}${q}`, { cache: 'no-store' });
      const d = await res.json();
      if (run !== state.pollRun) return;
      if (d.invalid) {
        resetToJoin();
        toast('등록 정보가 만료됐어요. 다시 등록해 주세요.');
        return;
      }
      if (d.resync) {
        after = null;
        continue;
      }
      after = d.seq;
      for (const e of d.events) handlers[e.event]?.(e.data);
    } catch {
      await sleep(2000); // 네트워크가 끊기면 잠시 후 재시도
    }
  }
}

function applyAlertUpdate(a) {
  const i = state.history.findIndex((h) => h.id === a.id);
  if (i >= 0) state.history[i] = { ...state.history[i], ...a, direction: state.history[i].direction };
  renderHistory();
}

function renderAll() {
  renderTargets();
  renderNotices();
  renderMap();
  renderHistory();
  renderBlocked();
}

function renderBlocked() {
  $('blocked-banner').hidden = !state.blocked;
}

// ---------- 어디서 소리가 나나요 (빠른 선택) ----------
function renderTargets() {
  const near = neighbors(state.unit);
  const active = new Set(state.active);
  const wrap = $('quick-targets');
  wrap.innerHTML = '';
  const add = (icon, title, sub, enabled, onClick, cls = '') => {
    const b = document.createElement('button');
    b.className = `target ${cls}`;
    b.disabled = !enabled;
    b.innerHTML = `<span class="t-icon">${icon}</span><span class="t-title">${esc(title)}</span><span class="t-sub">${esc(sub)}</span>`;
    b.addEventListener('click', onClick);
    wrap.appendChild(b);
  };
  // 앱 미가입 세대도 누를 수 있다 (관리사무소가 대신 연락)
  const slot = (dir, icon) => {
    const unit = near[dir];
    const on = unit && active.has(unit);
    add(icon, DIR_LABEL[dir], unit ? (on ? `${unit}호` : `${unit}호 · 앱 미가입`) : '없음', Boolean(unit), () => openCompose(unit), on ? '' : 'relay');
  };
  slot('up', '⬆️');
  slot('down', '⬇️');
  slot('left', '⬅️');
  slot('right', '➡️');
  const around = [...new Set(Object.values(near).filter((u) => u && active.has(u)))];
  const anyNear = Object.values(near).some(Boolean);
  add('🤷', '어디서 나는지 모르겠어요', around.length ? `주변 ${around.length}세대에 확인 요청` : '주변에 앱 쓰는 집이 없어서 관리사무소에 전달돼요', anyNear, () => openCompose('around', around.length), 'wide');
}

// ---------- 우리 동 배치도 ----------
function renderMap() {
  const { rows, cols, cells } = state.config.layout;
  const map = $('building-map');
  map.style.gridTemplateColumns = `2.4em repeat(${cols}, minmax(0, 1fr))`;
  const active = new Set(state.active);
  map.innerHTML = '';
  // 라인 머리글
  map.appendChild(document.createElement('div'));
  for (let c = 0; c < cols; c++) map.appendChild(Object.assign(document.createElement('div'), { className: 'col-label', textContent: colLabel(c) }));
  for (let r = 0; r < rows; r++) {
    const rowCells = cells.slice(r * cols, r * cols + cols);
    const floor = floorOf(rowCells, r, rows);
    map.appendChild(Object.assign(document.createElement('div'), { className: 'floor-label', textContent: floor }));
    for (const label of rowCells) {
      if (!label) {
        map.appendChild(Object.assign(document.createElement('div'), { className: 'unit-gap' }));
        continue;
      }
      const b = document.createElement('button');
      b.className = 'unit';
      b.textContent = label;
      if (label === state.unit) {
        b.classList.add('me');
        b.disabled = true;
        b.setAttribute('aria-label', `${label}호 우리 집`);
      } else if (active.has(label)) {
        b.classList.add('active');
        b.setAttribute('aria-label', `${label}호에 알리기`);
        b.addEventListener('click', () => openCompose(label));
      } else {
        b.addEventListener('click', () => openCompose(label));
        b.setAttribute('aria-label', `${label}호에 알리기 (앱 미가입, 관리사무소 경유)`);
      }
      map.appendChild(b);
    }
  }
}

// 머리글: 줄 안의 숫자 호수에서 가장 많은 층·라인 번호 (관리사무소 화면과 같은 규칙)
function mode(values) {
  const n = {};
  for (const v of values) n[v] = (n[v] || 0) + 1;
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0];
}
const numeric = (cells) => cells.filter((l) => l && /^\d{3,}$/.test(l));
function colLabel(c) {
  const { rows, cols, cells } = state.config.layout;
  const col = [];
  for (let r = 0; r < rows; r++) col.push(cells[r * cols + c]);
  const m = mode(numeric(col).map((l) => Number(l.slice(-2))));
  return m ? `${m}호` : `${c + 1}라인`;
}
function floorOf(rowCells, r, rows) {
  const m = mode(numeric(rowCells).map((l) => l.slice(0, -2)));
  return m ? `${m}F` : `${rows - r}F`;
}

// ---------- 기록 ----------
function incomingTitle(a) {
  return a.around ? '혹시 우리 집 소리일까요?' : '똑똑, 이웃이에요';
}

function alertSentence(a) {
  const where = a.around ? '근처 세대에서' : '이웃 세대에서';
  const night = a.night ? ' 늦은 시간이라 더 크게 울린대요.' : '';
  if (a.type === 'etc') return `${where} 소음 때문에 메시지를 보냈어요.${night}`;
  const ask = a.around ? '혹시 우리 집 소리인지 한 번 확인해 주실 수 있을까요?' : '조금만 신경 써 주실 수 있을까요?';
  return `${where} ${a.phrase} 들린다고 해요.${night} ${ask}`;
}

function relayItem(r) {
  const li = document.createElement('li');
  li.className = 'relay';
  const dir = r.dir ? ` (${DIR_LABEL[r.dir]})` : '';
  const to = r.around ? '주변 세대' : `${esc(r.toUnit)}호${dir}`;
  li.innerHTML = `
    <div class="h-emoji">${r.emoji}</div>
    <div class="h-main">
      <div class="h-title">${to}에 ${esc(r.typeLabel)} 민원 <span class="tag">🏢 관리사무소 경유</span></div>
      <div class="muted small">${timeAgo(r.createdAt)} · 앱 미가입 세대라 관리사무소에 전달했어요</div>
      ${r.message ? `<div class="h-message">${esc(r.message)}</div>` : ''}
      <div class="h-reply ${r.status === 'open' ? 'pending' : ''}">${r.status === 'open' ? '관리사무소 확인 중…' : `🏢 ${esc(r.statusText)}${r.note ? `: ${esc(r.note)}` : ''}`}</div>
    </div>`;
  return li;
}

function renderHistory() {
  const ul = $('history');
  ul.innerHTML = '';
  $('history-empty').hidden = state.history.length + state.relays.length > 0;
  // 알림과 관리사무소 경유 민원을 시간순으로 섞는다
  const items = [...state.history.map((a) => ({ at: a.createdAt, a })), ...state.relays.map((r) => ({ at: r.createdAt, r }))].sort((x, y) => y.at - x.at);
  for (const { a, r } of items) {
    if (r) {
      ul.appendChild(relayItem(r));
      continue;
    }
    const li = document.createElement('li');
    const sent = a.direction === 'sent';
    const dir = a.dir ? ` (${DIR_LABEL[a.dir]})` : '';
    const title = sent ? `${esc(a.toUnit)}호${dir}에 ${esc(a.typeLabel)} 알림` : `${esc(a.typeLabel)} 알림을 받았어요`;
    const tags = `${a.night ? '<span class="tag night">🌙 조용한 시간</span>' : ''}${a.around ? '<span class="tag">주변 확인 요청</span>' : ''}${sent && a.filtered ? '<span class="tag">🛡️ 다듬어 전달</span>' : ''}`;
    const message = a.message ? `<div class="h-message">${esc(a.message)}</div>` : '';
    let foot;
    if (a.reply) foot = `<div class="h-reply ${a.reply === 'notus' ? 'notus' : ''}">${sent ? '💬 답장: ' : '↪ 우리 집 답장: '}${esc(a.replyText)}</div>`;
    else if (sent) foot = `<div class="h-reply pending">답장을 기다리는 중…</div>`;
    else if (a.reported) foot = `<div class="h-reply pending">🚩 신고했어요</div>`;
    else foot = `<button class="btn ghost small" data-open="${a.id}">답장하기</button>`;
    li.innerHTML = `
      <div class="h-emoji">${a.emoji}</div>
      <div class="h-main">
        <div class="h-title">${title}</div>
        <div class="muted small">${timeAgo(a.createdAt)} ${tags}</div>
        ${message}
        ${foot}
      </div>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openIncomingById(b.dataset.open)));
}

// ---------- 2. 소음 알리기 ----------
function openCompose(target, count = 0) {
  if (state.blocked) return toast('신고 누적으로 알림 보내기가 제한됐어요');
  state.compose = { target, type: null, count, preview: null };
  const near = neighbors(state.unit);
  const dir = Object.keys(near).find((k) => near[k] === target);
  const registered = target === 'around' ? count > 0 : state.active.includes(target);
  state.compose.relay = !registered;
  if (target === 'around' && !registered) {
    $('compose-title').textContent = '🤷 주변 세대 확인 요청';
    $('compose-sub').textContent = '주변 세대 중 앱에 가입한 집이 없어요. 관리사무소에 전달하고, 관리사무소가 연락하면 알려 드려요.';
  } else if (target === 'around') {
    $('compose-title').textContent = `🤷 주변 ${count}세대에 확인 요청`;
    $('compose-sub').textContent = '위·아래·옆집 중 앱을 쓰는 세대에 "혹시 우리 집 소리인지" 물어봐요. 보낸 집은 공개되지 않아요.';
  } else if (!registered) {
    $('compose-title').textContent = `${target}호${dir ? ` (${DIR_LABEL[dir]})` : ''}에 알리기`;
    $('compose-sub').textContent = `${target}호는 아직 앱에 가입하지 않았어요. 관리사무소에 전달하고, 관리사무소가 연락하면 알려 드려요.`;
  } else {
    $('compose-title').textContent = `${target}호${dir ? ` (${DIR_LABEL[dir]})` : ''}에 알리기`;
    $('compose-sub').textContent = '보내는 우리 집 호수는 공개되지 않아요. 가족 모두에게 전달돼요.';
  }
  $('compose-error').textContent = '';
  const gap = state.config.sendGapSec >= 60 ? `${Math.round(state.config.sendGapSec / 60)}분` : `${state.config.sendGapSec}초`;
  $('compose-limit').textContent = `소리 민원은 ${gap}에 1번, 1시간에 ${state.config.sendPerHour}번까지 보낼 수 있어요.`;
  $('etc-text').value = '';
  $('etc-text').maxLength = state.config.etcTextMax;
  $('etc-wrap').hidden = true;
  $('etc-result').hidden = true;
  const wrap = $('noise-types');
  wrap.innerHTML = '';
  for (const [key, t] of Object.entries(state.config.noiseTypes)) {
    const c = document.createElement('button');
    c.className = 'chip';
    c.type = 'button';
    c.textContent = `${t.emoji} ${t.label}`;
    c.setAttribute('aria-pressed', 'false');
    c.addEventListener('click', () => {
      state.compose.type = key;
      wrap.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
      $('etc-wrap').hidden = key !== 'etc';
      if (key === 'etc') $('etc-text').focus();
      renderPreview();
    });
    wrap.appendChild(c);
  }
  renderPreview();
  openSheet('compose');
}

const customText = () => $('etc-text').value.trim();

// 기타 메시지는 "다듬어 보기"로 실제 전달될 문장을 확인한 뒤 보낸다
function previewReady() {
  const pv = state.compose.preview;
  return pv && pv.forText === customText() && !pv.blocked;
}

function renderPreview() {
  const { type, target, preview } = state.compose;
  const text = customText();
  const etc = type === 'etc';
  $('etc-count').textContent = `${$('etc-text').value.length}/${state.config.etcTextMax}`;
  const ready = type && (!etc || text);
  $('compose-send').disabled = !ready;
  $('compose-send').textContent = etc && !previewReady() ? '🛡️ 다듬어 보기' : '정중하게 보내기';
  // 다듬은 결과 (글을 고치면 다시 다듬어야 한다)
  const stale = !preview || preview.forText !== text;
  $('etc-result').hidden = !etc || stale;
  if (etc && !stale) {
    $('etc-result').classList.toggle('blocked', preview.blocked);
    $('etc-result').innerHTML = preview.blocked
      ? esc(preview.blockedMessage)
      : `<b>${preview.changed ? '🛡️ 이렇게 다듬어서 전달해요' : '✅ 그대로 전달해도 괜찮아요'}</b>${esc(preview.text)}`;
  }
  if (!ready) return ($('compose-preview').textContent = '');
  const t = state.config.noiseTypes[type];
  const around = target === 'around';
  const who = state.compose.relay ? '관리사무소를 거쳐' : around ? '주변 세대에' : `${esc(target)}호에`;
  $('compose-preview').innerHTML = `<strong>${who} 이렇게 전달돼요</strong><br>${t.emoji} ${esc(alertSentence({ type, phrase: t.phrase, around, night: isQuietNow() }))}${etc ? ' + 위 메시지' : ''}`;
}

$('etc-text').addEventListener('input', renderPreview);
$('compose-cancel').addEventListener('click', () => closeSheet('compose'));

$('compose-send').addEventListener('click', async () => {
  const { target, type } = state.compose;
  const btn = $('compose-send');
  btn.disabled = true;
  $('compose-error').textContent = '';
  if (type === 'etc' && !previewReady()) {
    const forText = customText();
    btn.textContent = '다듬는 중…';
    try {
      const pv = await api('filter/preview', { token: state.token, text: forText });
      state.compose.preview = { ...pv, forText };
    } catch (err) {
      $('compose-error').textContent = err.message;
    }
    return renderPreview();
  }
  try {
    const { alerts, relay, message } = await api('alerts', {
      token: state.token,
      target,
      type,
      text: type === 'etc' ? customText() : undefined,
      previewId: type === 'etc' ? state.compose.preview.previewId : undefined,
    });
    state.history.unshift(...alerts);
    if (relay) state.relays.unshift(relay);
    renderHistory();
    closeSheet('compose');
    if (relay) toast(message);
    else toast(target === 'around' ? `주변 ${alerts.length}세대에 조심스럽게 물어봤어요` : `${target}호에 정중하게 전달했어요`);
  } catch (err) {
    $('compose-error').textContent = err.message;
    $('compose-send').disabled = false;
  }
});

// ---------- 3. 받은 알림 + 답장 ----------
function queueIncoming(list) {
  for (const a of list) if (!state.incomingQueue.some((q) => q.id === a.id)) state.incomingQueue.push(a);
  if ($('incoming').hidden && $('report').hidden) showNextIncoming();
}

function openIncomingById(id) {
  const a = state.history.find((h) => h.id === id);
  if (!a || a.reply || a.reported || a.direction !== 'received') return;
  state.incomingQueue = [a, ...state.incomingQueue.filter((q) => q.id !== id)];
  showNextIncoming();
}

function showNextIncoming() {
  const a = state.incomingQueue[0];
  if (!a) {
    closeSheet('incoming');
    return checkAdminReplies(); // 소음 알림을 다 처리하면 미뤄둔 관리사무소 답변 팝업을 띄운다
  }
  $('incoming-emoji').textContent = a.emoji;
  $('incoming-title').textContent = incomingTitle(a);
  $('incoming-body').textContent = alertSentence(a);
  $('incoming-message').hidden = !a.message;
  $('incoming-message').textContent = a.message || '';
  $('incoming-night').hidden = !a.night;
  $('custom-reply').hidden = true;
  $('custom-reply-open').hidden = false;
  $('custom-reply-text').value = '';
  $('custom-reply-error').textContent = '';
  $('custom-reply-count').textContent = `0/${state.config.replyTextMax}`;
  const wrap = $('reply-options');
  wrap.innerHTML = '';
  for (const [key, text] of Object.entries(state.config.replies)) {
    const b = document.createElement('button');
    b.className = `btn ${key === 'notus' ? 'notus' : ''}`;
    b.textContent = text;
    b.addEventListener('click', () => sendReply(a.id, key));
    wrap.appendChild(b);
  }
  openSheet('incoming');
}

function dropIncoming(id) {
  state.incomingQueue = state.incomingQueue.filter((q) => q.id !== id);
  if ($('report').hidden) showNextIncoming();
}

async function sendReply(id, reply) {
  try {
    const a = await api(`alerts/${id}/reply`, { token: state.token, reply });
    applyAlertUpdate(a);
    toast(reply === 'notus' ? '이웃에게 우리 집 소리가 아니라고 알렸어요' : '답장을 보냈어요. 배려해 주셔서 고마워요!');
  } catch (err) {
    toast(err.message);
  }
  dropIncoming(id);
}

// 직접 쓴 답장: AI가 다듬어 전달 (원문은 관리사무소만)
$('custom-reply-open').addEventListener('click', () => {
  $('custom-reply-open').hidden = true;
  $('custom-reply').hidden = false;
  $('custom-reply-text').focus();
});
$('custom-reply-text').addEventListener('input', () => {
  $('custom-reply-count').textContent = `${$('custom-reply-text').value.length}/${state.config.replyTextMax}`;
});
$('custom-reply-send').addEventListener('click', async () => {
  const a = state.incomingQueue[0];
  const text = $('custom-reply-text').value.trim();
  if (!a || !text) return ($('custom-reply-error').textContent = '답장 내용을 적어 주세요.');
  const btn = $('custom-reply-send');
  btn.disabled = true;
  btn.textContent = '다듬는 중…';
  try {
    const r = await api(`alerts/${a.id}/reply`, { token: state.token, reply: 'custom', text });
    applyAlertUpdate(r);
    toast(r.replyText === text ? '답장을 보냈어요' : `다듬어서 보냈어요: "${r.replyText}"`);
    dropIncoming(a.id);
  } catch (err) {
    $('custom-reply-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '다듬어서 답장 보내기';
  }
});

$('incoming-later').addEventListener('click', () => {
  state.incomingQueue.shift();
  showNextIncoming();
});

// ---------- 4. 신고 ----------
$('incoming-report').addEventListener('click', () => {
  const a = state.incomingQueue[0];
  if (!a) return;
  state.reportingId = a.id;
  $('report-error').textContent = '';
  const wrap = $('report-reasons');
  wrap.innerHTML = '';
  for (const [key, text] of Object.entries(state.config.reportReasons)) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = text;
    b.addEventListener('click', () => sendReport(key));
    wrap.appendChild(b);
  }
  closeSheet('incoming');
  openSheet('report');
});

$('report-cancel').addEventListener('click', () => {
  closeSheet('report');
  showNextIncoming();
});

async function sendReport(reason) {
  try {
    const a = await api(`alerts/${state.reportingId}/report`, { token: state.token, reason });
    applyAlertUpdate(a);
    closeSheet('report');
    toast('신고했어요. 관리사무소가 확인할게요.');
    dropIncoming(state.reportingId);
  } catch (err) {
    $('report-error').textContent = err.message;
  }
}

// ---------- 5. 미리 양해 구하기 ----------
const HOME_NOTICE_MAX = 3; // 홈에는 가까운 공지 3개만, 나머지는 캘린더에서

function noticeHtml(n) {
  const now = Date.now();
  const live = n.startAt <= now;
  const who = n.byAdmin ? '🏢 관리사무소' : `${esc(n.unit)}호${n.mine ? ' (우리 집)' : ''}`;
  const sameDay = new Date(n.startAt).toDateString() === new Date(n.endAt).toDateString();
  const action = n.mine
    ? `<button class="btn ghost small" data-del="${n.id}">내리기</button>`
    : n.byAdmin
      ? ''
      : `<button class="btn ghost small thanks" data-thanks="${n.id}" aria-pressed="${n.thanked}">👍 괜찮아요${n.thanks ? ` ${n.thanks}` : ''}</button>`;
  return `<li class="${n.byAdmin ? 'admin' : ''}">
    <div class="n-emoji">${n.emoji}</div>
    <div class="n-main">
      <div class="n-title">${esc(n.label)} <span class="muted small">· ${who}</span></div>
      <div class="small ${live ? 'live' : 'muted'}">${live ? '● 진행 중 · ' : ''}${dayLabel(n.startAt)} ${hhmm(n.startAt)} ~ ${sameDay ? '' : `${dayLabel(n.endAt)} `}${hhmm(n.endAt)}</div>
      ${n.text ? `<div class="n-text">${esc(n.text)}</div>` : ''}
      ${n.mine && n.thanks ? `<div class="muted small">이웃 ${n.thanks}세대가 괜찮다고 했어요 💛</div>` : ''}
    </div>
    ${action}
  </li>`;
}

function bindNoticeActions(ul) {
  ul.querySelectorAll('[data-thanks]').forEach((b) => b.addEventListener('click', () => noticeAction(b.dataset.thanks, 'thanks')));
  ul.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => noticeAction(b.dataset.del, 'delete')));
}

function renderNotices() {
  const ul = $('notices');
  const list = state.notices;
  $('notices-empty').hidden = list.length > 0;
  ul.innerHTML = list.slice(0, HOME_NOTICE_MAX).map(noticeHtml).join('');
  bindNoticeActions(ul);
  const more = list.length - HOME_NOTICE_MAX;
  $('calendar-open').textContent = more > 0 ? `📅 캘린더로 더 보기 (+${more})` : '📅 캘린더로 자세히 보기';
  if (!$('calendar').hidden) renderCalendar();
}
setInterval(() => state.token && state.notices.length && renderNotices(), 60_000);

async function noticeAction(id, action) {
  try {
    const { notices } = await api(`notices/${id}/${action}`, { token: state.token });
    state.notices = notices;
    renderNotices();
    if (action === 'delete') toast('공지를 내렸어요');
  } catch (err) {
    toast(err.message);
  }
}

// ---- 캘린더 ----
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// 그 날짜에 걸쳐 있는 공지들
function noticesOn(day) {
  const s = dayStart(day);
  const e = s + 86_400_000;
  return state.notices.filter((n) => n.startAt < e && n.endAt > s);
}

function renderCalendar() {
  const { month, day } = state.cal;
  $('cal-month').textContent = `${month.getFullYear()}년 ${month.getMonth() + 1}월`;
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // 일요일부터
  const today = ymd(new Date());
  let html = ['일', '월', '화', '수', '목', '금', '토'].map((d, i) => `<div class="cal-dow ${i === 0 ? 'sun' : ''}">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (i >= 35 && d.getMonth() !== month.getMonth()) break; // 마지막 줄이 다음 달뿐이면 생략
    const list = noticesOn(d);
    const cls = ['cal-day', d.getMonth() !== month.getMonth() && 'out', ymd(d) === today && 'today', ymd(d) === ymd(day) && 'sel', d.getDay() === 0 && 'sun'].filter(Boolean).join(' ');
    const ev = list.slice(0, 3).map((n) => n.emoji).join('');
    html += `<button type="button" class="${cls}" data-day="${ymd(d)}" aria-label="${d.getMonth() + 1}월 ${d.getDate()}일 공지 ${list.length}개">
      <span class="d">${d.getDate()}</span>${ev ? `<span class="ev">${ev}</span>` : ''}${list.length > 3 ? `<span class="more">+${list.length - 3}</span>` : ''}
    </button>`;
  }
  $('cal-grid').innerHTML = html;
  $('cal-grid').querySelectorAll('[data-day]').forEach((b) =>
    b.addEventListener('click', () => {
      const [y, m, dd] = b.dataset.day.split('-').map(Number);
      state.cal.day = new Date(y, m - 1, dd);
      if (state.cal.day.getMonth() !== state.cal.month.getMonth()) state.cal.month = new Date(y, m - 1, 1);
      renderCalendar();
    }),
  );
  const list = noticesOn(day);
  const rel = dayLabel(day.getTime());
  const dow = '일월화수목금토'[day.getDay()];
  $('cal-day-title').textContent = `${day.getMonth() + 1}월 ${day.getDate()}일 (${['오늘', '내일', '모레'].includes(rel) ? `${rel} · ` : ''}${dow})`;
  $('cal-day-list').innerHTML = list.map(noticeHtml).join('');
  bindNoticeActions($('cal-day-list'));
  $('cal-day-empty').hidden = list.length > 0;
}

$('calendar-open').addEventListener('click', () => {
  const now = new Date();
  state.cal = { month: new Date(now.getFullYear(), now.getMonth(), 1), day: now };
  renderCalendar();
  openSheet('calendar');
});
$('calendar-close').addEventListener('click', () => closeSheet('calendar'));
$('cal-prev').addEventListener('click', () => {
  state.cal.month = new Date(state.cal.month.getFullYear(), state.cal.month.getMonth() - 1, 1);
  renderCalendar();
});
$('cal-next').addEventListener('click', () => {
  state.cal.month = new Date(state.cal.month.getFullYear(), state.cal.month.getMonth() + 1, 1);
  renderCalendar();
});

// ---- 공지 올리기 ----
$('notice-new').addEventListener('click', () => {
  if (!state.token) return;
  state.notice = { type: null };
  $('notice-error').textContent = '';
  $('notice-text').value = '';
  $('notice-text').maxLength = state.config.noticeTextMax;
  const types = $('notice-types');
  types.innerHTML = '';
  for (const [key, t] of Object.entries(state.config.noticeTypes)) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'chip';
    c.textContent = `${t.emoji} ${t.label}`;
    c.setAttribute('aria-pressed', 'false');
    c.addEventListener('click', () => {
      state.notice.type = key;
      types.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
      $('notice-send').disabled = false;
    });
    types.appendChild(c);
  }
  // 날짜: 오늘·내일·모레 바로가기 + 달력에서 고르기 (최대 30일 뒤)
  const dateInput = $('notice-date');
  const today = new Date();
  const max = new Date();
  max.setDate(max.getDate() + state.config.noticeMaxDays);
  dateInput.min = ymd(today);
  dateInput.max = ymd(max);
  dateInput.value = ymd(today);
  const days = $('notice-days');
  days.innerHTML = '';
  const syncChips = () => days.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.date === dateInput.value)));
  ['오늘', '내일', '모레'].forEach((label, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'chip';
    c.textContent = label;
    c.dataset.date = ymd(d);
    c.addEventListener('click', () => {
      dateInput.value = c.dataset.date;
      syncChips();
    });
    days.appendChild(c);
  });
  dateInput.oninput = syncChips;
  syncChips();
  // 기본 시간: 다음 정시부터 2시간
  const next = new Date();
  next.setHours(next.getHours() + 1, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  $('notice-start').value = `${pad(next.getHours())}:00`;
  $('notice-end').value = `${pad((next.getHours() + 2) % 24)}:00`;
  $('notice-send').disabled = true;
  openSheet('notice-sheet');
});
$('notice-cancel').addEventListener('click', () => closeSheet('notice-sheet'));

// 선택한 날짜 + 시각 → 타임스탬프 (끝이 시작보다 이르면 다음 날 새벽으로 본다)
function noticeRange() {
  const [y, mo, d] = $('notice-date').value.split('-').map(Number);
  const at = (v) => {
    const [h, m] = v.split(':').map(Number);
    return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
  };
  const startAt = at($('notice-start').value);
  let endAt = at($('notice-end').value);
  if (endAt <= startAt) endAt += 86_400_000;
  return { startAt, endAt };
}

$('notice-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const n = await api('notices', { token: state.token, type: state.notice.type, text: $('notice-text').value, ...noticeRange() });
    if (!state.notices.some((x) => x.id === n.id)) state.notices.push(n);
    state.notices.sort((x, y) => x.startAt - y.startAt);
    renderNotices();
    closeSheet('notice-sheet');
    toast('이웃에게 미리 양해를 구했어요');
  } catch (err) {
    $('notice-error').textContent = err.message;
  }
});

// ---------- 6. 관리사무소 문의 ----------
function openChat() {
  markAdminSeen();
  renderChat();
  openSheet('chat');
}

// ---------- 관리사무소 답변 팝업 ----------
function unseenAdminReplies() {
  const admin = state.chat.filter((m) => m.from === 'admin');
  const seen = localStorage.getItem(SEEN_ADMIN_KEY());
  const i = admin.findIndex((m) => m.id === seen);
  return admin.slice(i + 1);
}

function markAdminSeen() {
  const last = state.chat.filter((m) => m.from === 'admin').at(-1);
  if (last) localStorage.setItem(SEEN_ADMIN_KEY(), last.id);
  $('chat-dot').hidden = true;
}

function checkAdminReplies() {
  if (!$('chat').hidden) return markAdminSeen(); // 문의창을 보고 있으면 바로 읽음 처리
  const unseen = unseenAdminReplies();
  if (!unseen.length) return;
  $('chat-dot').hidden = false;
  // 소음 알림·신고 창이 떠 있으면 그 처리가 끝난 뒤에 보여준다
  if (!$('incoming').hidden || !$('report').hidden) return;
  $('admin-reply-text').textContent = unseen.at(-1).text;
  $('admin-reply-more').hidden = unseen.length < 2;
  $('admin-reply-more').textContent = `읽지 않은 답변 ${unseen.length}개 중 가장 최근 답변이에요.`;
  openSheet('admin-reply'); // 작성 중인 창은 닫지 않고 그 위에 겹쳐 띄운다
}

function closeAdminReply() {
  markAdminSeen();
  closeSheet('admin-reply');
}

$('admin-reply-close').addEventListener('click', closeAdminReply);
$('admin-reply-open').addEventListener('click', () => {
  closeSheet('admin-reply');
  openChat();
});
$('chat-fab').addEventListener('click', openChat);

// ---------- 화풀기 (화풀이 게임, 실제로는 아무에게도 보내지 않음) ----------
$('vent-fab').addEventListener('click', () => {
  const up = neighbors(state.unit).up;
  const q = new URLSearchParams({ from: state.unit || '', ...(up ? { to: up } : {}) });
  $('vent-frame').src = `vent.html?${q}`;
  openSheet('vent');
});
function closeVent() {
  closeSheet('vent');
  $('vent-frame').src = 'about:blank'; // 3D 화면·소리를 멈춘다
}
// 화풀기 기록: 게임에서 맞힌 토마토·계란, 토계볶 완성을 모아서 1.5초마다 서버에 보낸다 (현황판 집계용)
const ventBatch = { tomato: 0, egg: 0, wok: 0 };
let ventTimer = null;
function flushVent() {
  ventTimer = null;
  if (!state.token || !(ventBatch.tomato || ventBatch.egg || ventBatch.wok)) return;
  const body = { token: state.token, ...ventBatch };
  ventBatch.tomato = ventBatch.egg = ventBatch.wok = 0;
  api('vent', body).catch(() => {
    // 실패하면 다음에 같이 보낸다
    ventBatch.tomato += body.tomato; ventBatch.egg += body.egg; ventBatch.wok += body.wok;
    ventTimer ||= setTimeout(flushVent, 3000);
  });
}
addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.type === 'vent-close') return closeVent();
  if (e.data?.type === 'vent-hit' && (e.data.kind === 'tomato' || e.data.kind === 'egg')) ventBatch[e.data.kind]++;
  else if (e.data?.type === 'vent-wok') ventBatch.wok++;
  else return;
  ventTimer ||= setTimeout(flushVent, 1500);
});
addEventListener('keydown', (e) => e.key === 'Escape' && !$('vent').hidden && closeVent());
$('chat-close').addEventListener('click', () => closeSheet('chat'));

function renderFaqCards() {
  const wrap = $('faq-cards');
  wrap.innerHTML = '';
  for (const f of state.config.faqs) {
    const b = document.createElement('button');
    b.className = 'faq-card';
    b.textContent = f.q;
    b.addEventListener('click', () => sendChat({ faqId: f.id }));
    wrap.appendChild(b);
  }
}

function renderChat() {
  const log = $('chat-log');
  const intro = `<div class="msg bot"><span class="who">🤖 쉿!그널 봇</span>안녕하세요! 자주 묻는 질문은 아래 카드를 눌러 바로 확인하고, 그 밖의 문의는 메시지를 남겨 주세요. 관리사무소에서 답해 드려요.</div>`;
  const who = { user: '', bot: '<span class="who">🤖 쉿!그널 봇</span>', admin: '<span class="who">🏢 관리사무소</span>' };
  log.innerHTML =
    intro +
    state.chat
      .map((m) => {
        const note = m.from === 'user' && m.filtered ? `<span class="delivered">🛡️ 관리사무소에는 이렇게 전달됐어요: ${esc(m.delivered)}</span>` : '';
        return `<div class="msg ${m.from}">${who[m.from] || ''}${esc(m.text).replace(/\n/g, '<br>')}${note}</div>`;
      })
      .join('');
  log.scrollTop = log.scrollHeight;
}

async function sendChat(body) {
  try {
    const { messages } = await api('chat', { token: state.token, ...body });
    handlers.chat(messages);
  } catch (err) {
    toast(err.message);
  }
}

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  $('chat-input').value = '';
  // AI가 다듬는 데 몇 초 걸리므로 그동안 버튼으로 알려준다
  const btn = $('chat-form').querySelector('button');
  btn.disabled = true;
  btn.textContent = '다듬는 중…';
  sendChat({ text }).finally(() => {
    btn.disabled = false;
    btn.textContent = '보내기';
  });
});

// ---------- 앱 설치 안내 ----------
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  $('install-btn').hidden = false;
  $('install-tip').hidden = false;
});
$('install-btn').addEventListener('click', async () => {
  state.installPrompt?.prompt();
  await state.installPrompt?.userChoice;
  state.installPrompt = null;
  $('install-tip').hidden = true;
});

// ---------- 시작 ----------
async function init() {
  if (!SLUG) return show('missing');
  try {
    state.config = await api('config');
  } catch {
    return show('missing');
  }
  applyBuildingName();
  applyUnitInputMode();
  renderFaqCards();
  await registerSW();
  if (isIOS && !isStandalone) $('install-tip').hidden = false;
  applyJoinMode();
  const preset = new URLSearchParams(location.search).get('unit');
  if (preset) $('unit-input').value = preset;
  if (state.token && !state.code) enterHome(); // 서버가 모르는 토큰이면 invalid 응답으로 등록 화면 복귀
  else if (preset && !state.code && state.config.allowManualJoin) autoJoin(preset);
  else {
    show('join');
    renderJoin();
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.token) renderNotifStatus();
  });
}

// 데모 링크(?unit=호수)로 처음 들어오면 그 호수로 바로 등록한다
async function autoJoin(unit) {
  try {
    const res = await api('join', { unit, deviceId: deviceId() });
    state.token = res.token;
    state.unit = res.unit;
    bindUnit(res.unit, res.token);
    enterHome();
  } catch (err) {
    show('join');
    renderJoin();
    $('join-error').textContent = err.message;
  }
}

init();
