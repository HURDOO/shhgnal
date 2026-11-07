// 쉿!그널 프로토타입 서버 (층간소음 · 아파트 버전)
// - 건물(동)별 주소: /b/<slug>/ (주민), /b/<slug>/admin (관리사무소), 세대별 등록 QR은 관리사무소 화면에서 인쇄
// - 건물 설정(세대 배치, FAQ, 조용한 시간)은 data/buildings.json에 저장, 등록·알림·공지·채팅은 메모리에만 저장
// - 실시간 전달: 롱폴링 (터널·프록시를 그대로 통과) + 앱이 닫혀 있을 때는 웹 푸시
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { filterMessage, llmStatus } from './llm.js';
import { checkSendLimit, SEND_GAP_SEC, SEND_PER_HOUR } from './limits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // 테스트는 임시 폴더를 쓴다
const BUILDINGS_FILE = path.join(DATA_DIR, 'buildings.json');
const PORT = Number(process.env.PORT) || 3001;
const TZ = 'Asia/Seoul';

const POLL_TIMEOUT_MS = 25_000;
const AUTO_BLOCK_REPORTS = 3; // 서로 다른 세대에게 이만큼 신고되면 알림 보내기 자동 제한
const REPEAT_DAYS = 7; // 반복 소음 세대 집계 기간
const REPEAT_SENDERS = 3; // 기간 안에 서로 다른 세대 이만큼에게 알림 받으면 관리사무소에 표시
const ETC_TEXT_MAX = 100; // 이웃끼리 주고받는 글 (기타 메시지, 직접 답장, 양해 공지)
const REPLY_TEXT_MAX = 100;
const NOTICE_MAX_DAYS = 30; // 양해 공지는 30일 안의 일정까지
const FILTER_LOG_MAX = 300;
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_PER_MIN = 10;
const NOTICE_TEXT_MAX = 100;
const NOTICE_MAX_HOURS = 12;
const CHAT_MAX = 300; // 관리사무소 답변
const OFFICE_MSG_MAX = 3000; // 주민 문의 (긴 민원도 받는다)

// ---- 웹 푸시(VAPID) 키 ----
// 환경변수가 없으면 처음 실행할 때 만들어 data/vapid.json에 저장한다 (git에 올리지 말 것).
function loadVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(DATA_DIR, 'vapid.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    const keys = webpush.generateVAPIDKeys();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
    console.log('VAPID 키를 새로 만들었어요: data/vapid.json');
    return keys;
  }
}
const VAPID = loadVapidKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:knock-neighbor@example.com', VAPID.publicKey, VAPID.privateKey);

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

// 미리 양해 구하기 (공지) 종류
const NOTICE_TYPES = {
  move: { label: '이사', emoji: '📦' },
  construction: { label: '인테리어 · 공사', emoji: '🛠️' },
  assembly: { label: '가구 조립', emoji: '🪛' },
  guests: { label: '손님 방문', emoji: '🎉' },
  kids: { label: '아이 친구들 방문', emoji: '🧒' },
  etc: { label: '기타', emoji: '📢' },
};

// 주변 세대 방향 (배치도의 위·아래·양옆 칸)
const DIRS = { up: '윗집', down: '아랫집', left: '옆집', right: '옆집' };

// ---- 건물 ----
const buildings = new Map(); // slug -> { config, ...runtime }

// 기본 배치: 10층 × 4라인, 위층이 위에 오도록 0행 = 꼭대기 층
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
  ].map((f) => ({ id: crypto.randomUUID(), ...f }));
}

function runtime() {
  return {
    users: new Map(), // token -> { token, id, deviceId, unit, joinedAt, push } (한 세대에 여러 명 가능)
    alerts: new Map(),
    sendLog: new Map(), // deviceId -> 소리 민원 보낸 시각들 (5분·1시간 제한)
    relays: new Map(), // 앱 미가입 세대로 보낸 민원 → 관리사무소가 대신 연락
    queues: new Map(), // token -> { events, waiters }
    notices: new Map(), // id -> 양해 공지
    reports: new Map(),
    blocked: new Map(), // deviceId -> { unit, at, reason }
    chats: new Map(), // user id -> { userId, unit, messages, unread }
    filterLog: [], // 필터를 거친 글 (원문 포함, 관리사무소만 볼 수 있음)
    previews: new Map(), // previewId -> 기타 메시지 미리 다듬기 결과
    previewHits: new Map(), // token -> 최근 1분 미리보기 시각들
    feed: [], // 현황판 실시간 소식 (최근 것부터)
    vent: { tomato: 0, egg: 0, wok: 0, byTarget: {}, byThrower: {}, lastAt: {} }, // 화풀기 (가상 투척, 실제 전달 없음)
    adminVersion: 1,
    adminWaiters: new Set(),
  };
}

