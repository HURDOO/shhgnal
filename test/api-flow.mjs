// 쉿!그널(아파트) API 흐름 테스트: 임시 데이터 폴더로 별도 서버를 띄워 검사한다 (실제 data/는 건드리지 않음)
// 실행: npm test
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSendLimit } from '../limits.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knock-test-'));
const port = 3900 + Math.floor(Math.random() * 90);

// 가짜 LLM (OpenAI Responses API 형식): 실제 키 없이 요청·응답 형식과 실패 시 대체 동작을 검사한다
const llmCalls = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    const msg = body.input.match(/<message>\n([\s\S]*)\n<\/message>/)?.[1] || '';
    llmCalls.push({ auth: req.headers.authorization, path: req.url, model: body.model, schema: body.text?.format?.type, msg });
    if (msg.includes('LLMFAIL')) return res.writeHead(500).end('boom');
    let r = { text: msg, severity: 'none', blocked: false, reason: '' };
    if (msg.includes('찾아간다')) r = { text: '소음 문제로 직접 이야기 나누고 싶어요.', severity: 'severe', blocked: true, reason: '위협 표현' };
    else if (msg.includes('미친')) r = { text: '밤마다 소음이 커서 많이 힘들어요. 조금만 조심해 주세요.', severity: 'severe', blocked: false, reason: '욕설을 뺐어요' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(r) }] }] }));
  });
});
await new Promise((r) => mock.listen(0, r));
// 흐름 테스트에서는 보내기 제한을 풀고, 제한 규칙은 아래에서 checkSendLimit로 따로 검사한다
const llmEnv = { SEND_GAP_SEC: '0', SEND_PER_HOUR: '1000', OPENAI_API_KEY: 'test-key', LLM_BASE_URL: `http://localhost:${mock.address().port}/v1`, LLM_MODEL: 'mock-model' };

const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...llmEnv, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => server.stdout.on('data', (d) => d.toString().includes('실행 중') && resolve()));
const cleanup = () => {
  server.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
};
// 테스트가 중간에 죽어도 서버가 남지 않게
process.on('exit', () => server.kill());
process.on('uncaughtException', (e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});

