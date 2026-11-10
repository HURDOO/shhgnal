// 쉿!그널 정적 데모용 "브라우저 안 서버"
// - 원래 Node 서버(main 브랜치 server.js)의 API를 브라우저 안에서 그대로 흉내 낸다.
//   화면 코드가 부르는 fetch('api/b/<slug>/...')를 가로채서 여기서 처리한다.
// - 상태는 localStorage 한 곳에 저장한다. 같은 브라우저의 다른 탭(다른 호수, 관리사무소)과는
//   BroadcastChannel로 바로 동기화하고, Web Locks로 동시에 고치지 않게 막는다.
// - 원래 서버와 다른 점: LLM 대신 규칙 필터, 웹 푸시 없음, 관리자 키는 데모용 고정값, 다른 기기와는 공유 안 됨.

const STORE_KEY = 'shhgnal-demo-v1';
export const DEMO_SLUG = 'demo';
export const DEMO_ADMIN_KEY = 'demo';
const OPTS = globalThis.SHH_DEMO_OPTIONS || {}; // 테스트에서 보내기 제한을 풀 때 쓴다
const TZ = 'Asia/Seoul';

const POLL_TIMEOUT_MS = OPTS.pollTimeoutMs ?? 25_000;
const AUTO_BLOCK_REPORTS = 3; // 서로 다른 세대에게 이만큼 신고되면 알림 보내기 자동 제한
const REPEAT_DAYS = 7; // 반복 소음 세대 집계 기간
const REPEAT_SENDERS = 3; // 기간 안에 서로 다른 세대 이만큼에게 알림 받으면 관리사무소에 표시
const ETC_TEXT_MAX = 100; // 이웃끼리 주고받는 글 (기타 메시지, 직접 답장, 양해 공지)
const REPLY_TEXT_MAX = 100;
const NOTICE_MAX_DAYS = 30;
const FILTER_LOG_MAX = 300;
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_PER_MIN = 10;
const NOTICE_TEXT_MAX = 100;
const NOTICE_MAX_HOURS = 12;
const CHAT_MAX = 300; // 관리사무소 답변
const OFFICE_MSG_MAX = 3000; // 주민 문의 (긴 민원도 받는다)

// 소리 민원 보내기 제한: 기기마다 5분에 1번, 1시간에 최대 3번
export const SEND_GAP_SEC = OPTS.sendGapSec ?? 300;
export const SEND_PER_HOUR = OPTS.sendPerHour ?? 3;
export function checkSendLimit(times, now = Date.now(), gapSec = SEND_GAP_SEC, perHour = SEND_PER_HOUR) {
  const recent = times.filter((t) => now - t < 3_600_000);
  const last = recent.at(-1);
  if (last != null && now - last < gapSec * 1000) {
    const sec = Math.ceil((gapSec * 1000 - (now - last)) / 1000);
    return { error: `소리 민원은 ${Math.ceil(gapSec / 60)}분에 한 번 보낼 수 있어요. ${sec >= 60 ? `${Math.ceil(sec / 60)}분` : `${sec}초`} 뒤에 다시 보내 주세요.`, retryAfterSec: sec };
  }
  if (recent.length >= perHour) {
    const sec = Math.ceil((3_600_000 - (now - recent[0])) / 1000);
    return { error: `소리 민원은 1시간에 ${perHour}번까지 보낼 수 있어요. ${Math.ceil(sec / 60)}분 뒤에 다시 보내 주세요.`, retryAfterSec: sec };
  }
  return null;
}

// ---- 작은 유틸 (http 주소에서도 되도록 randomUUID 대신 getRandomValues) ----
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
function uuid() {
  const h = hex(randomBytes(16));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const safeEqual = (a, b) => String(a) === String(b);

// ---- 메시지 필터 (LLM 대신 규칙) ----
// 데모에서도 "다듬어 전달"이 보이도록 흔한 거친 표현 몇 개는 순한 표현으로 바꾸고, 욕설은 가리고, 위협은 막는다.
const SOFTEN = [
  [/미친\s?듯이/g, '많이'],
  [/시끄러워\s?죽겠/g, '너무 시끄러워서 힘들'],
  [/제발\s?좀/g, '부디'],
  [/!{2,}/g, '!'],
];
const SWEARS = ['씨발', '시발', '씨바', '시바', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '개새', '새끼', '좆', 'ㅈㄹ', '지랄', '미친놈', '미친년', '미친', '꺼져', '닥쳐', '또라이', '븅신', '염병', '썅'];
const THREATS = ['죽여', '죽인다', '죽을래', '죽고싶', '찾아간다', '찾아갈', '가만 안', '가만안', '불 질러', '불질러', '칼로', '패버', '때려'];
const llmStatus = () => ({ enabled: false, model: null, demo: true });

async function filterMessage(kind, text) {
  let out = text;
  let soft = 0;
  for (const [re, to] of SOFTEN) out = out.replace(re, () => (soft++, to));
  let hits = 0;
  for (const w of SWEARS) out = out.replace(new RegExp(w, 'g'), () => (hits++, '○'.repeat(w.length)));
  const threat = THREATS.some((w) => text.replace(/\s+/g, '').includes(w.replace(/\s+/g, '')));
  return {
    text: out,
    severity: threat || hits >= 3 ? 'severe' : hits || soft ? 'mild' : 'none',
    blocked: kind !== 'office' && threat,
    reason: [soft ? `거친 표현 ${soft}곳을 순하게 바꿨어요` : '', hits ? `욕설 ${hits}곳을 가렸어요` : '', threat ? '위협으로 보이는 표현이 있어요' : ''].filter(Boolean).join(' · '),
    source: 'rule',
  };
}

const NOISE_TYPES = {
  // phrase: 알림 문장에 들어갈 표현 (조사 포함). etc는 직접 입력.
  footstep: { label: '쿵쿵 발소리', emoji: '🦶', phrase: '쿵쿵 울리는 발소리가' },
  running: { label: '뛰는 소리', emoji: '🏃', phrase: '뛰어다니는 소리가' },
  furniture: { label: '가구 끄는 소리', emoji: '🪑', phrase: '가구 끄는 소리가' },
  hammer: { label: '망치 · 공사', emoji: '🔨', phrase: '망치질이나 공사 소리가' },
  music: { label: '음악 · TV', emoji: '📺', phrase: '음악이나 TV 소리가' },
  instrument: { label: '악기 연주', emoji: '🎹', phrase: '악기 소리가' },
  pet: { label: '반려동물', emoji: '🐶', phrase: '반려동물 소리가' },
  appliance: { label: '세탁기 · 청소기', emoji: '🌀', phrase: '세탁기나 청소기 소리가' },
  voice: { label: '큰 대화 · 고성', emoji: '🗣️', phrase: '큰 목소리가' },
  etc: { label: '기타 (직접 쓰기)', emoji: '✉️', phrase: '소리가' },
};

const REPLIES = {
  sorry: '죄송해요, 바로 조심할게요 🙏',
  soon: '곧 끝나요, 조금만 양해 부탁드려요',
  unintended: '본의 아니게 그랬어요, 더 주의할게요',
  notus: '저희 집 소리가 아니에요',
};

const REPORT_REASONS = {
  unfair: '소음을 내지 않았는데 받았어요',
  repeat: '같은 알림을 반복해서 보내요',
  abusive: '불쾌한 표현이 있어요',
};

const NOTICE_TYPES = {
  move: { label: '이사', emoji: '📦' },
  construction: { label: '인테리어 · 공사', emoji: '🛠️' },
  assembly: { label: '가구 조립', emoji: '🪛' },
  guests: { label: '손님 방문', emoji: '🎉' },
  kids: { label: '아이 친구들 방문', emoji: '🧒' },
  etc: { label: '기타', emoji: '📢' },
};

// ---- 상태 (localStorage에 통째로 저장) ----
const buildings = new Map(); // slug -> { config, ...runtime }
let seqCounter = 0;

function defaultLayout(floors = 10, lines = 4) {
  const cells = [];
  for (let r = 0; r < floors; r++) for (let c = 0; c < lines; c++) cells.push(`${floors - r}${String(c + 1).padStart(2, '0')}`);
  return { rows: floors, cols: lines, cells };
}

function defaultFaqs() {
  return [
    { q: '층간소음 기준이 있나요?', a: '주간(06~22시) 1분 평균 39dB, 야간(22~06시) 34dB을 넘는 직접 충격 소음이 기준이에요. (공동주택 층간소음 기준 규칙)' },
    { q: '이야기해도 해결이 안 돼요', a: '관리사무소 1:1 문의로 알려 주시면 중재를 도와드려요. 그래도 어렵다면 층간소음 이웃사이센터(1661-2642)에 상담을 신청할 수 있어요.' },
    { q: '공사·이사 신고는 어떻게 하나요?', a: '공사는 시작 일주일 전까지 관리사무소에 신고해 주세요. 앱의 "미리 양해 구하기"로 이웃에게도 알려 주시면 좋아요.' },
    { q: '조용한 시간은 언제인가요?', a: '우리 동은 밤 10시부터 아침 6시까지 조용한 시간이에요. 세탁기·청소기·운동은 피해 주세요.' },
    { q: '알림을 보낸 사람을 알 수 있나요?', a: '아니요. 받은 세대에는 보낸 세대가 공개되지 않아요. 부당한 알림은 신고해 주세요.' },
  ].map((f) => ({ id: uuid(), ...f }));
}

function runtime() {
  return {
    users: new Map(), // token -> { token, id, deviceId, unit, joinedAt } (한 세대에 여러 명 가능)
    alerts: new Map(),
    sendLog: new Map(), // deviceId -> 소리 민원 보낸 시각들
    relays: new Map(), // 앱 미가입 세대로 보낸 민원 → 관리사무소가 대신 연락
    queues: new Map(), // token -> { events }
    notices: new Map(),
    reports: new Map(),
    blocked: new Map(), // deviceId -> { unit, at, reason }
    chats: new Map(), // user id -> { userId, unit, messages, unread }
    filterLog: [],
    previews: new Map(),
    previewHits: new Map(),
    feed: [],
    vent: { tomato: 0, egg: 0, wok: 0, byTarget: {}, byThrower: {}, lastAt: {} },
    adminVersion: 1,
  };
}

function createBuilding(name, slug, floors, lines) {
  const config = {
    slug,
    name,
    adminKey: DEMO_ADMIN_KEY,
    layout: defaultLayout(floors, lines),
    faqs: defaultFaqs(),
    quietStart: 22,
    quietEnd: 6,
    allowManualJoin: true, // 데모는 호수를 골라서 바로 들어간다
    unitCodes: {},
    createdAt: Date.now(),
  };
  const b = { config, ...runtime() };
  ensureUnitCodes(b);
  buildings.set(slug, b);
  return b;
}

const storage = () => globalThis.localStorage;
const replacer = (k, v) => (v instanceof Map ? { __map: [...v] } : v instanceof Set ? { __set: [...v] } : v);
const reviver = (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v.__map ? new Map(v.__map) : v.__set ? new Set(v.__set) : v) : v);
let lastSaved = null;

