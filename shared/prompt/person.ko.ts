/**
 * 사장님이 어디에 있고 사장님의 시계가 몇 시인지 — 프롬프트의 문맥 층, 한두 줄.
 *
 * 왜 있는가. 오늘 날씨를 묻자 봇이 네이버를 검색하고 네이버가 짐작한 제주시를 "사장님 위치"라고
 * 답했다(2026-09-24 실측). 네이버는 요청이 온 주소로 위치를 짐작했고, 그 요청은 클라우드 VM에서
 * 도는 봇의 브라우저가 보낸 것이었다. 봇의 컴퓨터가 있는 곳은 사장님이 있는 곳이 아니다 — 그래서
 * 사장님의 시간대와 위치를 봇에게 직접 말해 주고, 사이트가 알아서 보여 주는 위치를 믿지 말라고
 * 적는다.
 *
 * 위치는 둘 중 하나에서 온다: 사장님이 내 가게에서 적은 곳(또는 대화에서 말해서 봇이 저장한 곳),
 * 아니면 사장님이 허락해서 받은 기기의 대략적인 좌표(소수 둘째 자리). 둘 다 없으면 봇은 필요할 때
 * 한 번 묻고 `remember`의 `place`로 저장한다 — 저장되면 다음 실행부터는 이 줄이 그 곳을 말하므로
 * 다시 묻지 않는다.
 *
 * 시계 줄은 `index.ts`의 `nowLine`이 그대로 맡는다. 여기서는 그 줄 뒤에 붙는 "누구의 시계인가"와,
 * 가게 줄 뒤에 서는 위치 줄만 만든다.
 */
import type { Coordinates } from "../whereabouts";
import type { PromptMode } from "./index";

/**
 * 이 실행의 사장님. 모든 칸이 선택이다 — 없는 칸은 "모른다"이지 "기본값"이 아니다.
 *
 * `timeZone`은 사장님의 것일 때만 온다: 대화면 그 기기가 방금 보낸 것, 루틴이면 마지막 세션이
 * 저장해 둔 것. 둘 다 없으면 비어 있고, 시계는 배포의 시간대(`BOT_TIME_ZONE`, 기본 서울)로 읽힌다.
 */
export type PromptPerson = {
  timeZone?: string;
  locale?: string;
  place?: string;
  coordinates?: Coordinates;
};

/** 사이트가 짐작한 위치를 사장님 위치로 옮기지 않는다 — 이 파일이 생긴 실패 그 자체. */
const NOT_THE_SITES_GUESS =
  "사이트가 알아서 보여 주는 위치(현위치 같은)는 네 컴퓨터가 있는 곳이지 사장님 위치가 아니다.";

/**
 * 위치가 있을 때 그것을 어떻게 쓰는지. 이름을 대야 사장님이 틀린 곳을 바로잡을 수 있다.
 *
 * "검색어에 넣는다"만으로는 모자랐다(2026-09-24 로컬 실측). 봇은 구글에 "서울 강남구 날씨"를
 * 검색했고, 구글이 VM의 주소를 막자 네이버 날씨 홈으로 갔다. 그 페이지는 VM의 현위치(제주시
 * 이도2동)를 그렸고, 봇은 그 숫자를 "서울 강남구 기준"이라고 답했다 — 이름은 맞고 날씨는 제주의
 * 것. 그래서 두 가지를 적는다: 곳 이름을 넣은 네이버 검색이라는 구체적인 길, 그리고 페이지가 그린
 * 지역을 보고 다르면 그 값을 버리라는 것.
 */
function useIt(place: string): string {
  return `날씨·가까운 곳처럼 위치가 필요한 일은 매번 이 곳 이름을 검색어에 넣어 새로 찾는다(예: 네이버 검색 '${place} 날씨'). 페이지에 적힌 지역 이름을 확인하고, 이 곳이 아니면 그 숫자는 전하지 않는다. 답할 때 어느 곳 기준인지 말한다.`;
}

/**
 * 위치 줄. 언제나 한 줄이 선다 — 모를 때도, 모른다는 것과 어떻게 알아내는지를 말해야 봇이 사이트의
 * 짐작으로 빈칸을 메우지 않는다.
 */
export function placeText(
  person: PromptPerson | undefined,
  mode: PromptMode,
): string {
  const place = person?.place?.trim();
  if (place) {
    return `사장님 가게 위치: ${place}. ${useIt(place)} ${NOT_THE_SITES_GUESS}`;
  }
  const at = person?.coordinates;
  if (at) {
    return [
      `사장님 위치: 위도 ${at.latitude.toFixed(2)}, 경도 ${at.longitude.toFixed(2)} 부근(사장님 기기에서 받은 대략적인 값). 날씨·가까운 곳처럼 위치가 필요한 일은 이 부근 기준으로 하고, 답할 때 어느 곳 기준인지 말한다.`,
      mode === "chat"
        ? "동네 이름이 필요하면 사장님께 한 번 여쭤보고, 들은 곳(시·구까지)을 remember의 place로 저장한다."
        : "",
      NOT_THE_SITES_GUESS,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return mode === "chat"
    ? `사장님 가게 위치는 아직 모른다. 날씨·가까운 곳처럼 위치가 필요한 일이면 먼저 사장님께 한 번 여쭤보고, 들은 곳(시·구까지)을 remember의 place로 저장한 다음 그 곳 기준으로 한다. ${NOT_THE_SITES_GUESS}`
    : `사장님 위치를 모른다. 위치가 필요한 일이면 위치를 몰라 하지 못했다고 적는다. ${NOT_THE_SITES_GUESS}`;
}

/**
 * 시계 줄 끝에 붙는 "누구의 시계인가". 사장님의 시간대를 알 때만 붙는다 — 배포의 기본 시간대로
 * 읽은 시각을 사장님 기기 시각이라고 말하면 그것이 거짓이다.
 */
export function clockOwnerText(person: PromptPerson | undefined): string {
  const zone = person?.timeZone;
  if (!zone) return "";
  const locale = person?.locale ? `, 언어 ${person.locale}` : "";
  return ` (사장님 기기 시간대 ${zone}${locale})`;
}
