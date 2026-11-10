// 쉿!그널 정적 데모 API 흐름 테스트: mock-server.js(브라우저 안 서버)를 Node에서 불러와 원래 서버 테스트와 같은 흐름을 검사한다
// 실행: npm test
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
// 흐름 테스트에서는 보내기 제한을 풀고, 제한 규칙은 아래에서 checkSendLimit로 따로 검사한다
globalThis.SHH_DEMO_OPTIONS = { sendGapSec: 0, sendPerHour: 1000, pollTimeoutMs: 300 };
const { checkSendLimit, resetDemo } = await import('../mock-server.js');

let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails++;
};
async function req(path, body, headers = {}) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const A = 'api/b/demo';
const K = { 'x-admin-key': 'demo' };
const events = async (u, name) => (await req(`${A}/poll?token=${u.token}&after=0`)).data.events.filter((e) => e.event === name);

// 기본 건물: 10층 × 4라인, 관리자 키는 데모용 고정값
ok((await req(`${A}/admin/poll?after=0`, null, { 'x-admin-key': 'wrong' })).status === 401, '잘못된 관리자 키 거부');
ok((await req('api/b/nope/config')).status === 404, '없는 건물 404');
const cfg = (await req(`${A}/config`)).data;
ok(cfg.layout.cells[0] === '1001' && cfg.layout.cells.at(-1) === '104', `기본 호수 배치: ${cfg.layout.cells[0]} … ${cfg.layout.cells.at(-1)}`);
ok(cfg.demo && cfg.allowManualJoin && cfg.vapidPublicKey === null, '데모 설정: 호수 직접 입력 허용, 웹 푸시 없음');
ok(mem.has('shhgnal-demo-v1'), '상태가 localStorage에 저장됨');

// 세대 QR 등록
ok((await req(`${A}/admin/settings`, { allowManualJoin: false }, K)).status === 200, 'QR 전용 모드로 바꾸기');
ok((await req(`${A}/join`, { unit: '302' })).status === 403, 'QR 전용 모드에서 호수 직접 입력 막힘');
let snap0 = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
ok(Object.keys(snap0.unitCodes).length === 40, '세대 40개 모두 등록 코드 발급');
const code503 = snap0.unitCodes['503'];
ok((await req(`${A}/unit-code?code=${code503}`)).data.unit === '503', '코드 → 호수 확인');
ok((await req(`${A}/join`, { code: 'WRONGCODE' })).status === 403, '틀린 코드 거부');
const q1 = (await req(`${A}/join`, { code: code503.toLowerCase(), unit: '101', deviceId: 'q1' })).data;
ok(q1.unit === '503', '코드로 등록하면 입력한 호수와 상관없이 코드의 세대로 등록');
ok((await req(`${A}/admin/codes/503/reissue`, {}, K)).data.kicked === 1, '코드 재발급 → 그 세대 주민 등록 해제');
ok((await req(`${A}/poll?token=${q1.token}`)).data.invalid, '재발급 후 예전 등록 만료');
ok((await req(`${A}/join`, { code: code503 })).status === 403, '예전 코드는 못 씀');
ok((await req(`${A}/admin/settings`, { allowManualJoin: true }, K)).status === 200, '시연용 직접 입력 다시 허용');

// 세대 등록: 302호 기준 윗집 402, 아랫집 202, 옆집 301·303
const me = (await req(`${A}/join`, { unit: '302호', deviceId: 'd-me' })).data;
ok(me.unit === '302', '"호"를 붙여 입력해도 등록');
const up = (await req(`${A}/join`, { unit: '402', deviceId: 'd-up' })).data;
const up2 = (await req(`${A}/join`, { unit: '402', deviceId: 'd-up2' })).data;
ok(up2.household === 2, '한 세대에 가족 2명 등록');
const down = (await req(`${A}/join`, { unit: '202', deviceId: 'd-down' })).data;
const side = (await req(`${A}/join`, { unit: '301', deviceId: 'd-side' })).data;
const far = (await req(`${A}/join`, { unit: '101', deviceId: 'd-far' })).data;
ok((await req(`${A}/join`, { unit: '999' })).status === 400, '없는 호수 거부');