const B = `http://localhost:${port}`;
let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails++;
};
async function req(path, body, headers = {}) {
  const res = await fetch(B + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const events = async (A, u, name) => (await req(`${A}/poll?token=${u.token}&after=0`)).data.events.filter((e) => e.event === name);

// 건물 등록: 5층 × 3라인 (501~503 ... 101~103)
const slug = `t${Date.now().toString(36)}`;
const c = await req('/api/buildings', { name: '테스트 101동', slug, floors: 5, lines: 3 });
ok(c.status === 200 && c.data.adminKey, '건물 등록');
ok((await req('/api/buildings', { name: 'x', slug })).status === 409, '중복 주소 거부');
ok((await req('/api/buildings', { name: 'x', floors: 99 })).status === 400, '층수 범위 밖 거부');
const A = `/api/b/${slug}`;
const K = { 'x-admin-key': c.data.adminKey };
ok((await req(`${A}/admin/poll?after=0`, null, { 'x-admin-key': 'wrong' })).status === 401, '잘못된 관리자 키 거부');
ok((await req('/api/b/nope/config')).status === 404, '없는 건물 404');
const cfg = (await req(`${A}/config`)).data;
ok(cfg.layout.cells[0] === '501' && cfg.layout.cells.at(-1) === '103', `기본 호수 배치: ${cfg.layout.cells[0]} … ${cfg.layout.cells.at(-1)}`);

// 세대 QR 등록: 기본은 코드로만 등록
ok((await req(`${A}/join`, { unit: '302' })).status === 403, '호수 직접 입력은 기본으로 막힘');
let snap0 = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
ok(Object.keys(snap0.unitCodes).length === 15, '세대 15개 모두 등록 코드 발급');
const code503 = snap0.unitCodes['503'];
ok((await req(`${A}/unit-code?code=${code503}`)).data.unit === '503', '코드 → 호수 확인');
ok((await req(`${A}/join`, { code: 'WRONGCODE' })).status === 403, '틀린 코드 거부');
const q1 = (await req(`${A}/join`, { code: code503.toLowerCase(), unit: '101', deviceId: 'q1' })).data;
ok(q1.unit === '503', '코드로 등록하면 입력한 호수와 상관없이 코드의 세대로 등록');
ok((await req(`${A}/admin/codes/503/reissue`, {}, K)).data.kicked === 1, '코드 재발급 → 그 세대 주민 등록 해제');
ok((await req(`${A}/poll?token=${q1.token}`)).data.invalid, '재발급 후 예전 등록 만료');
ok((await req(`${A}/join`, { code: code503 })).status === 403, '예전 코드는 못 씀');
ok((await req(`${A}/admin/settings`, { allowManualJoin: true }, K)).status === 200, '시연용 직접 입력 허용');

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

// 직접 알림 → 가족 모두 수신, 보낸 세대는 숨김
// 앱 미가입 세대: 관리사무소에 전달 → 연락하면 보낸 세대에 알림
const rl = await req(`${A}/alerts`, { token: me.token, target: '303', type: 'footstep' });
ok(rl.status === 200 && rl.data.relay?.toUnit === '303' && rl.data.message.includes('가입하지 않았어요'), '미가입 세대 → "가입 안 됨" 안내 + 관리사무소 전달');
let rsnap = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
const relay = rsnap.relays.find((r) => r.toUnit === '303');
ok(relay?.fromUnit === '302' && relay.status === 'open', '관리사무소: 연락 요청 확인 (보낸 세대 포함)');
ok((await req(`${A}/admin/relays/${relay.id}`, { action: 'contacted', note: '인터폰으로 전달했어요' }, K)).data.notified, '관리사무소: 연락했어요 처리');
const relayEv = (await events(A, me, 'relay')).at(-1)?.data;
ok(relayEv?.status === 'contacted' && relayEv.note === '인터폰으로 전달했어요' && !relayEv.fromUnit, '보낸 세대에 "관리사무소가 연락했어요" 알림');
ok((await req(`${A}/alerts`, { token: me.token, target: '302', type: 'footstep' })).status === 400, '우리 집에 보내기 거부');
const a1 = await req(`${A}/alerts`, { token: me.token, target: '402', type: 'footstep' });
ok(a1.status === 200 && a1.data.alerts[0].dir === 'up', '윗집에 알림 (방향 up)');
const got1 = (await events(A, up, 'alert'))[0]?.data;
const got2 = (await events(A, up2, 'alert'))[0]?.data;
ok(got1 && got2 && got1.id === got2.id, '같은 세대 가족 모두에게 전달');
ok(!JSON.stringify(got1).includes('302'), '받은 세대에는 보낸 호수가 안 보임');

// 가족 중 한 명이 답장 → 다른 가족 화면에도 반영, 두 번째 답장 거부
const rep = await req(`${A}/alerts/${got1.id}/reply`, { token: up.token, reply: 'notus' });
ok(rep.status === 200 && rep.data.replyText.includes('아니에요'), '"저희 집 아니에요" 답장');
ok((await req(`${A}/alerts/${got1.id}/reply`, { token: up2.token, reply: 'sorry' })).status === 409, '가족 중복 답장 거부');
ok((await events(A, up2, 'reply')).some((e) => e.data.id === got1.id && e.data.reply === 'notus'), '다른 가족에게 답장 상태 공유');
ok((await events(A, me, 'reply')).some((e) => e.data.reply === 'notus'), '보낸 세대에 답장 전달');

// 어디서 나는지 모를 때: 주변(위·아래·옆) 중 앱 쓰는 세대만, 쿨다운 중인 402는 빼고
const ar = await req(`${A}/alerts`, { token: me.token, target: 'around', type: 'hammer' });
const arUnits = ar.data.alerts.map((a) => a.toUnit).sort();
ok(ar.status === 200 && arUnits.join() === '202,301,402', `주변 확인 요청: ${arUnits} (303은 미가입, 101은 주변 아님)`);
ok((await events(A, down, 'alert')).some((e) => e.data.around), '주변 요청은 around 표시');
ok(!(await events(A, far, 'alert')).length, '주변이 아닌 세대는 받지 않음');

// 기타 메시지: 길게 쓸 수 있고, AI 필터를 거쳐 다듬어진 문장만 전달
const long = '요즘 밤마다 쿵쿵 소리가 나서 잠을 못 자요. 미친 듯이 뛰네요';
const cut = await req(`${A}/filter/preview`, { token: up.token, text: '가'.repeat(150) });
ok(cut.data.text.length === 100, '이웃 메시지는 100자까지만');
const pv = await req(`${A}/filter/preview`, { token: up.token, text: long });
ok(pv.status === 200 && pv.data.changed && !pv.data.text.includes('미친'), `긴 글(${long.length}자) 미리 다듬기`);
const callsBefore = llmCalls.length;
const e1 = await req(`${A}/alerts`, { token: up.token, target: '302', type: 'etc', text: long, previewId: pv.data.previewId });
ok(e1.status === 200 && llmCalls.length === callsBefore, '미리 다듬은 결과를 그대로 써서 보냄 (AI 재호출 없음)');
const recv = (await events(A, me, 'alert')).find((e) => e.data.type === 'etc')?.data;
ok(recv?.message === pv.data.text && !JSON.stringify(recv).includes('미친'), '받는 세대에는 다듬어진 문장만 (원문 없음)');
ok(llmCalls[0]?.auth === 'Bearer test-key' && llmCalls[0].path === '/v1/responses' && llmCalls[0].schema === 'json_schema' && llmCalls[0].model === 'mock-model', 'LLM 요청 형식 (Responses API, 구조화 출력)');
const threat = await req(`${A}/alerts`, { token: down.token, target: '302', type: 'etc', text: '한 번만 더 그러면 찾아간다' });
ok(threat.status === 422 && threat.data.blocked, '위협 메시지는 전달 차단');
const fail = await req(`${A}/alerts`, { token: side.token, target: '302', type: 'etc', text: 'LLMFAIL 씨발 시끄러워요' });
const failMsg = fail.data.alerts?.[0]?.message || '';
ok(fail.status === 200 && !failMsg.includes('씨발') && failMsg.includes('○○'), `AI 실패 시 기본 규칙으로 대신 (${failMsg})`);
snap0 = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
const logs = snap0.filterLog;
ok(logs.some((f) => f.original === long && f.delivered === pv.data.text && f.source === 'llm'), '관리사무소: 원문과 전달 문장 함께 확인');
ok(logs.some((f) => f.blocked && f.original.includes('찾아간다')), '관리사무소: 차단된 메시지 원문 확인');
ok(logs.some((f) => f.fallback), '관리사무소: AI 실패 대체 표시');
const meHello = (await req(`${A}/poll?token=${me.token}`)).data.events[0].data;
ok(!JSON.stringify(meHello).includes('미친') && !JSON.stringify(meHello).includes('찾아간다'), '주민 화면 데이터에는 원문이 없음');

// 직접 쓴 답장도 필터를 거친다
const toReply = (await events(A, me, 'alert')).find((e) => e.data.type === 'etc')?.data;
const cr = await req(`${A}/alerts/${toReply.id}/reply`, { token: me.token, reply: 'custom', text: '미친 소리 하지 마세요 저희 아니에요' });
ok(cr.status === 200 && cr.data.replyText.includes('조심해') && !cr.data.replyText.includes('미친'), '직접 쓴 답장 → 다듬어서 전달');
ok((await events(A, up, 'reply')).some((e) => e.data.id === toReply.id && e.data.replyText === cr.data.replyText), '보낸 세대는 다듬어진 답장을 받음');
snap0 = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
ok(snap0.filterLog.some((f) => f.kind === 'reply' && f.original.includes('미친')), '관리사무소: 답장 원문 확인');

// 보내기 제한 규칙 (5분에 1번, 1시간에 3번)
const T = 1_000_000_000;
ok(checkSendLimit([], T, 300, 3) === null, '처음 보내기 허용');
ok(checkSendLimit([T - 299_000], T, 300, 3)?.error.includes('5분'), '5분 안에 다시 보내기 거부');
ok(checkSendLimit([T - 301_000], T, 300, 3) === null, '5분 지나면 허용');
ok(checkSendLimit([T - 3_000_000, T - 2_000_000, T - 1_000_000], T, 300, 3)?.error.includes('1시간에 3번'), '1시간에 4번째 거부');
ok(checkSendLimit([T - 3_700_000, T - 2_000_000, T - 1_000_000], T, 300, 3) === null, '1시간 지난 기록은 빼고 셈');

// 신고 3세대 → 자동 제한 (far가 보내고 각 세대가 신고)
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

// 반복 소음 세대 집계 (서로 다른 3세대가 202호에 알림)
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
const far20 = await req(`${A}/notices`, { token: up2.token, type: 'move', startAt: now + 20 * 86400e3, endAt: now + 20 * 86400e3 + 3600e3 });
ok(far20.status === 200, '20일 뒤 일정 공지 (캘린더용)');
await req(`${A}/notices/${far20.data.id}/delete`, { token: up2.token });
const n1 = await req(`${A}/notices`, { token: me.token, type: 'assembly', text: '소파 조립해요', startAt: now, endAt: now + 2 * 3600e3 });
ok(n1.status === 200 && n1.data.unit === '302' && n1.data.mine, '양해 공지 등록 (호수 공개)');
const seen = (await events(A, far2, 'notices')).at(-1)?.data;
ok(seen?.[0]?.text === '소파 조립해요' && !seen[0].mine, '다른 세대에 공지 전달');
const th = await req(`${A}/notices/${n1.data.id}/thanks`, { token: up.token });
ok(th.data.notices[0].thanks === 1 && th.data.notices[0].thanked, '👍 괜찮아요');
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
ok(angry.data.messages[0].filtered && angry.data.messages[0].delivered.includes('조심해'), '화난 문의 → 다듬어서 관리사무소에 전달');
const t = await req(`${A}/chat`, { token: down.token, text: '윗집이랑 이야기해도 해결이 안 돼요' });
ok(t.data.messages[1].text.includes('이웃사이센터'), '직접 문의 키워드 → 챗봇 안내');
snap = (await req(`${A}/admin/poll?after=0`, null, K)).data.snapshot;
const chat = snap.chats.find((x) => x.unit === '202');
const angryChat = snap.chats.find((x) => x.unit === '301');
ok(angryChat?.messages[0].text.includes('미친') && angryChat.messages[0].delivered, '관리사무소: 문의 원문 열람 가능');
ok(chat?.unread === 1, '관리사무소: 새 문의 1건');
ok((await req(`${A}/admin/chats/${chat.userId}`, { text: '이번 주에 방문해서 중재해 드릴게요' }, K)).status === 200, '관리사무소 답변');
ok((await events(A, down, 'chat')).at(-1).data[0].from === 'admin', '주민에게 답변 전달');

// 세대 배치 변경 → 없어진 호수 주민 등록 해제
const cells = cfg.layout.cells.map((l) => (l === '101' ? null : l));
const lay = await req(`${A}/admin/layout`, { rows: 5, cols: 3, cells }, K);
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
ok(board.vent.targets.some((t) => t.unit === '402' && t.tomato === 3), '화풀이 표적 = 서버가 계산한 윗집 (402호)');
ok(board.pairs.some((p) => p.from === '302' && p.to === '402' && p.count >= 1), '민원 흐름: 302호 → 402호');
ok(board.pairs.some((p) => p.relay && p.to === '303'), '민원 흐름: 미가입 세대는 관리사무소 경유로 표시');
ok(board.feed.some((f) => f.kind === 'wok') && board.feed.some((f) => f.kind === 'alert') && board.feed.some((f) => f.kind === 'reply'), '실시간 소식: 민원·답장·토계볶');
ok(board.today.alerts > 0 && board.today.units > 0, '오늘 민원·등록 세대 집계');

// 매니페스트
const mf = (await req(`/b/${slug}/manifest.webmanifest`)).data;
ok(mf.start_url === `/b/${slug}/` && mf.name.includes('쉿!그널'), '건물별 매니페스트 (쉿!그널)');
ok((await fetch(`${B}/b/${slug}/qr`)).status === 404, '엘리베이터 QR 페이지 없음');

console.log(fails ? `\n실패 ${fails}건` : '\n모두 통과');
cleanup();
process.exit(fails ? 1 : 0);