function load() {
  buildings.clear();
  seqCounter = 0;
  let raw = null;
  try {
    raw = storage().getItem(STORE_KEY);
    const data = raw && JSON.parse(raw, reviver);
    seqCounter = data?.seq || 0;
    for (const b of data?.buildings || []) {
      const full = { ...runtime(), ...b };
      ensureUnitCodes(full);
      buildings.set(b.config.slug, full);
    }
  } catch (e) {
    console.warn('데모 데이터를 읽지 못해 새로 시작해요', e);
  }
  if (!buildings.has(DEMO_SLUG)) createBuilding('행복마을 101동', DEMO_SLUG, 10, 4);
  lastSaved = raw;
}

// 바뀐 게 있을 때만 저장하고 다른 탭에 알린다
function save() {
  const raw = JSON.stringify({ seq: seqCounter, buildings: [...buildings.values()] }, replacer);
  if (raw === lastSaved) return;
  storage().setItem(STORE_KEY, raw);
  lastSaved = raw;
  notifyChange();
}

// ---- 탭 사이 동기화 ----
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('shhgnal-demo') : null;
channel?.unref?.(); // Node 테스트에서 프로세스를 붙잡지 않게
const listeners = new Set();
const wakeAll = () => [...listeners].forEach((f) => f());
if (channel) channel.onmessage = wakeAll;
else globalThis.addEventListener?.('storage', (e) => e.key === STORE_KEY && wakeAll());
function notifyChange() {
  channel?.postMessage('changed');
  queueMicrotask(wakeAll); // 같은 탭의 대기 중인 폴링도 깨운다
}
function waitChange(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      listeners.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    listeners.add(done);
  });
}

// 여러 탭이 동시에 고치지 않도록 잠금 (Web Locks가 없으면 탭 안에서만 순서대로)
let chain = Promise.resolve();
function withLock(fn) {
  const run = async () => {
    load();
    try {
      return await fn();
    } finally {
      save();
    }
  };
  if (globalThis.navigator?.locks?.request) return navigator.locks.request('shhgnal-demo', run);
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// 데모 초기화: 새 건물로 다시 시작한다. 열려 있는 주민 탭은 등록 화면으로 돌아간다.
export function resetDemo() {
  return withLock(() => {
    storage().removeItem(STORE_KEY);
    load();
  });
}

const unitLabels = (b) => b.config.layout.cells.filter(Boolean);

// ---- 세대별 등록 코드 (세대 QR) ----
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode(b) {
  const used = new Set(Object.values(b.config.unitCodes || {}));
  let code;
  do code = Array.from(randomBytes(8), (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
  while (used.has(code));
  return code;
}
function ensureUnitCodes(b) {
  const codes = (b.config.unitCodes ||= {});
  const labels = new Set(unitLabels(b));
  for (const u of Object.keys(codes)) if (!labels.has(u)) delete codes[u];
  for (const u of labels) codes[u] ||= newCode(b);
  b.config.allowManualJoin ??= true;
}
const unitByCode = (b, code) => {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c ? Object.keys(b.config.unitCodes).find((u) => safeEqual(b.config.unitCodes[u], c)) : null;
};
const usersOf = (b, unit) => [...b.users.values()].filter((u) => u.unit === unit);
const activeUnits = (b) => [...new Set([...b.users.values()].map((u) => u.unit))];
const userById = (b, id) => [...b.users.values()].find((u) => u.id === id);
const isBlocked = (b, user) => b.blocked.has(user.deviceId);

function neighbors(b, unit) {
  const { rows, cols, cells } = b.config.layout;
  const i = cells.indexOf(unit);
  if (i < 0) return {};
  const r = Math.floor(i / cols);
  const c = i % cols;
  const at = (rr, cc) => (rr >= 0 && rr < rows && cc >= 0 && cc < cols ? cells[rr * cols + cc] : null);
  return { up: at(r - 1, c), down: at(r + 1, c), left: at(r, c - 1), right: at(r, c + 1) };
}

// ---- 조용한 시간 (밤) ----
function seoulHour(ts = Date.now()) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).format(ts));
}
function isQuietTime(b, ts = Date.now()) {
  const h = seoulHour(ts);
  const { quietStart: s, quietEnd: e } = b.config;
  return s > e ? h >= s || h < e : h >= s && h < e;
}