// 앱 미가입 세대: 관리사무소에 전달 → 연락하면 보낸 세대에 알림
const rl = await req(`${A}/alerts`, { token: me.token, target: '303', type: 'footstep' });
ok(rl.status === 200 && rl.data.relay?.toUnit === '303' && rl.data.message.includes('가입하지 않았어요'), '미가입 세대 → "가입 안 됨" 안내 + 관리사무소 전달');
let rsnap = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
const relay = rsnap.relays.find((r) => r.toUnit === '303');
ok(relay?.fromUnit === '302' && relay.status === 'open', '관리사무소: 연락 요청 확인 (보낸 세대 포함)');
ok((await req(`${A}/admin/relays/${relay.id}`, { action: 'contacted', note: '인터폰으로 전달했어요' }, K)).data.notified, '관리사무소: 연락했어요 처리');
const relayEv = (await events(me, 'relay')).at(-1)?.data;
ok(relayEv?.status === 'contacted' && relayEv.note === '인터폰으로 전달했어요' && !relayEv.fromUnit, '보낸 세대에 "관리사무소가 연락했어요" 알림');
ok((await req(`${A}/alerts`, { token: me.token, target: '302', type: 'footstep' })).status === 400, '우리 집에 보내기 거부');
const a1 = await req(`${A}/alerts`, { token: me.token, target: '402', type: 'footstep' });
ok(a1.status === 200 && a1.data.alerts[0].dir === 'up', '윗집에 알림 (방향 up)');
const got1 = (await events(up, 'alert'))[0]?.data;
const got2 = (await events(up2, 'alert'))[0]?.data;
ok(got1 && got2 && got1.id === got2.id, '같은 세대 가족 모두에게 전달');
ok(!JSON.stringify(got1).includes('302'), '받은 세대에는 보낸 호수가 안 보임');

// 롱폴링 흉내: 기다리는 동안 다른 쪽이 보내면 바로 깨어난다
const lastSeq = (await req(`${A}/poll?token=${far.token}`)).data.seq;
const waiting = req(`${A}/poll?token=${far.token}&after=${lastSeq}`);
await new Promise((r) => setTimeout(r, 50));
await req(`${A}/alerts`, { token: side.token, target: '101', type: 'music' });
const woke = await waiting;
ok(woke.data.events.some((e) => e.event === 'alert' && e.data.type === 'music'), '대기 중인 폴링이 새 알림에 바로 깨어남');
const idle = await req(`${A}/poll?token=${far.token}&after=${woke.data.seq}`);
ok(idle.status === 200 && idle.data.events.length === 0, '바뀐 게 없으면 시간이 지나 빈 응답');

// 가족 중 한 명이 답장 → 다른 가족 화면에도 반영, 두 번째 답장 거부
const rep = await req(`${A}/alerts/${got1.id}/reply`, { token: up.token, reply: 'notus' });
ok(rep.status === 200 && rep.data.replyText.includes('아니에요'), '"저희 집 아니에요" 답장');
ok((await req(`${A}/alerts/${got1.id}/reply`, { token: up2.token, reply: 'sorry' })).status === 409, '가족 중복 답장 거부');
ok((await events(up2, 'reply')).some((e) => e.data.id === got1.id && e.data.reply === 'notus'), '다른 가족에게 답장 상태 공유');
ok((await events(me, 'reply')).some((e) => e.data.reply === 'notus'), '보낸 세대에 답장 전달');

// 주변(위·아래·옆) 중 앱 쓰는 세대만
const ar = await req(`${A}/alerts`, { token: me.token, target: 'around', type: 'hammer' });
const arUnits = ar.data.alerts.map((a) => a.toUnit).sort();
ok(ar.status === 200 && arUnits.join() === '202,301,402', `주변 확인 요청: ${arUnits} (303은 미가입, 101은 주변 아님)`);
ok((await events(down, 'alert')).some((e) => e.data.around), '주변 요청은 around 표시');
ok(!(await events(far, 'alert')).some((e) => e.data.around), '주변이 아닌 세대는 받지 않음');