function saveBuildings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const list = [...buildings.values()].map((b) => b.config);
  fs.writeFileSync(BUILDINGS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

function createBuilding(name, slug, floors, lines) {
  const config = {
    slug,
    name,
    adminKey: crypto.randomBytes(16).toString('hex'),
    layout: defaultLayout(floors, lines),
    faqs: defaultFaqs(),
    quietStart: 22,
    quietEnd: 6,
    allowManualJoin: false,
    unitCodes: {},
    createdAt: Date.now(),
  };
  const b = { config, ...runtime() };
  ensureUnitCodes(b);
  buildings.set(slug, b);
  saveBuildings();
  return b;
}

function loadBuildings() {
  try {
    for (const config of JSON.parse(fs.readFileSync(BUILDINGS_FILE, 'utf8'))) {
      const b = { config, ...runtime() };
      ensureUnitCodes(b);
      buildings.set(config.slug, b);
    }
    if (buildings.size) saveBuildings();
  } catch {
    // 파일이 없으면 아래에서 데모 건물을 만든다
  }
  if (!buildings.has('demo')) createBuilding('행복마을 101동', 'demo', 10, 4);
}

const unitLabels = (b) => b.config.layout.cells.filter(Boolean);

// ---- 세대별 등록 코드 (세대 QR) ----
// 헷갈리는 글자(0/O, 1/I/L)는 뺀다
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode(b) {
  const used = new Set(Object.values(b.config.unitCodes || {}));
  let code;
  do code = Array.from(crypto.randomBytes(8), (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
  while (used.has(code));
  return code;
}
// 배치에 있는 세대마다 코드가 있도록 맞추고, 없어진 세대의 코드는 지운다
function ensureUnitCodes(b) {
  const codes = (b.config.unitCodes ||= {});
  const labels = new Set(unitLabels(b));
  for (const u of Object.keys(codes)) if (!labels.has(u)) delete codes[u];
  for (const u of labels) codes[u] ||= newCode(b);
  b.config.allowManualJoin ??= false;
}
const unitByCode = (b, code) => {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c ? Object.keys(b.config.unitCodes).find((u) => safeEqual(b.config.unitCodes[u], c)) : null;
};
const usersOf = (b, unit) => [...b.users.values()].filter((u) => u.unit === unit);
const activeUnits = (b) => [...new Set([...b.users.values()].map((u) => u.unit))];
const userById = (b, id) => [...b.users.values()].find((u) => u.id === id);
const isBlocked = (b, user) => b.blocked.has(user.deviceId);

// 배치도에서 위·아래·양옆 세대 찾기
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

// ---- 실시간 전달 (사용자: 이벤트 큐 롱폴링, 관리자: 버전 롱폴링) ----
let seqCounter = 0;

function queueOf(b, token) {
  if (!b.queues.has(token)) b.queues.set(token, { events: [], waiters: new Set() });
  return b.queues.get(token);
}

function send(b, token, event, data) {
  if (!b.users.has(token)) return;
  const q = queueOf(b, token);
  q.events.push({ seq: ++seqCounter, event, data });
  if (q.events.length > 50) q.events.shift();
  for (const wake of q.waiters) wake();
}

function broadcast(b, event, makeData) {
  for (const token of b.users.keys()) {
    send(b, token, event, typeof makeData === 'function' ? makeData(token) : makeData);
  }
}

function touchAdmin(b) {
  b.adminVersion++;
  for (const wake of b.adminWaiters) wake();
}

// 앱이 닫혀 있어도 폰에 알림이 가도록 웹 푸시 발송
function pushTo(b, token, message) {
  const user = b.users.get(token);
  if (!user?.push) return;
  const payload = { ...message, data: { ...message.data, url: `/b/${b.config.slug}/`, slug: b.config.slug } };
  webpush
    .sendNotification(user.push, JSON.stringify(payload), { TTL: 600, urgency: 'high' })
    .catch((err) => {
      // 404/410: 사용자가 알림을 끄거나 앱을 지워서 구독이 만료됨
      if (err.statusCode === 404 || err.statusCode === 410) user.push = null;
      else console.warn('푸시 발송 실패', err.statusCode, err.body || err.message);
    });
}

// ---- 화면에 보낼 형태로 변환 ----
function noisePhrase(a) {
  return NOISE_TYPES[a.type].phrase;
}

function noiseLabel(a) {
  return a.type === 'etc' ? '기타 메시지' : NOISE_TYPES[a.type].label;
}

// 기타 메시지는 문장 대신 (다듬어진) 본문을 따로 보여준다
function alertSentence(a) {
  const where = a.around ? '근처 세대에서' : '이웃 세대에서';
  const night = a.night ? ' 늦은 시간이라 더 크게 울린대요.' : '';
  if (a.type === 'etc') return `${where} 소음 때문에 메시지를 보냈어요.${night}`;
  const ask = a.around ? '혹시 우리 집 소리인지 한 번 확인해 주실 수 있을까요?' : '조금만 신경 써 주실 수 있을까요?';
  return `${where} ${noisePhrase(a)} 들린다고 해요.${night} ${ask}`;
}

// 답장 문장: 고른 답장 또는 직접 쓴 답장(필터를 거친 문장)
const replyTextOf = (a) => (a.reply === 'custom' ? a.replyCustom : a.reply ? REPLIES[a.reply] : null);

// 앱 미가입 세대로 보낸 민원 (관리사무소가 대신 연락)
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

// 필터 기록 (관리사무소 화면용, 원문 포함)
function logFilter(b, entry) {
  const item = { id: crypto.randomUUID(), at: Date.now(), ...entry };
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
    message: a.text || null, // 기타 메시지: 필터를 거친 문장만 (원문은 보내지 않음)
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
    // 공지를 올린 세대는 공개한다 (양해를 구하는 쪽이 스스로 밝히는 것)
    unit: n.byAdmin ? null : n.fromUnit,
    mine: Boolean(user && n.fromToken === user.token),
    thanks: n.thanks.size,
    thanked: Boolean(user && n.thanks.has(user.id)),
  };
}

function noticesFor(b, user) {
  return liveNotices(b).map((n) => noticeView(n, user));
}

function broadcastNotices(b) {
  broadcast(b, 'notices', (t) => noticesFor(b, b.users.get(t)));
}

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
    vapidPublicKey: VAPID.publicKey,
    publicUrl: process.env.PUBLIC_URL || null,
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

// 최근 REPEAT_DAYS일 동안 세대별로 받은 알림 집계 (관리사무소 중재용)
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
  b.feed.unshift({ id: crypto.randomUUID(), at: Date.now(), ...item });
  if (b.feed.length > FEED_MAX) b.feed.length = FEED_MAX;
}
// 한국 시간 기준 오늘 0시
function seoulDayStart(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', timeZone: TZ }).formatToParts(now).map((x) => [x.type, Number(x.value)]));
  return now - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - (now % 1000);
}
function boardSnapshot(b) {
  const day = seoulDayStart();
  const alerts = [...b.alerts.values()];
  const today = alerts.filter((a) => a.createdAt >= day);
  const relays = [...b.relays.values()];
  // 보낸 세대 → 받은 세대 묶음 (앱 미가입 세대로 간 관리사무소 경유도 포함)
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
  const reportCount = (deviceId) =>
    [...b.reports.values()].filter((r) => r.senderDevice === deviceId && r.status !== 'dismissed').length;
  return {
    config: { slug: c.slug, name: c.name, layout: c.layout, faqs: c.faqs, quietStart: c.quietStart, quietEnd: c.quietEnd, allowManualJoin: c.allowManualJoin },
    // 관리자 키로 인증된 화면에만 보낸다: 세대 등록 코드, 필터 원문
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
      pushOn: Boolean(u.push),
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
        senderDevice: undefined, // 기기 식별값은 관리자 화면에도 보내지 않는다
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
  const added = messages.map((m) => ({ id: crypto.randomUUID(), at, ...m }));
  chat.messages.push(...added);
  if (chat.messages.length > 200) chat.messages.splice(0, chat.messages.length - 200);
  send(b, user.token, 'chat', added);
  touchAdmin(b);
  return added;
}

function removeUser(b, token) {
  const user = b.users.get(token);
  if (!user) return;
  b.users.delete(token);
  const q = b.queues.get(token);
  b.queues.delete(token);
  for (const wake of q?.waiters || []) wake(); // 대기 중인 요청에 로그아웃을 알림
}

// ---- HTTP 유틸 ----
function json(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100_000) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
  });
}