// ---- 실시간 전달 (사용자: 이벤트 큐, 관리자: 버전) ----
function queueOf(b, token) {
  if (!b.queues.has(token)) b.queues.set(token, { events: [] });
  return b.queues.get(token);
}

function send(b, token, event, data) {
  if (!b.users.has(token)) return;
  const q = queueOf(b, token);
  q.events.push({ seq: ++seqCounter, event, data });
  if (q.events.length > 50) q.events.shift();
}

function broadcast(b, event, makeData) {
  for (const token of b.users.keys()) send(b, token, event, typeof makeData === 'function' ? makeData(token) : makeData);
}

function touchAdmin(b) {
  b.adminVersion++;
}

// 웹 푸시는 정적 데모에서 쓰지 않는다 (받는 탭이 열려 있으면 그 탭이 알림을 띄운다)
function pushTo() {}

// ---- 화면에 보낼 형태로 변환 ----
const noisePhrase = (a) => NOISE_TYPES[a.type].phrase;
const noiseLabel = (a) => (a.type === 'etc' ? '기타 메시지' : NOISE_TYPES[a.type].label);
const replyTextOf = (a) => (a.reply === 'custom' ? a.replyCustom : a.reply ? REPLIES[a.reply] : null);

const RELAY_STATUS = { open: '관리사무소 확인 중', contacted: '관리사무소가 연락했어요', closed: '관리사무소가 처리를 마쳤어요' };
function relayView(r, forAdmin = false) {
  const base = {
    id: r.id,
    toUnit: r.toUnit,
    dir: r.dir,
    around: r.around,
    type: r.type,
    typeLabel: noiseLabel(r),
    emoji: NOISE_TYPES[r.type].emoji,
    message: r.text || null,
    night: r.night,
    status: r.status,
    statusText: RELAY_STATUS[r.status],
    note: r.note || null,
    createdAt: r.createdAt,
    handledAt: r.handledAt,
  };
  return forAdmin ? { ...base, fromUnit: r.fromUnit, original: r.original || null } : base;
}

function logFilter(b, entry) {
  const item = { id: uuid(), at: Date.now(), ...entry };
  b.filterLog.unshift(item);
  if (b.filterLog.length > FILTER_LOG_MAX) b.filterLog.length = FILTER_LOG_MAX;
  return item;
}

const BLOCKED_MSG = '위협이나 괴롭힘으로 보이는 표현이 있어 전달하지 않았어요. 표현을 바꾸거나 관리사무소 문의를 이용해 주세요.';

// 받는 세대에게는 보낸 세대를 숨긴다 (익명성)
function alertView(a, user) {
  const base = {
    id: a.id,
    type: a.type,
    typeLabel: noiseLabel(a),
    phrase: noisePhrase(a),
    emoji: NOISE_TYPES[a.type].emoji,
    message: a.text || null,
    filtered: Boolean(a.filter && a.filter.severity !== 'none'),
    night: a.night,
    around: a.around,
    createdAt: a.createdAt,
    reply: a.reply,
    replyText: replyTextOf(a),
    repliedAt: a.repliedAt,
  };
  if (a.fromToken === user.token) return { ...base, direction: 'sent', toUnit: a.toUnit, dir: a.dir };
  return { ...base, direction: 'received', reported: Boolean(a.reportId) };
}

function historyFor(b, user) {
  return [...b.alerts.values()]
    .filter((a) => a.fromToken === user.token || (a.toUnit === user.unit && a.fromToken !== user.token))
    .sort((x, y) => y.createdAt - x.createdAt)
    .slice(0, 50)
    .map((a) => alertView(a, user));
}

function liveNotices(b) {
  const now = Date.now();
  for (const [id, n] of b.notices) if (n.endAt <= now) b.notices.delete(id);
  return [...b.notices.values()].sort((x, y) => x.startAt - y.startAt);
}

function noticeView(n, user) {
  return {
    id: n.id,
    type: n.type,
    label: NOTICE_TYPES[n.type].label,
    emoji: NOTICE_TYPES[n.type].emoji,
    text: n.text,
    startAt: n.startAt,
    endAt: n.endAt,
    byAdmin: n.byAdmin,
    unit: n.byAdmin ? null : n.fromUnit,
    mine: Boolean(user && n.fromToken === user.token),
    thanks: n.thanks.size,
    thanked: Boolean(user && n.thanks.has(user.id)),
  };
}

const noticesFor = (b, user) => liveNotices(b).map((n) => noticeView(n, user));
const broadcastNotices = (b) => broadcast(b, 'notices', (t) => noticesFor(b, b.users.get(t)));

function chatOf(b, user) {
  if (!b.chats.has(user.id)) b.chats.set(user.id, { userId: user.id, unit: user.unit, messages: [], unread: 0 });
  const chat = b.chats.get(user.id);
  chat.unit = user.unit;
  return chat;
}

function publicConfig(b) {
  const c = b.config;
  return {
    slug: c.slug,
    name: c.name,
    layout: c.layout,
    faqs: c.faqs,
    quietStart: c.quietStart,
    quietEnd: c.quietEnd,
    quietNow: isQuietTime(b),
    noiseTypes: NOISE_TYPES,
    noticeTypes: NOTICE_TYPES,
    replies: REPLIES,
    reportReasons: REPORT_REASONS,
    sendGapSec: SEND_GAP_SEC,
    sendPerHour: SEND_PER_HOUR,
    replyTextMax: REPLY_TEXT_MAX,
    noticeMaxDays: NOTICE_MAX_DAYS,
    etcTextMax: ETC_TEXT_MAX,
    allowManualJoin: c.allowManualJoin,
    llm: llmStatus(),
    noticeTextMax: NOTICE_TEXT_MAX,
    noticeMaxHours: NOTICE_MAX_HOURS,
    vapidPublicKey: null, // 정적 데모: 웹 푸시 없음
    publicUrl: null,
    demo: true,
  };
}

function helloFor(b, user) {
  return {
    relays: [...b.relays.values()].filter((r) => r.fromToken === user.token).sort((x, y) => y.createdAt - x.createdAt).map((r) => relayView(r)),
    unit: user.unit,
    active: activeUnits(b),
    history: historyFor(b, user),
    notices: noticesFor(b, user),
    chat: b.chats.get(user.id)?.messages || [],
    blocked: isBlocked(b, user),
  };
}

function unitStats(b) {
  const since = Date.now() - REPEAT_DAYS * 86_400_000;
  const stats = {};
  for (const a of b.alerts.values()) {
    if (a.createdAt < since || a.reportId) continue;
    const s = (stats[a.toUnit] ||= { unit: a.toUnit, count: 0, night: 0, senders: new Set(), notus: 0, last: 0 });
    s.count++;
    if (a.night) s.night++;
    if (a.reply === 'notus') s.notus++;
    s.senders.add(a.fromUnit);
    s.last = Math.max(s.last, a.createdAt);
  }
  return Object.values(stats).map((s) => ({ ...s, senders: s.senders.size, repeat: s.senders.size >= REPEAT_SENDERS }));
}