// 기타 메시지: 규칙 필터를 거친 문장만 전달
const long = '요즘 밤마다 쿵쿵 소리가 나서 잠을 못 자요. 미친 듯이 뛰네요';
const cut = await req(`${A}/filter/preview`, { token: up.token, text: '가'.repeat(150) });
ok(cut.data.text.length === 100, '이웃 메시지는 100자까지만');
const pv = await req(`${A}/filter/preview`, { token: up.token, text: long });
ok(pv.status === 200 && pv.data.changed && pv.data.text.includes('많이 뛰네요') && !pv.data.text.includes('미친'), `거친 표현 다듬기: "${pv.data.text}"`);
const e1 = await req(`${A}/alerts`, { token: up.token, target: '302', type: 'etc', text: long, previewId: pv.data.previewId });
ok(e1.status === 200, '미리 다듬은 결과로 보냄');
const recv = (await events(me, 'alert')).find((e) => e.data.type === 'etc')?.data;
ok(recv?.message === pv.data.text && !JSON.stringify(recv).includes('미친'), '받는 세대에는 다듬어진 문장만 (원문 없음)');
const threat = await req(`${A}/alerts`, { token: down.token, target: '302', type: 'etc', text: '한 번만 더 그러면 찾아간다' });
ok(threat.status === 422 && threat.data.blocked, '위협 메시지는 전달 차단');
const swear = await req(`${A}/alerts`, { token: side.token, target: '302', type: 'etc', text: '씨발 시끄러워요' });
const swearMsg = swear.data.alerts?.[0]?.message || '';
ok(swear.status === 200 && !swearMsg.includes('씨발') && swearMsg.includes('○○'), `욕설 가리기 (${swearMsg})`);
snap0 = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
const logs = snap0.filterLog;
ok(logs.some((f) => f.original === long && f.delivered === pv.data.text && f.source === 'rule'), '관리사무소: 원문과 전달 문장 함께 확인');
ok(logs.some((f) => f.blocked && f.original.includes('찾아간다')), '관리사무소: 차단된 메시지 원문 확인');
ok(snap0.llm.demo && !snap0.llm.enabled, '관리사무소: 데모 규칙 필터 표시');
const meHello = (await req(`${A}/poll?token=${me.token}`)).data.events[0].data;
ok(!JSON.stringify(meHello).includes('미친') && !JSON.stringify(meHello).includes('찾아간다'), '주민 화면 데이터에는 원문이 없음');

// 직접 쓴 답장도 필터를 거친다
const toReply = (await events(me, 'alert')).find((e) => e.data.type === 'etc')?.data;
const cr = await req(`${A}/alerts/${toReply.id}/reply`, { token: me.token, reply: 'custom', text: '미친 소리 하지 마세요 저희 아니에요' });
ok(cr.status === 200 && !cr.data.replyText.includes('미친'), '직접 쓴 답장 → 다듬어서 전달');
ok((await events(up, 'reply')).some((e) => e.data.id === toReply.id && e.data.replyText === cr.data.replyText), '보낸 세대는 다듬어진 답장을 받음');
snap0 = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
ok(snap0.filterLog.some((f) => f.kind === 'reply' && f.original.includes('미친')), '관리사무소: 답장 원문 확인');

// 보내기 제한 규칙 (5분에 1번, 1시간에 3번)
const T = 1_000_000_000;
ok(checkSendLimit([], T, 300, 3) === null, '처음 보내기 허용');
ok(checkSendLimit([T - 299_000], T, 300, 3)?.error.includes('5분'), '5분 안에 다시 보내기 거부');
ok(checkSendLimit([T - 301_000], T, 300, 3) === null, '5분 지나면 허용');
ok(checkSendLimit([T - 3_000_000, T - 2_000_000, T - 1_000_000], T, 300, 3)?.error.includes('1시간에 3번'), '1시간에 4번째 거부');
ok(checkSendLimit([T - 3_700_000, T - 2_000_000, T - 1_000_000], T, 300, 3) === null, '1시간 지난 기록은 빼고 셈');