const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
// 긴 글: 줄바꿈은 살리고 앞뒤 공백·과한 빈 줄만 정리
const cleanMessage = (v, max) =>
  typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '';
const pick = (f) => ({ severity: f.severity, blocked: f.blocked, reason: f.reason, source: f.source, fallback: Boolean(f.fallback) });

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// 양해 공지 시간 검사 (주민·관리사무소 공통)
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

// ---- 건물 등록 ----
async function handleCreateBuilding(req, res) {
  const body = await readBody(req);
  const name = cleanText(body.name, 30);
  if (!name) return json(res, 400, { error: '건물 이름을 입력해 주세요.' });
  const floors = Number(body.floors) || 10;
  const lines = Number(body.lines) || 4;
  if (!Number.isInteger(floors) || floors < 1 || floors > 50 || !Number.isInteger(lines) || lines < 1 || lines > 10) {
    return json(res, 400, { error: '층수는 1~50, 라인 수는 1~10으로 정해 주세요.' });
  }
  let slug = cleanText(body.slug, 30).toLowerCase();
  if (slug && !/^[a-z0-9-]{2,30}$/.test(slug)) {
    return json(res, 400, { error: '주소는 영문 소문자, 숫자, -만 2~30자로 써 주세요.' });
  }
  if (slug && buildings.has(slug)) return json(res, 409, { error: '이미 쓰고 있는 주소예요.' });
  if (!slug) do slug = `apt-${crypto.randomBytes(3).toString('hex')}`; while (buildings.has(slug));
  const b = createBuilding(name, slug, floors, lines);
  return json(res, 200, { slug, name, adminKey: b.config.adminKey });
}