// ---- 현황판 ----
const FEED_MAX = 80;
function feed(b, item) {
  b.feed.unshift({ id: uuid(), at: Date.now(), ...item });
  if (b.feed.length > FEED_MAX) b.feed.length = FEED_MAX;
}
function seoulDayStart(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', timeZone: TZ }).formatToParts(now).map((x) => [x.type, Number(x.value)]));
  return now - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - (now % 1000);
}
function boardSnapshot(b) {
  const day = seoulDayStart();
  const alerts = [...b.alerts.values()];
  const today = alerts.filter((a) => a.createdAt >= day);
  const relays = [...b.relays.values()];
  const pairs = {};
  for (const a of alerts) {
    const k = `${a.fromUnit}>${a.toUnit}`;
    const pr = (pairs[k] ||= { from: a.fromUnit, to: a.toUnit, count: 0, replied: 0, notus: 0, night: 0, last: 0, relay: false });
    pr.count++; if (a.reply) pr.replied++; if (a.reply === 'notus') pr.notus++; if (a.night) pr.night++;
    pr.last = Math.max(pr.last, a.createdAt);
  }
  for (const r of relays) {
    if (r.around) continue;
    const k = `${r.fromUnit}>${r.toUnit}>relay`;
    const pr = (pairs[k] ||= { from: r.fromUnit, to: r.toUnit, count: 0, replied: 0, notus: 0, night: 0, last: 0, relay: true });
    pr.count++; if (r.status !== 'open') pr.replied++; if (r.night) pr.night++;
    pr.last = Math.max(pr.last, r.createdAt);
  }
  const top = (obj) => Object.entries(obj).map(([unit, v]) => ({ unit, ...v, total: v.tomato + v.egg })).sort((x, y) => y.total - x.total).slice(0, 5);
  return {
    now: Date.now(),
    today: {
      alerts: today.length,
      replied: today.filter((a) => a.reply).length,
      notus: today.filter((a) => a.reply === 'notus').length,
      night: today.filter((a) => a.night).length,
      relays: relays.filter((r) => r.createdAt >= day).length,
      relaysOpen: relays.filter((r) => r.status === 'open').length,
      notices: liveNotices(b).length,
      users: b.users.size,
      units: activeUnits(b).length,
    },
    vent: { tomato: b.vent.tomato, egg: b.vent.egg, wok: b.vent.wok, targets: top(b.vent.byTarget), throwers: top(b.vent.byThrower) },
    pairs: Object.values(pairs).sort((x, y) => y.count - x.count),
    feed: b.feed.slice(0, 40),
  };
}

function adminSnapshot(b) {
  const c = b.config;
  const reportCount = (deviceId) => [...b.reports.values()].filter((r) => r.senderDevice === deviceId && r.status !== 'dismissed').length;
  return {
    config: { slug: c.slug, name: c.name, layout: c.layout, faqs: c.faqs, quietStart: c.quietStart, quietEnd: c.quietEnd, allowManualJoin: c.allowManualJoin },
    unitCodes: c.unitCodes,
    households: Object.fromEntries(activeUnits(b).map((u) => [u, usersOf(b, u).length])),
    llm: llmStatus(),
    filterLog: b.filterLog,
    board: boardSnapshot(b),
    relays: [...b.relays.values()].sort((x, y) => y.createdAt - x.createdAt).map((r) => relayView(r, true)),
    quietNow: isQuietTime(b),
    repeatDays: REPEAT_DAYS,
    repeatSenders: REPEAT_SENDERS,
    active: activeUnits(b),
    users: [...b.users.values()].map((u) => ({
      id: u.id,
      unit: u.unit,
      joinedAt: u.joinedAt,
      pushOn: false,
      blocked: isBlocked(b, u),
      reportCount: reportCount(u.deviceId),
    })),
    unitStats: unitStats(b),
    alerts: [...b.alerts.values()]
      .sort((x, y) => y.createdAt - x.createdAt)
      .slice(0, 40)
      .map((a) => ({
        id: a.id,
        fromUnit: a.fromUnit,
        toUnit: a.toUnit,
        typeLabel: noiseLabel(a),
        emoji: NOISE_TYPES[a.type].emoji,
        message: a.text || null,
        filtered: Boolean(a.filter && a.filter.severity !== 'none'),
        night: a.night,
        around: a.around,
        replyText: replyTextOf(a),
        replyOriginal: a.replyOriginal || null,
        reported: Boolean(a.reportId),
        createdAt: a.createdAt,
      })),
    notices: liveNotices(b).map((n) => noticeView(n, null)),
    reports: [...b.reports.values()]
      .sort((x, y) => y.at - x.at)
      .map((r) => ({
        ...r,
        senderDevice: undefined,
        reporterDevice: undefined,
        reasonText: REPORT_REASONS[r.reason],
        senderBlocked: b.blocked.has(r.senderDevice),
        senderCount: reportCount(r.senderDevice),
      })),
    blocked: [...b.blocked.entries()].map(([deviceId, x]) => ({ deviceId, ...x })),
    chats: [...b.chats.values()]
      .map((ch) => ({
        ...ch,
        active: Boolean(userById(b, ch.userId)),
        unit: userById(b, ch.userId)?.unit ?? ch.unit,
        lastAt: ch.messages.at(-1)?.at || 0,
      }))
      .sort((x, y) => y.lastAt - x.lastAt),
  };
}