// 신고 3세대 → 자동 제한
const spam = [];
for (const u of [me, up, down]) {
  const r = await req(`${A}/alerts`, { token: far.token, target: u.unit, type: 'voice' });
  spam.push({ u, id: r.data.alerts[0].id });
}
const r1 = await req(`${A}/alerts/${spam[0].id}/report`, { token: me.token, reason: 'unfair' });
ok(r1.status === 200 && r1.data.reported, '신고 접수');
ok((await req(`${A}/alerts/${spam[1].id}/report`, { token: me.token, reason: 'unfair' })).status === 404, '남의 세대 알림 신고 거부');
await req(`${A}/alerts/${spam[1].id}/report`, { token: up2.token, reason: 'repeat' });
await req(`${A}/alerts/${spam[2].id}/report`, { token: down.token, reason: 'repeat' });
ok((await req(`${A}/alerts`, { token: far.token, target: '202', type: 'voice' })).status === 403, '3세대 신고 → 알림 제한');
await req(`${A}/leave`, { token: far.token });
const far2 = (await req(`${A}/join`, { unit: '101', deviceId: 'd-far' })).data;
ok((await req(`${A}/alerts`, { token: far2.token, target: '202', type: 'voice' })).status === 403, '다시 등록해도 제한 유지');
let snap = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
ok(snap.blocked.length === 1 && snap.reports.length === 3, '관리사무소: 신고 3건, 제한 1명');
ok(!JSON.stringify(snap.reports).match(/"d-(far|me|up2?|down)"/), '신고 목록에 기기 식별값 없음');
ok((await req(`${A}/admin/unblock`, { deviceId: snap.blocked[0].deviceId }, K)).status === 200, '제한 해제');

// 반복 소음 세대 집계
await req(`${A}/alerts`, { token: side.token, target: '202', type: 'running' });
await req(`${A}/alerts`, { token: far2.token, target: '202', type: 'running' });
snap = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
const s202 = snap.unitStats.find((u) => u.unit === '202');
ok(s202?.repeat && s202.senders === 3, `202호 반복 소음 표시 (${s202?.senders}세대)`);
ok(snap.alerts[0].fromUnit, '관리사무소에는 보낸 세대가 보임');

// 미리 양해 구하기
const now = Date.now();
ok((await req(`${A}/notices`, { token: me.token, type: 'move', startAt: now + 3600e3, endAt: now })).status === 400, '끝이 시작보다 이른 공지 거부');
ok((await req(`${A}/notices`, { token: me.token, type: 'move', startAt: now, endAt: now + 20 * 3600e3 })).status === 400, '12시간 넘는 공지 거부');
ok((await req(`${A}/notices`, { token: me.token, type: 'move', startAt: now + 40 * 86400e3, endAt: now + 40 * 86400e3 + 3600e3 })).status === 400, '30일 넘는 일정 거부');
const n1 = await req(`${A}/notices`, { token: me.token, type: 'assembly', text: '소파 조립해요', startAt: now, endAt: now + 2 * 3600e3 });
ok(n1.status === 200 && n1.data.unit === '302' && n1.data.mine, '양해 공지 등록 (호수 공개)');
const seen = (await events(far2, 'notices')).at(-1)?.data;
ok(seen?.[0]?.text === '소파 조립해요' && !seen[0].mine, '다른 세대에 공지 전달');
const th = await req(`${A}/notices/${n1.data.id}/thanks`, { token: up.token });
ok(th.data.notices[0].thanks === 1 && th.data.notices[0].thanked, '👍 괜찮아요 (Set이 저장·복원돼도 유지)');
ok((await req(`${A}/notices/${n1.data.id}/delete`, { token: up.token })).status === 403, '남의 공지 내리기 거부');
ok((await req(`${A}/admin/notices`, { type: 'construction', text: '엘리베이터 점검', startAt: now, endAt: now + 3600e3 }, K)).status === 200, '관리사무소 공지');
snap = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
ok(snap.notices.length === 2 && snap.notices.some((n) => n.byAdmin), '관리사무소에서 공지 2건 확인');
ok((await req(`${A}/notices/${n1.data.id}/delete`, { token: me.token })).status === 200, '내 공지 내리기');

// 조용한 시간 설정
ok((await req(`${A}/admin/settings`, { quietStart: 21, quietEnd: 7 }, K)).status === 200, '조용한 시간 21~7시로 변경');
ok((await req(`${A}/admin/settings`, { quietStart: 7, quietEnd: 7 }, K)).status === 400, '시작=끝 거부');
ok((await req(`${A}/config`)).data.quietStart === 21, '설정이 그대로 유지됨');

