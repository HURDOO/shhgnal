// 소리 민원 보내기 제한: 기기마다 5분에 1번, 1시간에 최대 3번 (주변 확인 요청·관리사무소 전달 요청도 1번으로 센다)
export const SEND_GAP_SEC = Number(process.env.SEND_GAP_SEC ?? 300);
export const SEND_PER_HOUR = Number(process.env.SEND_PER_HOUR ?? 3);

// times: 이 기기가 보낸 시각들. 보낼 수 없으면 { error, retryAfterSec } 를 돌려준다.
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