// FAQ 키워드가 문의 내용에 들어 있으면 챗봇이 안내한다
const STOP_WORDS = new Set(['어떻게', '되나요', '뭐예요', '있나요', '하나요', '싶어요', '알려주세요', '언제', '어디', '무엇', '쓰나요', '인가요']);
function matchFaq(b, text) {
  const norm = text.replace(/\s+/g, '');
  let best = null;
  let bestScore = 0;
  for (const f of b.config.faqs) {
    let score = 0;
    for (const word of f.q.split(/[^\p{L}\p{N}]+/u)) {
      const stem = word.replace(/[은는이가을를의에도요]+$/u, '');
      if (stem.length >= 2 && !STOP_WORDS.has(word) && norm.includes(stem)) score++;
    }
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

function addChatMessages(b, user, messages) {
  const chat = chatOf(b, user);
  const at = Date.now();
  const added = messages.map((m) => ({ id: uuid(), at, ...m }));
  chat.messages.push(...added);
  if (chat.messages.length > 200) chat.messages.splice(0, chat.messages.length - 200);
  send(b, user.token, 'chat', added);
  touchAdmin(b);
  return added;
}

function removeUser(b, token) {
  if (!b.users.has(token)) return;
  b.users.delete(token);
  b.queues.delete(token);
}

// ---- 요청 처리 유틸 ----
const json = (status, data) => ({ status, data });
const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const cleanMessage = (v, max) =>
  typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '';
const pick = (f) => ({ severity: f.severity, blocked: f.blocked, reason: f.reason, source: f.source, fallback: Boolean(f.fallback) });

function parseNoticeTime(body) {
  const startAt = Number(body.startAt);
  const endAt = Number(body.endAt);
  const now = Date.now();
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return { error: '끝나는 시간이 시작 시간보다 늦어야 해요.' };
  if (endAt <= now) return { error: '이미 지난 시간이에요.' };
  if (endAt - startAt > NOTICE_MAX_HOURS * 3_600_000) return { error: `한 번에 ${NOTICE_MAX_HOURS}시간까지 올릴 수 있어요.` };
  if (startAt - now > NOTICE_MAX_DAYS * 86_400_000) return { error: `${NOTICE_MAX_DAYS}일 안의 일정만 올릴 수 있어요.` };
  return { startAt, endAt };
}

// ---- 주민 API ----
async function handleUserApi(method, b, rest, url, body) {
  if (method === 'GET' && rest === 'config') return json(200, publicConfig(b));

  if (method === 'GET' && rest === 'unit-code') {
    const unit = unitByCode(b, url.searchParams.get('code'));
    return unit ? json(200, { unit }) : json(404, { error: '등록 QR이 올바르지 않거나 다시 발급됐어요. 관리사무소에 문의해 주세요.' });
  }

  if (method !== 'POST') return json(404, { error: '없는 API예요.' });

  // 1. 세대 등록 / 변경
  if (rest === 'join') {
    let unit;
    if (body.code) {
      unit = unitByCode(b, body.code);
      if (!unit) return json(403, { error: '등록 QR이 올바르지 않거나 다시 발급됐어요. 관리사무소에 문의해 주세요.' });
    } else {
      if (!b.config.allowManualJoin) return json(403, { error: '우리 집 전용 QR을 찍어서 등록해 주세요. QR은 관리사무소에서 나눠 드려요.' });
      unit = cleanText(String(body.unit ?? ''), 10).replace(/호$/, '');
      if (!unitLabels(b).includes(unit)) return json(400, { error: `${unit || '그'}호는 이 건물에 없어요.` });
    }
    const prev = b.users.get(body.token);
    const token = prev ? prev.token : uuid();
    const user = prev || { token, id: uuid().slice(0, 8), joinedAt: Date.now(), push: null };
    user.unit = unit;
    user.deviceId = cleanText(body.deviceId, 64) || user.deviceId || token;
    b.users.set(token, user);
    if (b.chats.has(user.id)) b.chats.get(user.id).unit = unit;
    broadcast(b, 'state', { active: activeUnits(b) });
    touchAdmin(b);
    return json(200, { token, unit, moved: Boolean(prev), household: usersOf(b, unit).length });
  }

  const user = b.users.get(body.token);
  if (!user) return json(401, { error: '먼저 세대를 등록해 주세요.' });

  if (rest === 'leave') {
    removeUser(b, user.token);
    broadcast(b, 'state', { active: activeUnits(b) });
    touchAdmin(b);
    return json(200, { ok: true });
  }

  if (rest === 'push/subscribe') return json(400, { error: '정적 데모에서는 웹 푸시를 쓰지 않아요.' });

  // 2. 소음 알림 보내기
  if (rest === 'alerts') {
    if (isBlocked(b, user)) return json(403, { error: '신고가 누적돼 알림 보내기가 제한됐어요. 관리사무소에 문의해 주세요.' });
    if (!NOISE_TYPES[body.type]) return json(400, { error: '소음 종류를 골라 주세요.' });
    const raw = body.type === 'etc' ? cleanMessage(body.text, ETC_TEXT_MAX) : '';
    if (body.type === 'etc' && !raw) return json(400, { error: '전할 내용을 적어 주세요.' });

    const around = body.target === 'around';
    const near = neighbors(b, user.unit);
    const dirOf = (unit) => Object.keys(near).find((k) => near[k] === unit) || null;
    let targets;
    let relayTo = null;
    if (around) {
      targets = [...new Set(Object.values(near).filter(Boolean))].filter((u) => usersOf(b, u).length);
      if (!targets.length) relayTo = '주변 세대';
    } else {
      const unit = cleanText(String(body.target ?? ''), 10);
      if (unit === user.unit) return json(400, { error: '우리 집에는 보낼 수 없어요.' });
      if (!unitLabels(b).includes(unit)) return json(400, { error: `${unit || '그'}호는 이 건물에 없어요.` });
      targets = usersOf(b, unit).length ? [unit] : [];
      if (!targets.length) relayTo = unit;
    }

    const now = Date.now();
    const times = b.sendLog.get(user.deviceId) || [];
    const limit = checkSendLimit(times, now);
    if (limit) return json(429, { error: limit.error, retryAfterSec: limit.retryAfterSec });

    let text = '';
    let filter = null;
    if (body.type === 'etc') {
      const pv = b.previews.get(body.previewId);
      filter = pv && pv.token === user.token && pv.original === raw && pv.expires > now ? pv.filter : await filterMessage('neighbor', raw);
      b.previews.delete(body.previewId);
      const toLabel = relayTo ? `${relayTo === '주변 세대' ? relayTo : `${relayTo}호`} (관리사무소 경유)` : around ? `주변 ${targets.length}세대` : `${targets[0]}호`;
      logFilter(b, { kind: 'neighbor', fromUnit: user.unit, toUnit: toLabel, original: raw, delivered: filter.text, ...pick(filter) });
      touchAdmin(b);
      if (filter.blocked) return json(422, { error: BLOCKED_MSG, blocked: true });
      text = filter.text;
    }
    b.sendLog.set(user.deviceId, [...times.filter((t) => now - t < 3_600_000), now]);
    const night = isQuietTime(b, now);

    if (relayTo) {
      const relay = {
        id: uuid(),
        fromToken: user.token,
        fromDevice: user.deviceId,
        fromUnit: user.unit,
        toUnit: relayTo,
        dir: around ? null : dirOf(relayTo),
        around,
        type: body.type,
        text,
        original: raw || null,
        night,
        status: 'open',
        note: '',
        createdAt: now,
        handledAt: null,
      };
      b.relays.set(relay.id, relay);
      feed(b, { kind: 'relay', icon: '📞', from: user.unit, to: around ? '주변' : relayTo, text: `${noiseLabel(relay)} · 미가입 세대라 관리사무소 경유`, night });
      touchAdmin(b);
      const who = around ? '주변 세대 중 앱을 쓰는 집이 없어요' : `${relayTo}호는 아직 앱에 가입하지 않았어요`;
      return json(200, { alerts: [], relay: relayView(relay), message: `${who}. 관리사무소에 전달했고, 관리사무소가 연락하면 알려 드릴게요.` });
    }

    const groupId = uuid();
    const sent = [];
    for (const toUnit of targets) {
      const alert = {
        id: uuid(),
        groupId,
        fromToken: user.token,
        fromId: user.id,
        fromDevice: user.deviceId,
        fromUnit: user.unit,
        toUnit,
        dir: dirOf(toUnit),
        type: body.type,
        text,
        original: raw || null,
        filter: filter && pick(filter),
        night,
        around,
        createdAt: now,
        reply: null,
        replyBy: null,
        repliedAt: null,
        reportId: null,
      };
      b.alerts.set(alert.id, alert);
      sent.push(alertView(alert, user));
      feed(b, { kind: 'alert', icon: NOISE_TYPES[alert.type].emoji, from: alert.fromUnit, to: alert.toUnit, text: `${noiseLabel(alert)}${around ? ' (주변 확인)' : ''}`, night });
      for (const member of usersOf(b, toUnit)) send(b, member.token, 'alert', alertView(alert, member));
    }
    touchAdmin(b);
    return json(200, { alerts: sent });
  }

  // 3. 받은 세대의 답장
  let m = rest.match(/^alerts\/([\w-]+)\/reply$/);
  if (m) {
    const alert = b.alerts.get(m[1]);
    if (!alert || alert.toUnit !== user.unit || alert.fromToken === user.token) return json(404, { error: '알림을 찾을 수 없어요.' });
    if (!REPLIES[body.reply] && body.reply !== 'custom') return json(400, { error: '답장을 골라 주세요.' });
    if (alert.reply) return json(409, { error: '이미 가족 중 한 분이 답장했어요.' });
    if (body.reply === 'custom') {
      const raw = cleanMessage(body.text, REPLY_TEXT_MAX);
      if (!raw) return json(400, { error: '답장 내용을 적어 주세요.' });
      const filter = await filterMessage('reply', raw);
      logFilter(b, { kind: 'reply', fromUnit: user.unit, toUnit: `${alert.fromUnit}호 (답장)`, original: raw, delivered: filter.text, ...pick(filter) });
      touchAdmin(b);
      if (filter.blocked) return json(422, { error: BLOCKED_MSG, blocked: true });
      alert.replyCustom = filter.text;
      alert.replyOriginal = raw;
    }
    alert.reply = body.reply;
    alert.replyBy = user.id;
    alert.repliedAt = Date.now();
    feed(b, { kind: 'reply', icon: alert.reply === 'notus' ? '🙅' : '↩️', from: alert.toUnit, to: alert.fromUnit, text: `답장: ${replyTextOf(alert)}` });
    const sender = b.users.get(alert.fromToken);
    if (sender) send(b, sender.token, 'reply', alertView(alert, sender));
    for (const member of usersOf(b, alert.toUnit)) if (member.token !== user.token) send(b, member.token, 'reply', alertView(alert, member));
    touchAdmin(b);
    return json(200, alertView(alert, user));
  }

  // 4. 스팸 신고
  m = rest.match(/^alerts\/([\w-]+)\/report$/);
  if (m) {
    const alert = b.alerts.get(m[1]);
    if (!alert || alert.toUnit !== user.unit || alert.fromToken === user.token) return json(404, { error: '알림을 찾을 수 없어요.' });
    if (!REPORT_REASONS[body.reason]) return json(400, { error: '신고 이유를 골라 주세요.' });
    if (alert.reportId) return json(409, { error: '이미 신고했어요.' });
    const report = {
      id: uuid(),
      alertId: alert.id,
      reason: body.reason,
      reporterUnit: user.unit,
      reporterDevice: user.deviceId,
      senderUnit: alert.fromUnit,
      senderDevice: alert.fromDevice,
      alertLabel: noiseLabel(alert),
      status: 'open',
      at: Date.now(),
    };
    b.reports.set(report.id, report);
    alert.reportId = report.id;
    feed(b, { kind: 'report', icon: '🚩', from: user.unit, to: alert.fromUnit, text: '부당한 알림 신고' });
    const reporters = new Set([...b.reports.values()].filter((r) => r.senderDevice === alert.fromDevice && r.status !== 'dismissed').map((r) => r.reporterUnit));
    if (reporters.size >= AUTO_BLOCK_REPORTS && !b.blocked.has(alert.fromDevice)) {
      setBlocked(b, alert.fromDevice, true, { unit: alert.fromUnit, reason: `${reporters.size}세대 신고 누적 (자동)` });
    }
    for (const member of usersOf(b, alert.toUnit)) if (member.token !== user.token) send(b, member.token, 'reply', alertView(alert, member));
    touchAdmin(b);
    return json(200, alertView(alert, user));
  }

  // 기타 메시지 미리 다듬어 보기
  if (rest === 'filter/preview') {
    const raw = cleanMessage(body.text, ETC_TEXT_MAX);
    if (!raw) return json(400, { error: '전할 내용을 적어 주세요.' });
    const now = Date.now();
    const hits = (b.previewHits.get(user.token) || []).filter((t) => now - t < 60_000);
    if (hits.length >= PREVIEW_PER_MIN) return json(429, { error: '잠시 후 다시 다듬어 주세요.' });
    b.previewHits.set(user.token, [...hits, now]);
    for (const [id, pv] of b.previews) if (pv.expires <= now) b.previews.delete(id);
    const filter = await filterMessage('neighbor', raw);
    const previewId = uuid();
    b.previews.set(previewId, { token: user.token, original: raw, filter, expires: now + PREVIEW_TTL_MS });
    return json(200, { previewId, text: filter.text, changed: filter.text !== raw, blocked: filter.blocked, blockedMessage: filter.blocked ? BLOCKED_MSG : null });
  }

  // 5. 미리 양해 구하기
  if (rest === 'notices') {
    if (!NOTICE_TYPES[body.type]) return json(400, { error: '어떤 일인지 골라 주세요.' });
    const t = parseNoticeTime(body);
    if (t.error) return json(400, { error: t.error });
    const mine = liveNotices(b).filter((n) => n.fromToken === user.token);
    if (mine.length >= 3) return json(429, { error: '진행 중인 공지는 3개까지 올릴 수 있어요.' });
    const raw = cleanText(body.text, NOTICE_TEXT_MAX);
    let noticeText = '';
    if (raw) {
      const filter = await filterMessage('notice', raw);
      logFilter(b, { kind: 'notice', fromUnit: user.unit, toUnit: '이웃 전체', original: raw, delivered: filter.text, ...pick(filter) });
      touchAdmin(b);
      if (filter.blocked) return json(422, { error: BLOCKED_MSG, blocked: true });
      noticeText = filter.text.slice(0, NOTICE_TEXT_MAX * 2);
    }
    const notice = {
      id: uuid(),
      fromToken: user.token,
      fromUnit: user.unit,
      byAdmin: false,
      type: body.type,
      text: noticeText,
      startAt: t.startAt,
      endAt: t.endAt,
      thanks: new Set(),
      createdAt: Date.now(),
    };
    b.notices.set(notice.id, notice);
    feed(b, { kind: 'notice', icon: NOTICE_TYPES[notice.type].emoji, from: notice.fromUnit, to: '이웃', text: `양해 공지 · ${NOTICE_TYPES[notice.type].label}${notice.text ? ` · ${notice.text}` : ''}` });
    broadcastNotices(b);
    touchAdmin(b);
    return json(200, noticeView(notice, user));
  }

  m = rest.match(/^notices\/([\w-]+)\/(thanks|delete)$/);
  if (m) {
    const notice = liveNotices(b).find((n) => n.id === m[1]);
    if (!notice) return json(404, { error: '이미 끝난 공지예요.' });
    if (m[2] === 'delete') {
      if (notice.fromToken !== user.token) return json(403, { error: '내가 올린 공지만 내릴 수 있어요.' });
      b.notices.delete(notice.id);
    } else {
      if (notice.fromToken === user.token) return json(400, { error: '내 공지에는 누를 수 없어요.' });
      notice.thanks.add(user.id);
    }
    broadcastNotices(b);
    touchAdmin(b);
    return json(200, { notices: noticesFor(b, user) });
  }

  // 화풀기 기록 (실제로는 아무에게도 전달되지 않는다)
  if (rest === 'vent') {
    const now = Date.now();
    if (now - (b.vent.lastAt[user.token] || 0) < 800) return json(429, { error: '잠시 후 다시 보내 주세요.' });
    b.vent.lastAt[user.token] = now;
    const n = (v) => Math.max(0, Math.min(30, Math.floor(Number(v) || 0)));
    const tomato = n(body.tomato), egg = n(body.egg), wok = Math.min(3, n(body.wok));
    if (!tomato && !egg && !wok) return json(400, { error: '기록할 내용이 없어요.' });
    const target = neighbors(b, user.unit).up || '윗집';
    b.vent.tomato += tomato; b.vent.egg += egg; b.vent.wok += wok;
    const bt = (b.vent.byTarget[target] ||= { tomato: 0, egg: 0 }); bt.tomato += tomato; bt.egg += egg;
    const bw = (b.vent.byThrower[user.unit] ||= { tomato: 0, egg: 0 }); bw.tomato += tomato; bw.egg += egg;
    if (tomato || egg) feed(b, { kind: 'vent', icon: '🔥', from: user.unit, to: target, text: `화풀기 ${tomato ? `🍅${tomato}` : ''}${egg ? ` 🥚${egg}` : ''}`.trim() });
    if (wok) feed(b, { kind: 'wok', icon: '🍳', from: user.unit, to: target, text: '토계볶 완성!' });
    touchAdmin(b);
    return json(200, { ok: true });
  }

  // 6. 1:1 문의
  if (rest === 'chat') {
    if (body.faqId) {
      const faq = b.config.faqs.find((f) => f.id === body.faqId);
      if (!faq) return json(404, { error: '없는 질문이에요.' });
      return json(200, { messages: addChatMessages(b, user, [{ from: 'user', text: faq.q }, { from: 'bot', text: faq.a }]) });
    }
    const text = cleanMessage(body.text, OFFICE_MSG_MAX);
    if (!text) return json(400, { error: '메시지를 입력해 주세요.' });
    const filter = await filterMessage('office', text);
    const filtered = filter.text !== text;
    logFilter(b, { kind: 'office', fromUnit: user.unit, toUnit: '관리사무소', original: text, delivered: filter.text, ...pick(filter) });
    chatOf(b, user).unread++;
    feed(b, { kind: 'chat', icon: '💬', from: user.unit, to: '관리사무소', text: `문의 · ${filter.text.length > 40 ? `${filter.text.slice(0, 40)}…` : filter.text}` });
    const msgs = [{ from: 'user', text, delivered: filter.text, filtered, severity: filter.severity }];
    const faq = matchFaq(b, text);
    const note = filtered ? '\n(감정이 담긴 표현은 정중하게 다듬어 전달했어요.)' : '';
    if (faq) msgs.push({ from: 'bot', text: `혹시 이 내용을 찾으셨나요?\n「${faq.q}」\n${faq.a}\n\n관리사무소에도 문의를 전달했어요.${note}` });
    else msgs.push({ from: 'bot', text: `관리사무소에 문의를 전달했어요. 답변이 오면 알려드릴게요.${note}` });
    return json(200, { messages: addChatMessages(b, user, msgs) });
  }

  return json(404, { error: '없는 API예요.' });
}

function setBlocked(b, deviceId, blocked, info = {}) {
  if (blocked) b.blocked.set(deviceId, { unit: info.unit ?? null, reason: info.reason || '관리사무소 제한', at: Date.now() });
  else b.blocked.delete(deviceId);
  for (const u of b.users.values()) if (u.deviceId === deviceId) send(b, u.token, 'blocked', { blocked });
}

// ---- 관리사무소 API ----
async function handleAdminApi(method, b, rest, body) {
  if (method !== 'POST') return json(404, { error: '없는 API예요.' });

  if (rest === 'layout') {
    const rows = Number(body.rows);
    const cols = Number(body.cols);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 50 || cols > 10) {
      return json(400, { error: '층은 1~50, 라인은 1~10 사이로 정해 주세요.' });
    }
    if (!Array.isArray(body.cells) || body.cells.length !== rows * cols) return json(400, { error: '배치도 데이터가 올바르지 않아요.' });
    const cells = body.cells.map((c) => cleanText(String(c ?? ''), 6) || null);
    const labels = cells.filter(Boolean);
    if (!labels.length) return json(400, { error: '세대가 하나 이상 있어야 해요.' });
    const dup = labels.find((l, i) => labels.indexOf(l) !== i);
    if (dup) return json(400, { error: `${dup}호가 두 번 있어요.` });
    b.config.layout = { rows, cols, cells };
    ensureUnitCodes(b);
    const kicked = [];
    for (const u of [...b.users.values()]) {
      if (!labels.includes(u.unit)) {
        kicked.push(u.unit);
        removeUser(b, u.token);
      }
    }
    broadcast(b, 'layout', { layout: b.config.layout, active: activeUnits(b) });
    touchAdmin(b);
    return json(200, { ok: true, kicked: [...new Set(kicked)] });
  }

  if (rest === 'faqs') {
    if (!Array.isArray(body.faqs)) return json(400, { error: 'FAQ 형식이 올바르지 않아요.' });
    const faqs = body.faqs
      .map((f) => ({ id: typeof f.id === 'string' && f.id ? f.id : uuid(), q: cleanText(f.q, 80), a: String(f.a ?? '').trim().slice(0, 500) }))
      .filter((f) => f.q && f.a)
      .slice(0, 30);
    b.config.faqs = faqs;
    broadcast(b, 'config', { faqs, name: b.config.name, quietStart: b.config.quietStart, quietEnd: b.config.quietEnd, quietNow: isQuietTime(b) });
    touchAdmin(b);
    return json(200, { ok: true, faqs });
  }

  if (rest === 'settings') {
    const name = cleanText(body.name, 30);
    if (body.name !== undefined && !name) return json(400, { error: '건물 이름을 입력해 주세요.' });
    const quiet = { quietStart: b.config.quietStart, quietEnd: b.config.quietEnd };
    for (const k of Object.keys(quiet)) {
      if (body[k] === undefined) continue;
      const h = Number(body[k]);
      if (!Number.isInteger(h) || h < 0 || h > 23) return json(400, { error: '조용한 시간은 0~23시로 정해 주세요.' });
      quiet[k] = h;
    }
    if (quiet.quietStart === quiet.quietEnd) return json(400, { error: '시작과 끝 시간이 같으면 안 돼요.' });
    if (name) b.config.name = name;
    Object.assign(b.config, quiet);
    if (body.allowManualJoin !== undefined) b.config.allowManualJoin = Boolean(body.allowManualJoin);
    broadcast(b, 'config', { faqs: b.config.faqs, name: b.config.name, quietStart: b.config.quietStart, quietEnd: b.config.quietEnd, quietNow: isQuietTime(b), allowManualJoin: b.config.allowManualJoin });
    touchAdmin(b);
    return json(200, { ok: true });
  }

  let mr = rest.match(/^relays\/([\w-]+)$/);
  if (mr) {
    const relay = b.relays.get(mr[1]);
    if (!relay) return json(404, { error: '요청을 찾을 수 없어요.' });
    if (!['contacted', 'closed'].includes(body.action)) return json(400, { error: '처리 방법을 골라 주세요.' });
    relay.status = body.action;
    relay.note = cleanText(body.note, 100);
    relay.handledAt = Date.now();
    feed(b, { kind: 'relay-done', icon: '🏢', from: '관리사무소', to: relay.around ? '주변' : relay.toUnit, text: relay.status === 'contacted' ? `대신 연락했어요${relay.note ? ` · ${relay.note}` : ''}` : '처리 끝' });
    const reporter = b.users.get(relay.fromToken);
    if (reporter) send(b, reporter.token, 'relay', relayView(relay));
    touchAdmin(b);
    return json(200, { ok: true, notified: Boolean(reporter) });
  }

  let mc = rest.match(/^codes\/([^/]+)\/reissue$/);
  if (mc) {
    const unit = decodeURIComponent(mc[1]);
    if (!unitLabels(b).includes(unit)) return json(404, { error: `${unit}호는 이 건물에 없어요.` });
    b.config.unitCodes[unit] = newCode(b);
    const kicked = usersOf(b, unit);
    for (const u of kicked) removeUser(b, u.token);
    if (kicked.length) broadcast(b, 'state', { active: activeUnits(b) });
    touchAdmin(b);
    return json(200, { ok: true, kicked: kicked.length });
  }

  if (rest === 'notices') {
    if (!NOTICE_TYPES[body.type]) return json(400, { error: '공지 종류를 골라 주세요.' });
    const t = parseNoticeTime(body);
    if (t.error) return json(400, { error: t.error });
    const text = cleanText(body.text, NOTICE_TEXT_MAX);
    if (!text) return json(400, { error: '공지 내용을 입력해 주세요.' });
    const notice = { id: uuid(), fromToken: null, fromUnit: null, byAdmin: true, type: body.type, text, startAt: t.startAt, endAt: t.endAt, thanks: new Set(), createdAt: Date.now() };
    b.notices.set(notice.id, notice);
    feed(b, { kind: 'notice', icon: NOTICE_TYPES[notice.type].emoji, from: '관리사무소', to: '이웃', text: `양해 공지 · ${NOTICE_TYPES[notice.type].label} · ${notice.text}` });
    broadcastNotices(b);
    touchAdmin(b);
    return json(200, { ok: true });
  }

  let m = rest.match(/^notices\/([\w-]+)\/delete$/);
  if (m) {
    if (!b.notices.delete(m[1])) return json(404, { error: '공지를 찾을 수 없어요.' });
    broadcastNotices(b);
    touchAdmin(b);
    return json(200, { ok: true });
  }

  m = rest.match(/^reports\/([\w-]+)$/);
  if (m) {
    const report = b.reports.get(m[1]);
    if (!report) return json(404, { error: '신고를 찾을 수 없어요.' });
    if (body.action === 'block') {
      report.status = 'blocked';
      setBlocked(b, report.senderDevice, true, { unit: report.senderUnit, reason: '관리사무소 제한' });
    } else if (body.action === 'dismiss') {
      report.status = 'dismissed';
    } else return json(400, { error: '처리 방법을 골라 주세요.' });
    touchAdmin(b);
    return json(200, { ok: true });
  }

  if (rest === 'unblock') {
    if (!b.blocked.has(body.deviceId)) return json(404, { error: '제한 목록에 없어요.' });
    setBlocked(b, body.deviceId, false);
    for (const r of b.reports.values()) if (r.senderDevice === body.deviceId && r.status === 'open') r.status = 'dismissed';
    touchAdmin(b);
    return json(200, { ok: true });
  }

  m = rest.match(/^chats\/([\w-]+)(\/read)?$/);
  if (m) {
    const chat = b.chats.get(m[1]);
    if (!chat) return json(404, { error: '대화를 찾을 수 없어요.' });
    if (m[2]) {
      chat.unread = 0;
      touchAdmin(b);
      return json(200, { ok: true });
    }
    const user = userById(b, m[1]);
    if (!user) return json(410, { error: '등록을 해제한 주민이에요.' });
    const text = cleanText(body.text, CHAT_MAX);
    if (!text) return json(400, { error: '메시지를 입력해 주세요.' });
    chat.unread = 0;
    addChatMessages(b, user, [{ from: 'admin', text }]);
    return json(200, { ok: true });
  }

  return json(404, { error: '없는 API예요.' });
}

// ---- 롱폴링 흉내: 바뀐 게 있으면 바로, 없으면 다른 탭의 변경을 최대 25초 기다린다 ----
async function waitFor(check) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const r = await withLock(() => check(false));
    if (r) return r;
    const left = deadline - Date.now();
    if (left <= 0) return withLock(() => check(true));
    await waitChange(left);
  }
}