// ---- 주민 API ----
async function handleUserApi(req, res, b, rest, url) {
  if (req.method === 'GET' && rest === 'config') return json(res, 200, publicConfig(b));

  // 실시간 이벤트 (롱폴링): after 이후 이벤트가 생기면 바로, 없으면 최대 25초 기다렸다 응답
  if (req.method === 'GET' && rest === 'poll') {
    const token = url.searchParams.get('token');
    const user = b.users.get(token);
    if (!user) return json(res, 200, { invalid: true });
    if (!url.searchParams.has('after')) {
      queueOf(b, token);
      return json(res, 200, { seq: seqCounter, events: [{ event: 'hello', data: helloFor(b, user) }] });
    }
    const after = Number(url.searchParams.get('after')) || 0;
    if (after > seqCounter) return json(res, 200, { seq: 0, events: [], resync: true }); // 서버 재시작
    const q = queueOf(b, token);
    let timer; // respond가 바로 호출될 수도 있으므로 먼저 선언
    const respond = () => {
      clearTimeout(timer);
      q.waiters.delete(respond);
      if (!b.users.has(token)) return json(res, 200, { invalid: true });
      const events = q.events.filter((e) => e.seq > after);
      json(res, 200, { seq: events.length ? events.at(-1).seq : after, events });
    };
    if (q.events.some((e) => e.seq > after)) return respond();
    timer = setTimeout(respond, POLL_TIMEOUT_MS);
    q.waiters.add(respond);
    req.on('close', () => {
      clearTimeout(timer);
      q.waiters.delete(respond);
    });
    return;
  }

  // 세대 QR 코드 → 호수 확인 (등록 전 "703호로 등록할게요" 안내용)
  if (req.method === 'GET' && rest === 'unit-code') {
    const unit = unitByCode(b, url.searchParams.get('code'));
    return unit ? json(res, 200, { unit }) : json(res, 404, { error: '등록 QR이 올바르지 않거나 다시 발급됐어요. 관리사무소에 문의해 주세요.' });
  }

  if (req.method !== 'POST') return json(res, 404, { error: '없는 API예요.' });
  const body = await readBody(req);

  // 1. 세대 등록 / 변경: 호수로 세대 식별. 한 세대에 가족 여러 명이 등록할 수 있다.
  //    세대 QR의 코드로 등록하는 게 기본이고, 호수 직접 입력은 관리사무소가 허용했을 때만 된다.
  if (rest === 'join') {
    let unit;
    if (body.code) {
      unit = unitByCode(b, body.code);
      if (!unit) return json(res, 403, { error: '등록 QR이 올바르지 않거나 다시 발급됐어요. 관리사무소에 문의해 주세요.' });
    } else {
      if (!b.config.allowManualJoin) return json(res, 403, { error: '우리 집 전용 QR을 찍어서 등록해 주세요. QR은 관리사무소에서 나눠 드려요.' });
      unit = cleanText(String(body.unit ?? ''), 10).replace(/호$/, '');
      if (!unitLabels(b).includes(unit)) return json(res, 400, { error: `${unit || '그'}호는 이 건물에 없어요.` });
    }
    const prev = b.users.get(body.token);
    const token = prev ? prev.token : crypto.randomUUID();
    const user = prev || { token, id: crypto.randomUUID().slice(0, 8), joinedAt: Date.now(), push: null };
    user.unit = unit;
    user.deviceId = cleanText(body.deviceId, 64) || user.deviceId || token;
    b.users.set(token, user);
    if (b.chats.has(user.id)) b.chats.get(user.id).unit = unit;
    broadcast(b, 'state', { active: activeUnits(b) });
    touchAdmin(b);
    return json(res, 200, { token, unit, moved: Boolean(prev), household: usersOf(b, unit).length });
  }

  const user = b.users.get(body.token);
  if (!user) return json(res, 401, { error: '먼저 세대를 등록해 주세요.' });

  if (rest === 'leave') {
    removeUser(b, user.token);
    broadcast(b, 'state', { active: activeUnits(b) });
    touchAdmin(b);
    return json(res, 200, { ok: true });
  }

  // 푸시 구독 등록 (같은 기기의 이전 구독은 덮어씀)
  if (rest === 'push/subscribe') {
    const sub = body.subscription;
    if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) {
      return json(res, 400, { error: '푸시 구독 정보가 올바르지 않아요.' });
    }
    for (const x of buildings.values()) for (const u of x.users.values()) if (u.push?.endpoint === sub.endpoint) u.push = null;
    user.push = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    touchAdmin(b);
    return json(res, 200, { ok: true });
  }

  // 2. 소음 알림 보내기
  //    target: 호수 하나 또는 'around' (어디서 나는지 모를 때 위·아래·양옆 세대에 확인 요청)
  if (rest === 'alerts') {
    if (isBlocked(b, user)) {
      return json(res, 403, { error: '신고가 누적돼 알림 보내기가 제한됐어요. 관리사무소에 문의해 주세요.' });
    }
    if (!NOISE_TYPES[body.type]) return json(res, 400, { error: '소음 종류를 골라 주세요.' });
    const raw = body.type === 'etc' ? cleanMessage(body.text, ETC_TEXT_MAX) : '';
    if (body.type === 'etc' && !raw) return json(res, 400, { error: '전할 내용을 적어 주세요.' });

    const around = body.target === 'around';
    const near = neighbors(b, user.unit);
    const dirOf = (unit) => Object.keys(near).find((k) => near[k] === unit) || null;
    let targets; // 앱을 쓰는 세대 → 바로 알림
    let relayTo = null; // 앱을 안 쓰는 세대 → 관리사무소가 대신 연락
    if (around) {
      targets = [...new Set(Object.values(near).filter(Boolean))].filter((u) => usersOf(b, u).length);
      if (!targets.length) relayTo = '주변 세대';
    } else {
      const unit = cleanText(String(body.target ?? ''), 10);
      if (unit === user.unit) return json(res, 400, { error: '우리 집에는 보낼 수 없어요.' });
      if (!unitLabels(b).includes(unit)) return json(res, 400, { error: `${unit || '그'}호는 이 건물에 없어요.` });
      targets = usersOf(b, unit).length ? [unit] : [];
      if (!targets.length) relayTo = unit;
    }

    // 5분에 1번, 1시간에 3번 (기기 기준: 다시 등록해도 유지)
    const now = Date.now();
    const times = b.sendLog.get(user.deviceId) || [];
    const limit = checkSendLimit(times, now);
    if (limit) return json(res, 429, { error: limit.error, retryAfterSec: limit.retryAfterSec });

    // 기타 메시지는 필터를 거친다 (미리 다듬어 본 결과가 있으면 그대로 쓴다)
    let text = '';
    let filter = null;
    if (body.type === 'etc') {
      const pv = b.previews.get(body.previewId);
      filter = pv && pv.token === user.token && pv.original === raw && pv.expires > now ? pv.filter : await filterMessage('neighbor', raw);
      b.previews.delete(body.previewId);
      const toLabel = relayTo ? `${relayTo === '주변 세대' ? relayTo : `${relayTo}호`} (관리사무소 경유)` : around ? `주변 ${targets.length}세대` : `${targets[0]}호`;
      logFilter(b, { kind: 'neighbor', fromUnit: user.unit, toUnit: toLabel, original: raw, delivered: filter.text, ...pick(filter) });
      touchAdmin(b);
      if (filter.blocked) return json(res, 422, { error: BLOCKED_MSG, blocked: true });
      text = filter.text;
    }
    b.sendLog.set(user.deviceId, [...times.filter((t) => now - t < 3_600_000), now]);
    const night = isQuietTime(b, now);

    // 앱 미가입 세대: 관리사무소에 전달하고, 연락하면 보낸 세대에 다시 알려준다
    if (relayTo) {
      const relay = {
        id: crypto.randomUUID(),
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
      return json(res, 200, { alerts: [], relay: relayView(relay), message: `${who}. 관리사무소에 전달했고, 관리사무소가 연락하면 알려 드릴게요.` });
    }

    const groupId = crypto.randomUUID();
    const sent = [];
    for (const toUnit of targets) {
      const alert = {
        id: crypto.randomUUID(),
        groupId,
        fromToken: user.token,
        fromId: user.id,
        fromDevice: user.deviceId,
        fromUnit: user.unit,
        toUnit,
        dir: dirOf(toUnit),
        type: body.type,
        text,
        original: raw || null, // 관리사무소만 볼 수 있음
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
      // 같은 세대의 가족 모두에게 전달
      for (const member of usersOf(b, toUnit)) {
        send(b, member.token, 'alert', alertView(alert, member));
        pushTo(b, member.token, {
          title: `${NOISE_TYPES[alert.type].emoji} ${around ? '혹시 우리 집 소리일까요?' : '똑똑, 이웃이에요'}`,
          body: alert.text ? `${alertSentence(alert)}\n“${alert.text}”` : alertSentence(alert),
          tag: alert.id,
          requireInteraction: true,
          data: { id: alert.id, token: member.token, kind: 'alert' },
          actions: [
            { action: 'sorry', title: '죄송해요, 조심할게요' },
            { action: 'notus', title: '저희 집 아니에요' },
          ],
        });
      }
    }
    touchAdmin(b);
    return json(res, 200, { alerts: sent });
  }

  // 3. 받은 세대의 답장 (가족 중 한 명이 답하면 모두에게 반영)
  let m = rest.match(/^alerts\/([\w-]+)\/reply$/);
  if (m) {
    const alert = b.alerts.get(m[1]);
    if (!alert || alert.toUnit !== user.unit || alert.fromToken === user.token) return json(res, 404, { error: '알림을 찾을 수 없어요.' });
    if (!REPLIES[body.reply] && body.reply !== 'custom') return json(res, 400, { error: '답장을 골라 주세요.' });
    if (alert.reply) return json(res, 409, { error: '이미 가족 중 한 분이 답장했어요.' });
    // 직접 쓴 답장도 필터를 거친다 (원문은 관리사무소만)
    if (body.reply === 'custom') {
      const raw = cleanMessage(body.text, REPLY_TEXT_MAX);
      if (!raw) return json(res, 400, { error: '답장 내용을 적어 주세요.' });
      const filter = await filterMessage('reply', raw);
      logFilter(b, { kind: 'reply', fromUnit: user.unit, toUnit: `${alert.fromUnit}호 (답장)`, original: raw, delivered: filter.text, ...pick(filter) });
      touchAdmin(b);
      if (filter.blocked) return json(res, 422, { error: BLOCKED_MSG, blocked: true });
      if (alert.reply) return json(res, 409, { error: '이미 가족 중 한 분이 답장했어요.' }); // 필터를 기다리는 사이 다른 가족이 답했을 때
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
    pushTo(b, alert.fromToken, {
      title: `${alert.toUnit}호에서 답장이 왔어요`,
      body: replyTextOf(alert),
      tag: `reply-${alert.id}`,
      data: { id: alert.id, kind: 'reply' },
    });
    touchAdmin(b);
    return json(res, 200, alertView(alert, user));
  }

  // 4. 스팸 신고: 받은 세대가 부당한 알림을 신고
  m = rest.match(/^alerts\/([\w-]+)\/report$/);
  if (m) {
    const alert = b.alerts.get(m[1]);
    if (!alert || alert.toUnit !== user.unit || alert.fromToken === user.token) return json(res, 404, { error: '알림을 찾을 수 없어요.' });
    if (!REPORT_REASONS[body.reason]) return json(res, 400, { error: '신고 이유를 골라 주세요.' });
    if (alert.reportId) return json(res, 409, { error: '이미 신고했어요.' });
    const report = {
      id: crypto.randomUUID(),
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
    feed(b, { kind: 'report', icon: '🚩', from: user.unit, to: alert.fromUnit, text: `부당한 알림 신고` });
    // 서로 다른 세대의 신고가 기준을 넘으면 자동 제한
    const reporters = new Set(
      [...b.reports.values()].filter((r) => r.senderDevice === alert.fromDevice && r.status !== 'dismissed').map((r) => r.reporterUnit),
    );
    if (reporters.size >= AUTO_BLOCK_REPORTS && !b.blocked.has(alert.fromDevice)) {
      setBlocked(b, alert.fromDevice, true, { unit: alert.fromUnit, reason: `${reporters.size}세대 신고 누적 (자동)` });
    }
    for (const member of usersOf(b, alert.toUnit)) if (member.token !== user.token) send(b, member.token, 'reply', alertView(alert, member));
    touchAdmin(b);
    return json(res, 200, alertView(alert, user));
  }

  // 기타 메시지 미리 다듬어 보기: 보내기 전에 실제로 전달될 문장을 보여준다
  if (rest === 'filter/preview') {
    const raw = cleanMessage(body.text, ETC_TEXT_MAX);
    if (!raw) return json(res, 400, { error: '전할 내용을 적어 주세요.' });
    const now = Date.now();
    const hits = (b.previewHits.get(user.token) || []).filter((t) => now - t < 60_000);
    if (hits.length >= PREVIEW_PER_MIN) return json(res, 429, { error: '잠시 후 다시 다듬어 주세요.' });
    b.previewHits.set(user.token, [...hits, now]);
    for (const [id, pv] of b.previews) if (pv.expires <= now) b.previews.delete(id);
    const filter = await filterMessage('neighbor', raw);
    const previewId = crypto.randomUUID();
    b.previews.set(previewId, { token: user.token, original: raw, filter, expires: now + PREVIEW_TTL_MS });
    return json(res, 200, { previewId, text: filter.text, changed: filter.text !== raw, blocked: filter.blocked, blockedMessage: filter.blocked ? BLOCKED_MSG : null });
  }

  // 5. 미리 양해 구하기: 공사·이사·손님 방문 등을 이웃에게 미리 알림
  if (rest === 'notices') {
    if (!NOTICE_TYPES[body.type]) return json(res, 400, { error: '어떤 일인지 골라 주세요.' });
    const t = parseNoticeTime(body);
    if (t.error) return json(res, 400, { error: t.error });
    const mine = liveNotices(b).filter((n) => n.fromToken === user.token);
    if (mine.length >= 3) return json(res, 429, { error: '진행 중인 공지는 3개까지 올릴 수 있어요.' });
    const raw = cleanText(body.text, NOTICE_TEXT_MAX);
    let noticeText = '';
    if (raw) {
      const filter = await filterMessage('notice', raw);
      logFilter(b, { kind: 'notice', fromUnit: user.unit, toUnit: '이웃 전체', original: raw, delivered: filter.text, ...pick(filter) });
      touchAdmin(b);
      if (filter.blocked) return json(res, 422, { error: BLOCKED_MSG, blocked: true });
      noticeText = filter.text.slice(0, NOTICE_TEXT_MAX * 2);
    }
    const notice = {
      id: crypto.randomUUID(),
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
    feed(b, { kind: 'notice', icon: NOTICE_TYPES[notice.type].emoji, from: notice.byAdmin ? '관리사무소' : notice.fromUnit, to: '이웃', text: `양해 공지 · ${NOTICE_TYPES[notice.type].label}${notice.text ? ` · ${notice.text}` : ''}` });
    broadcastNotices(b);
    // 위·아래·양옆 세대에는 푸시로도 알린다 (나머지 세대는 앱에서 확인)
    const near = new Set(Object.values(neighbors(b, user.unit)).filter(Boolean));
    for (const u of b.users.values()) {
      if (near.has(u.unit)) {
        pushTo(b, u.token, {
          title: `${NOTICE_TYPES[notice.type].emoji} ${user.unit}호가 미리 양해를 구해요`,
          body: `${NOTICE_TYPES[notice.type].label}${notice.text ? ` · ${notice.text}` : ''}`,
          tag: `notice-${notice.id}`,
          data: { kind: 'notice' },
        });
      }
    }
    touchAdmin(b);
    return json(res, 200, noticeView(notice, user));
  }

  m = rest.match(/^notices\/([\w-]+)\/(thanks|delete)$/);
  if (m) {
    const notice = liveNotices(b).find((n) => n.id === m[1]);
    if (!notice) return json(res, 404, { error: '이미 끝난 공지예요.' });
    if (m[2] === 'delete') {
      if (notice.fromToken !== user.token) return json(res, 403, { error: '내가 올린 공지만 내릴 수 있어요.' });
      b.notices.delete(notice.id);
    } else {
      if (notice.fromToken === user.token) return json(res, 400, { error: '내 공지에는 누를 수 없어요.' });
      notice.thanks.add(user.id);
    }
    broadcastNotices(b);
    touchAdmin(b);
    return json(res, 200, { notices: noticesFor(b, user) });
  }

  // 화풀기 기록: 가상으로 던진 토마토·계란, 토계볶 완성 (실제로는 아무에게도 전달되지 않는다)
  if (rest === 'vent') {
    const now = Date.now();
    if (now - (b.vent.lastAt[user.token] || 0) < 800) return json(res, 429, { error: '잠시 후 다시 보내 주세요.' });
    b.vent.lastAt[user.token] = now;
    const n = (v) => Math.max(0, Math.min(30, Math.floor(Number(v) || 0)));
    const tomato = n(body.tomato), egg = n(body.egg), wok = Math.min(3, n(body.wok));
    if (!tomato && !egg && !wok) return json(res, 400, { error: '기록할 내용이 없어요.' });
    const target = neighbors(b, user.unit).up || '윗집';
    b.vent.tomato += tomato; b.vent.egg += egg; b.vent.wok += wok;
    const bt = (b.vent.byTarget[target] ||= { tomato: 0, egg: 0 }); bt.tomato += tomato; bt.egg += egg;
    const bw = (b.vent.byThrower[user.unit] ||= { tomato: 0, egg: 0 }); bw.tomato += tomato; bw.egg += egg;
    if (tomato || egg) feed(b, { kind: 'vent', icon: '🔥', from: user.unit, to: target, text: `화풀기 ${tomato ? `🍅${tomato}` : ''}${egg ? ` 🥚${egg}` : ''}`.trim() });
    if (wok) feed(b, { kind: 'wok', icon: '🍳', from: user.unit, to: target, text: '토계볶 완성!' });
    touchAdmin(b);
    return json(res, 200, { ok: true });
  }

  // 6. 1:1 문의: FAQ 카드는 챗봇이 바로 답하고, 직접 쓴 문의는 관리사무소에 전달
  if (rest === 'chat') {
    if (body.faqId) {
      const faq = b.config.faqs.find((f) => f.id === body.faqId);
      if (!faq) return json(res, 404, { error: '없는 질문이에요.' });
      return json(res, 200, { messages: addChatMessages(b, user, [{ from: 'user', text: faq.q }, { from: 'bot', text: faq.a }]) });
    }
    const text = cleanMessage(body.text, OFFICE_MSG_MAX);
    if (!text) return json(res, 400, { error: '메시지를 입력해 주세요.' });
    // 화난 민원도 관리사무소에는 다듬어진 문장으로 보이고, 원문은 관리사무소가 따로 열어 볼 수 있다
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
    return json(res, 200, { messages: addChatMessages(b, user, msgs) });
  }

  return json(res, 404, { error: '없는 API예요.' });
}

function setBlocked(b, deviceId, blocked, info = {}) {
  if (blocked) b.blocked.set(deviceId, { unit: info.unit ?? null, reason: info.reason || '관리사무소 제한', at: Date.now() });
  else b.blocked.delete(deviceId);
  for (const u of b.users.values()) if (u.deviceId === deviceId) send(b, u.token, 'blocked', { blocked });
}

// ---- 관리사무소 API (헤더 x-admin-key) ----
async function handleAdminApi(req, res, b, rest, url) {
  if (!safeEqual(req.headers['x-admin-key'] || '', b.config.adminKey)) {
    return json(res, 401, { error: '관리자 키가 올바르지 않아요.' });
  }

  // 관리자 화면 실시간 갱신: 버전이 바뀌면 전체 스냅샷을 돌려준다
  if (req.method === 'GET' && rest === 'poll') {
    const after = Number(url.searchParams.get('after')) || 0;
    let timer; // respond가 바로 호출될 수도 있으므로 먼저 선언
    const respond = () => {
      clearTimeout(timer);
      b.adminWaiters.delete(respond);
      json(res, 200, { version: b.adminVersion, snapshot: adminSnapshot(b) });
    };
    if (after !== b.adminVersion) return respond();
    timer = setTimeout(respond, POLL_TIMEOUT_MS);
    b.adminWaiters.add(respond);
    req.on('close', () => {
      clearTimeout(timer);
      b.adminWaiters.delete(respond);
    });
    return;
  }

  if (req.method !== 'POST') return json(res, 404, { error: '없는 API예요.' });
  const body = await readBody(req);

  // 세대 배치 변경: 없어진 호수로 등록한 주민은 다시 등록해야 한다
  if (rest === 'layout') {
    const rows = Number(body.rows);
    const cols = Number(body.cols);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 50 || cols > 10) {
      return json(res, 400, { error: '층은 1~50, 라인은 1~10 사이로 정해 주세요.' });
    }
    if (!Array.isArray(body.cells) || body.cells.length !== rows * cols) {
      return json(res, 400, { error: '배치도 데이터가 올바르지 않아요.' });
    }
    const cells = body.cells.map((c) => cleanText(String(c ?? ''), 6) || null);
    const labels = cells.filter(Boolean);
    if (!labels.length) return json(res, 400, { error: '세대가 하나 이상 있어야 해요.' });
    const dup = labels.find((l, i) => labels.indexOf(l) !== i);
    if (dup) return json(res, 400, { error: `${dup}호가 두 번 있어요.` });
    b.config.layout = { rows, cols, cells };
    ensureUnitCodes(b);
    saveBuildings();
    const kicked = [];
    for (const u of [...b.users.values()]) {
      if (!labels.includes(u.unit)) {
        kicked.push(u.unit);
        removeUser(b, u.token);
      }
    }
    broadcast(b, 'layout', { layout: b.config.layout, active: activeUnits(b) });
    touchAdmin(b);
    return json(res, 200, { ok: true, kicked: [...new Set(kicked)] });
  }

  if (rest === 'faqs') {
    if (!Array.isArray(body.faqs)) return json(res, 400, { error: 'FAQ 형식이 올바르지 않아요.' });
    const faqs = body.faqs
      .map((f) => ({ id: typeof f.id === 'string' && f.id ? f.id : crypto.randomUUID(), q: cleanText(f.q, 80), a: String(f.a ?? '').trim().slice(0, 500) }))
      .filter((f) => f.q && f.a)
      .slice(0, 30);
    b.config.faqs = faqs;
    saveBuildings();
    broadcast(b, 'config', { faqs, name: b.config.name, quietStart: b.config.quietStart, quietEnd: b.config.quietEnd, quietNow: isQuietTime(b) });
    touchAdmin(b);
    return json(res, 200, { ok: true, faqs });
  }

  if (rest === 'settings') {
    const name = cleanText(body.name, 30);
    if (body.name !== undefined && !name) return json(res, 400, { error: '건물 이름을 입력해 주세요.' });
    const quiet = { quietStart: b.config.quietStart, quietEnd: b.config.quietEnd };
    for (const k of Object.keys(quiet)) {
      if (body[k] === undefined) continue;
      const h = Number(body[k]);
      if (!Number.isInteger(h) || h < 0 || h > 23) return json(res, 400, { error: '조용한 시간은 0~23시로 정해 주세요.' });
      quiet[k] = h;
    }
    if (quiet.quietStart === quiet.quietEnd) return json(res, 400, { error: '시작과 끝 시간이 같으면 안 돼요.' });
    if (name) b.config.name = name;
    Object.assign(b.config, quiet);
    if (body.allowManualJoin !== undefined) b.config.allowManualJoin = Boolean(body.allowManualJoin);
    saveBuildings();
    broadcast(b, 'config', { faqs: b.config.faqs, name: b.config.name, quietStart: b.config.quietStart, quietEnd: b.config.quietEnd, quietNow: isQuietTime(b), allowManualJoin: b.config.allowManualJoin });
    touchAdmin(b);
    return json(res, 200, { ok: true });
  }

  // 앱 미가입 세대로 온 민원: 관리사무소가 연락했으면 보낸 세대에 다시 알린다
  let mr = rest.match(/^relays\/([\w-]+)$/);
  if (mr) {
    const relay = b.relays.get(mr[1]);
    if (!relay) return json(res, 404, { error: '요청을 찾을 수 없어요.' });
    if (!['contacted', 'closed'].includes(body.action)) return json(res, 400, { error: '처리 방법을 골라 주세요.' });
    relay.status = body.action;
    relay.note = cleanText(body.note, 100);
    relay.handledAt = Date.now();
    feed(b, { kind: 'relay-done', icon: '🏢', from: '관리사무소', to: relay.around ? '주변' : relay.toUnit, text: relay.status === 'contacted' ? `대신 연락했어요${relay.note ? ` · ${relay.note}` : ''}` : '처리 끝' });
    const reporter = b.users.get(relay.fromToken);
    if (reporter) {
      send(b, reporter.token, 'relay', relayView(relay));
      const where = relay.around ? '주변 세대' : `${relay.toUnit}호`;
      pushTo(b, reporter.token, {
        title: relay.status === 'contacted' ? `🏢 관리사무소가 ${where}에 연락했어요` : '🏢 관리사무소가 민원 처리를 마쳤어요',
        body: relay.note || `${noiseLabel(relay)} 민원을 관리사무소가 대신 전달했어요.`,
        tag: `relay-${relay.id}`,
        data: { kind: 'relay' },
      });
    }
    touchAdmin(b);
    return json(res, 200, { ok: true, notified: Boolean(reporter) });
  }

  // 세대 QR 다시 발급 (이사, QR 분실): 예전 QR은 못 쓰고, 그 세대로 등록된 주민은 다시 등록해야 한다
  let mc = rest.match(/^codes\/([^/]+)\/reissue$/);
  if (mc) {
    const unit = decodeURIComponent(mc[1]);
    if (!unitLabels(b).includes(unit)) return json(res, 404, { error: `${unit}호는 이 건물에 없어요.` });
    b.config.unitCodes[unit] = newCode(b);
    saveBuildings();
    const kicked = usersOf(b, unit);
    for (const u of kicked) removeUser(b, u.token);
    if (kicked.length) broadcast(b, 'state', { active: activeUnits(b) });
    touchAdmin(b);
    return json(res, 200, { ok: true, kicked: kicked.length });
  }

  // 관리사무소 공지 (모든 주민에게 푸시)
  if (rest === 'notices') {
    if (!NOTICE_TYPES[body.type]) return json(res, 400, { error: '공지 종류를 골라 주세요.' });
    const t = parseNoticeTime(body);
    if (t.error) return json(res, 400, { error: t.error });
    const text = cleanText(body.text, NOTICE_TEXT_MAX);
    if (!text) return json(res, 400, { error: '공지 내용을 입력해 주세요.' });
    const notice = { id: crypto.randomUUID(), fromToken: null, fromUnit: null, byAdmin: true, type: body.type, text, startAt: t.startAt, endAt: t.endAt, thanks: new Set(), createdAt: Date.now() };
    b.notices.set(notice.id, notice);
    feed(b, { kind: 'notice', icon: NOTICE_TYPES[notice.type].emoji, from: notice.byAdmin ? '관리사무소' : notice.fromUnit, to: '이웃', text: `양해 공지 · ${NOTICE_TYPES[notice.type].label}${notice.text ? ` · ${notice.text}` : ''}` });
    broadcastNotices(b);
    for (const u of b.users.values()) {
      pushTo(b, u.token, { title: `🏢 관리사무소 공지`, body: `${NOTICE_TYPES[notice.type].label} · ${text}`, tag: `notice-${notice.id}`, data: { kind: 'notice' } });
    }
    touchAdmin(b);
    return json(res, 200, { ok: true });
  }

  let m = rest.match(/^notices\/([\w-]+)\/delete$/);
  if (m) {
    if (!b.notices.delete(m[1])) return json(res, 404, { error: '공지를 찾을 수 없어요.' });
    broadcastNotices(b);
    touchAdmin(b);
    return json(res, 200, { ok: true });
  }

  m = rest.match(/^reports\/([\w-]+)$/);
  if (m) {
    const report = b.reports.get(m[1]);
    if (!report) return json(res, 404, { error: '신고를 찾을 수 없어요.' });
    if (body.action === 'block') {
      report.status = 'blocked';
      setBlocked(b, report.senderDevice, true, { unit: report.senderUnit, reason: '관리사무소 제한' });
    } else if (body.action === 'dismiss') {
      report.status = 'dismissed';
    } else return json(res, 400, { error: '처리 방법을 골라 주세요.' });
    touchAdmin(b);
    return json(res, 200, { ok: true });
  }

  if (rest === 'unblock') {
    if (!b.blocked.has(body.deviceId)) return json(res, 404, { error: '제한 목록에 없어요.' });
    setBlocked(b, body.deviceId, false);
    for (const r of b.reports.values()) if (r.senderDevice === body.deviceId && r.status === 'open') r.status = 'dismissed';
    touchAdmin(b);
    return json(res, 200, { ok: true });
  }

  m = rest.match(/^chats\/([\w-]+)(\/read)?$/);
  if (m) {
    const chat = b.chats.get(m[1]);
    if (!chat) return json(res, 404, { error: '대화를 찾을 수 없어요.' });
    if (m[2]) {
      chat.unread = 0;
      touchAdmin(b);
      return json(res, 200, { ok: true });
    }
    const user = userById(b, m[1]);
    if (!user) return json(res, 410, { error: '등록을 해제한 주민이에요.' });
    const text = cleanText(body.text, CHAT_MAX);
    if (!text) return json(res, 400, { error: '메시지를 입력해 주세요.' });
    chat.unread = 0;
    addChatMessages(b, user, [{ from: 'admin', text }]);
    pushTo(b, user.token, { title: '💬 관리사무소 답변이 왔어요', body: text, tag: `chat-${user.id}`, data: { kind: 'chat' } });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: '없는 API예요.' });
}

// ---- 라우팅 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serveFile(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// 건물마다 설치 앱이 따로 생기도록 매니페스트를 동적으로 만든다
function serveManifest(res, b) {
  const slug = b.config.slug;
  res.writeHead(200, { 'Content-Type': MIME['.webmanifest'], 'Cache-Control': 'no-cache' });
  res.end(
    JSON.stringify({
      id: `/b/${slug}/`,
      name: `쉿!그널 · ${b.config.name}`,
      short_name: '쉿!그널',
      description: '층간소음을 이웃끼리 정중하게 알리는 앱',
      start_url: `/b/${slug}/`,
      scope: `/b/${slug}/`,
      display: 'standalone',
      background_color: '#f6f5f1',
      theme_color: '#1f3d36',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    }),
  );
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/api/buildings' && req.method === 'POST') return handleCreateBuilding(req, res);

  let m = p.match(/^\/api\/b\/([a-z0-9-]+)\/(.+)$/);
  if (m) {
    const b = buildings.get(m[1]);
    if (!b) return json(res, 404, { error: '없는 건물이에요. 주소를 확인해 주세요.' });
    if (m[2].startsWith('admin/')) return handleAdminApi(req, res, b, m[2].slice(6), url);
    return handleUserApi(req, res, b, m[2], url);
  }
  if (p.startsWith('/api/')) return json(res, 404, { error: '없는 API예요.' });

  if (p === '/') return serveFile(res, 'home.html');
  m = p.match(/^\/b\/([a-z0-9-]+)(\/.*)?$/);
  if (m) {
    const sub = m[2] || '';
    if (sub === '') {
      res.writeHead(302, { Location: `/b/${m[1]}/${url.search}` });
      return res.end();
    }
    const b = buildings.get(m[1]);
    if (sub === '/manifest.webmanifest') return b ? serveManifest(res, b) : json(res, 404, { error: 'not found' });
    if (sub === '/') return serveFile(res, 'index.html');
    if (sub === '/admin') return serveFile(res, 'admin.html');
    return json(res, 404, { error: 'not found' });
  }
  return serveFile(res, decodeURIComponent(p));
}

loadBuildings();

http
  .createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e.message === 'bad json' || e.message === 'too large' ? 400 : 500;
      if (status === 500) console.error(e);
      json(res, status, { error: status === 400 ? '요청 형식이 올바르지 않아요.' : '서버 오류가 났어요.' });
    });
  })
  .listen(PORT, () => {
    console.log(`쉿!그널(아파트) 서버 실행 중: http://localhost:${PORT}`);
    for (const b of buildings.values()) {
      console.log(`- ${b.config.name}: http://localhost:${PORT}/b/${b.config.slug}/  (관리사무소: /b/${b.config.slug}/admin)`);
    }
    console.log('관리자 키는 data/buildings.json 에 있어요.');
  });