// 관리사무소 문의
const f = await req(`${A}/chat`, { token: down.token, faqId: cfg.faqs[0].id });
ok(f.data.messages[1].from === 'bot', 'FAQ 카드 → 챗봇 답변');
const angry = await req(`${A}/chat`, { token: side.token, text: '윗집 미친 거 아니에요? 관리사무소는 뭐 하는 거예요' });
ok(angry.data.messages[0].filtered && !angry.data.messages[0].delivered.includes('미친'), '화난 문의 → 다듬어서 관리사무소에 전달');
const t = await req(`${A}/chat`, { token: down.token, text: '윗집이랑 이야기해도 해결이 안 돼요' });
ok(t.data.messages[1].text.includes('이웃사이센터'), '직접 문의 키워드 → 챗봇 안내');
snap = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
const chat = snap.chats.find((x) => x.unit === '202');
const angryChat = snap.chats.find((x) => x.unit === '301');
ok(angryChat?.messages[0].text.includes('미친') && angryChat.messages[0].delivered, '관리사무소: 문의 원문 열람 가능');
ok(chat?.unread === 1, '관리사무소: 새 문의 1건');
ok((await req(`${A}/admin/chats/${chat.userId}`, { text: '이번 주에 방문해서 중재해 드릴게요' }, K)).status === 200, '관리사무소 답변');
ok((await events(down, 'chat')).at(-1).data[0].from === 'admin', '주민에게 답변 전달');

// 세대 배치 변경 → 없어진 호수 주민 등록 해제
const cells = cfg.layout.cells.map((l) => (l === '101' ? null : l));
const lay = await req(`${A}/admin/layout`, { rows: 10, cols: 4, cells }, K);
ok(lay.status === 200 && lay.data.kicked.join() === '101', `배치 변경, 등록 해제: ${lay.data.kicked}`);
ok((await req(`${A}/poll?token=${far2.token}`)).data.invalid, '없어진 호수 주민 토큰 만료');
ok((await req(`${A}/admin/layout`, { rows: 1, cols: 2, cells: ['1', '1'] }, K)).status === 400, '중복 호수 거부');

// 현황판: 화풀기 기록 + 민원 흐름 + 실시간 소식
const v1 = await req(`${A}/vent`, { token: me.token, tomato: 3, egg: 2, wok: 1 });
ok(v1.status === 200, '화풀기 기록 보내기');
ok((await req(`${A}/vent`, { token: me.token, tomato: 1 })).status === 429, '화풀기 기록 너무 자주 보내면 거부');
ok((await req(`${A}/vent`, { token: up.token, tomato: 999 })).status === 200, '화풀기 기록 (개수 상한 적용)');
const board = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot.board;
ok(board.vent.tomato === 33 && board.vent.egg === 2 && board.vent.wok === 1, `현황판 화풀기 집계 🍅${board.vent.tomato} 🥚${board.vent.egg} 🍳${board.vent.wok}`);
ok(board.vent.targets.some((x) => x.unit === '402' && x.tomato === 3), '화풀이 표적 = 윗집 (402호)');
ok(board.pairs.some((p) => p.from === '302' && p.to === '402' && p.count >= 1), '민원 흐름: 302호 → 402호');
ok(board.pairs.some((p) => p.relay && p.to === '303'), '민원 흐름: 미가입 세대는 관리사무소 경유로 표시');
ok(board.feed.some((x) => x.kind === 'wok') && board.feed.some((x) => x.kind === 'alert') && board.feed.some((x) => x.kind === 'reply'), '실시간 소식: 민원·답장·토계볶');
ok(board.today.alerts > 0 && board.today.units > 0, '오늘 민원·등록 세대 집계');

// 관리자 폴링: 바뀐 게 없으면 기다렸다가 같은 버전, 바뀌면 새 버전
const v0 = (await req(`${A}/admin/poll?after=0`, null, K)).data.version;
const adminWait = req(`${A}/admin/poll?after=${v0}`, null, K);
await req(`${A}/chat`, { token: down.token, text: '감사합니다' });
ok((await adminWait).data.version > v0, '관리자 폴링이 새 문의에 바로 깨어남');

// 데모 초기화
await resetDemo();
ok((await req(`${A}/poll?token=${me.token}`)).data.invalid, '데모 초기화 → 예전 등록 만료');
ok((await req(`${A}/config`)).data.quietStart === 22, '데모 초기화 → 기본 설정으로');

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
process.exit(fails ? 1 : 0);