function userPoll(slug, url) {
  const token = url.searchParams.get('token');
  if (!url.searchParams.has('after')) {
    return withLock(() => {
      const b = buildings.get(slug);
      const user = b.users.get(token);
      if (!user) return json(200, { invalid: true });
      queueOf(b, token);
      return json(200, { seq: seqCounter, events: [{ event: 'hello', data: helloFor(b, user) }] });
    });
  }
  const after = Number(url.searchParams.get('after')) || 0;
  return waitFor((timedOut) => {
    const b = buildings.get(slug);
    if (!b.users.has(token)) return json(200, { invalid: true });
    if (after > seqCounter) return json(200, { seq: 0, events: [], resync: true }); // 데모 초기화
    const events = (b.queues.get(token)?.events || []).filter((e) => e.seq > after);
    if (events.length) return json(200, { seq: events.at(-1).seq, events });
    return timedOut ? json(200, { seq: after, events: [] }) : null;
  });
}

function adminPoll(slug, url) {
  const after = Number(url.searchParams.get('after')) || 0;
  return waitFor((timedOut) => {
    const b = buildings.get(slug);
    if (after !== b.adminVersion || timedOut) return json(200, { version: b.adminVersion, snapshot: adminSnapshot(b) });
    return null;
  });
}

// ---- 라우팅 ----
async function handle(method, url, body, adminKey) {
  const m = url.pathname.match(/\/api\/b\/([a-z0-9-]+)\/(.+)$/);
  if (!m) return json(404, { error: '없는 API예요.' });
  const [, slug, rest] = m;
  if (slug !== DEMO_SLUG) return json(404, { error: '없는 건물이에요. 주소를 확인해 주세요.' });
  const isAdmin = rest.startsWith('admin/');
  if (isAdmin && !safeEqual(adminKey || '', DEMO_ADMIN_KEY)) return json(401, { error: '관리자 키가 올바르지 않아요.' });
  if (method === 'GET' && rest === 'poll') return userPoll(slug, url);
  if (method === 'GET' && rest === 'admin/poll') return adminPoll(slug, url);
  return withLock(() => {
    const b = buildings.get(slug);
    return isAdmin ? handleAdminApi(method, b, rest.slice(6), body) : handleUserApi(method, b, rest, url, body);
  });
}

// 화면 코드의 fetch('api/b/...')만 가로챈다. 나머지(CDN 등)는 원래 fetch로 보낸다.
const realFetch = globalThis.fetch?.bind(globalThis);
const respond = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
globalThis.fetch = async (input, init = {}) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, globalThis.location?.href || 'http://demo.local/');
  if (!/\/api\/b\//.test(url.pathname)) return realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  let body = {};
  if (init.body) {
    try {
      body = JSON.parse(init.body);
    } catch {
      return respond(400, { error: '요청 형식이 올바르지 않아요.' });
    }
  }
  const headers = new Headers(init.headers || {});
  try {
    const r = await handle(method, url, body, headers.get('x-admin-key'));
    return respond(r.status, r.data);
  } catch (e) {
    console.error(e);
    return respond(500, { error: '데모 처리 중 오류가 났어요.' });
  }
};
