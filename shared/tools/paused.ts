/**
 * 검토를 기다리는 툴이 모델 앞에 서는 모습 — 공급자가 쓴 글은 한 글자도 없이.
 *
 * 연결된 서비스의 툴 설명과 스키마는 공급자가 쓰고 모델이 읽는 글이다. 그 글이 등록 뒤에 바뀌면
 * 서버는 그 툴을 멈춘다(`server/src/plugins/servers.ts`의 `refreshTools`, "definition changed"):
 * 설명에 숨겨 넣은 지시는 프롬프트 주입이고, 사람이 읽고 승인하기 전의 글은 아무도 본 적 없는
 * 글이다. 그런데 2026-10-06까지 멈춘 것은 호출뿐이었다 — 바뀐 설명과 스키마는 그대로 모델에게
 * 갔고, `tool_search`는 그 글의 낱말로 툴을 골랐다(#110의 리뷰가 찾았다).
 *
 * 그래서 멈춘 툴은 이름만 그대로 두고 — 그 이름은 예전에 동의한 이름이다 — 설명은 이 한 문단으로,
 * 스키마는 빈 객체로 바꿔서 내준다(`server/src/plugins/skills-and-grants.ts`의 `offeredToModel`).
 * 이름을 남기는 까닭은 사람이 멈춘 것을 알게 되는 길이 지금은 봇의 말 하나뿐이기 때문이다.
 * 등록 뒤에 새로 생긴 툴은 이름조차 동의한 적이 없으니 아예 내주지 않는다.
 *
 * 모든 툴에 글자 하나까지 같은 글이다: 툴의 이름도 서버의 이름도 끼워 넣지 않는다 — 이름은 이름
 * 칸에 이미 있고, 여기에 공급자의 글이 들어올 틈을 하나도 두지 않으려는 것이다. 무엇을 말하는가:
 * 정의가 바뀌어 검토를 기다린다는 것, 부르면 거절된다는 것, 그리고 어디서 검토하는지 — 화면의
 * 이름 그대로 관리 메뉴의 플러그인("정의가 바뀜 — 검토 전까지 정지", 승인은 그 화면의 단추).
 * 호출을 거절할 때 봇이 듣는 문장(`laf:tool_needs_review`, `shared/prompt/tool-results.ko.ts`)과
 * 같은 낱말을 쓴다. 그 표의 규칙도 그대로다: 봇은 들은 낱말을 따라 하므로 '사람에게'도
 * '사장님'도 쓰지 않는다(`tests/owner-words-prompt.test.ts`).
 */
import type { JsonSchema } from "./standard-schema";

export const PAUSED_TOOL_DESCRIPTION =
  "이 툴은 정의가 바뀌어서 검토를 기다리는 중이다. 검토가 끝나기 전에는 불러도 거절되니 부르지 마라. " +
  "이 툴이 멈춰 있다고 알리고, 관리 메뉴의 플러그인 화면에서 바뀐 정의를 검토해 달라고 말해라.";

/** 인자가 없다: 부를 수 없는 툴에 채울 칸은 없고, 공급자의 스키마에는 공급자의 글이 있다. */
export const PAUSED_TOOL_PARAMETERS: JsonSchema = {
  type: "object",
  properties: {},
};

/* ------------------------------------------------------------------------------------------ */
/* 내주지 않은 툴: 어느 서비스에 몇 개인지만                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * 봇이 쥐고 있지만 검토를 기다리느라 아예 내주지 않은 툴 — 서버마다 몇 개인지, 그것뿐.
 *
 * 등록 뒤에 새로 생긴 툴은 이름조차 내주지 않는다(위). 그러자 봇은 그 툴이 있다는 것 자체를 모르게
 * 됐다(#116의 리뷰, 2026-10-06). 카카오의 도구함이 바로 그 길이다: 처음 연결할 때는 비어 있고,
 * 사람이 카카오에서 도구를 담은 뒤 다시 연결하면 그 도구는 전부 "등록 뒤에 생긴 것"이다. 그 사람이
 * "방금 담은 그 도구 써 줘"라고 하면 봇은 찾아보고, 다리는 "연결돼 있지만 그 연결이 가져온 도구가
 * 없는 계정"이라고 답했다 — 도구는 있고, 검토를 기다리고 있을 뿐인데. 멈춘 것을 사람이 알게 되는
 * 길은 봇의 말 하나뿐이라고 위에 적었는데, 그 길이 이 툴들에는 없었다.
 *
 * 그래서 서버가 세어 준다: 서버의 id와 개수. 공급자가 쓴 글은 여기에도 없다 — 서버의 id는
 * 카탈로그의 키이거나 관리자가 서버를 더하며 직접 정한 이름이고(`addCustomServer`), 툴의 이름은
 * 세기만 하고 싣지 않는다.
 *
 * 어디에 실려 가는가: 툴 목록이 아니라 실행의 `forwardedProps`에. 내주지 않은 툴은 정의상 툴
 * 목록에 없다. 목록에 가짜 항목을 세우면 목록을 읽는 모든 곳(맥락 층의 이름 문단, 찾기, 가드)이
 * 그것을 걸러야 하고, 연결 카드에 적으면(`ACCOUNT_STATES`, `./gallery.ts`) 카드가 없는 루틴이 못
 * 듣는다. 실행마다 딸려 가는 사실이 지나는 길은 `forwardedProps`다 — 턴과 무인 실행이 싣고
 * (`withheldToolsForwarded`), 모든 실행이 지나는 이음새 하나가 읽는다(`server/src/copilot.ts`).
 *
 * 어디에서 읽히는가: **맥락 층에서.** 다리 뒤의 이름을 적는 문단 끝에 한 줄로 선다
 * (`deferredToolsText`, `./bridge.ts`). 처음에는 찾기의 답 끝에만 섰는데(#119의 첫 판), 그 문단이
 * 바로 "다리 뒤에 있는 것은 아래가 전부다 — 여기 없는 일을 하려고 tool_search 하지 말라"고 하는
 * 문단이다. 그 말을 그대로 따른 봇은 찾지 않았고, 그래서 그 줄을 읽은 적이 없다: 도구 둘이 검토를
 * 기다리는 도구함의 도구를 써 달라는 부탁에 한 번도 찾지 않고 "그 도구는 목록에 없어서 할 수
 * 없어요"라고만 했다(2026-10-06, 플릿의 모델, 실제 스택). 봇이 아무것도 하지 않고도 읽는 자리는
 * 맥락 층뿐이다. 프롬프트의 머리(툴 목록, 정적 층)는 그대로다 — 맥락 층은 대화가 시작될 때 한 번
 * 얼고, 그 뒤에 개수가 바뀌면 이 문단의 다른 변화처럼 사람의 다음 메시지에 알림으로 간다
 * (`reminderLines`). 새 에포크는 열리지 않는다: 에포크의 열쇠는 핵심 툴만 세고
 * (`toolsFingerprint`), 이것은 툴이 아니다.
 *
 * `agent-bot`도 이것을 받지만 말하지는 않는다: 찾기의 답이 도구가 기다리는 계정을 "가져온 도구가
 * 없는 계정"이라고 부르지 않게 하는 데만 쓴다(`connectingLines`).
 */
export type WithheldTools = readonly { server: string; count: number }[];

/** 그 사실이 실려 가는 `forwardedProps`의 이름. 싣는 쪽도 읽는 쪽도 이 파일이라 둘이 어긋날 수 없다. */
const WITHHELD_TOOLS_PROP = "toolsWithheld";

/**
 * 싣는 쪽(서버): 실행의 `forwardedProps`에 펼쳐 넣을 것. 센 것이 없으면 아무것도 싣지 않는다 —
 * 기다리는 것이 없는 실행의 요청은 이 변경 전과 바이트까지 같다.
 */
export function withheldToolsForwarded(
  withheld: WithheldTools | undefined,
): Record<string, unknown> {
  return withheld && withheld.length > 0
    ? { [WITHHELD_TOOLS_PROP]: withheld }
    : {};
}

/**
 * 서버 id의 모양: 소문자, 숫자, 하이픈. 카탈로그의 키도 관리자가 정한 이름도 전부 이 안에 든다
 * (`server/src/plugins/connected-page.ts`의 같은 식). 이 모양이 아닌 것은 버린다 — 띄어쓰기도
 * 문장부호도 한글도 없는 글자열은 문장을 실어 나를 수 없다.
 */
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 한 번에 읽는 서버 수의 한도. 카탈로그 전부와 직접 더한 서버 몇을 넉넉히 넘는다. */
const MAX_WITHHELD_SERVERS = 24;

/**
 * `forwardedProps`에 실려 온 것을 닫힌 모양으로 읽는다 — 누가 실었든.
 *
 * 이 값은 실행에 실려 와 모델이 읽는 문장에 들어간다. 그래서 여기서 통과하는 것은 위의 모양인
 * id와 1 이상의 정수뿐이고, 나머지는 조용히 버린다: 모양이 틀린 항목 하나 때문에 실행이 실패하는
 * 것보다 그 줄이 없는 편이 낫다. 같은 서버가 두 번 오면 처음 것만, id 순으로. 서버의 이음새도
 * `agent-bot`도 이것으로 읽는다 — 그 이음새는 턴이 실은 것과 다른 누가 실은 것을 가릴 수 없다.
 */
export function withheldToolsIn(forwarded: unknown): WithheldTools {
  if (!forwarded || typeof forwarded !== "object") return [];
  const sent = (forwarded as Record<string, unknown>)[WITHHELD_TOOLS_PROP];
  if (!Array.isArray(sent)) return [];
  const counted = new Map<string, number>();
  for (const entry of sent) {
    if (!entry || typeof entry !== "object") continue;
    const { server, count } = entry as { server?: unknown; count?: unknown };
    if (typeof server !== "string" || !SERVER_ID.test(server)) continue;
    if (typeof count !== "number" || !Number.isSafeInteger(count)) continue;
    if (count < 1 || counted.has(server)) continue;
    counted.set(server, count);
  }
  return [...counted.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_WITHHELD_SERVERS)
    .map(([server, count]) => ({ server, count }));
}

/**
 * 맥락 층의 그 한 줄. `named`는 다리가 만든다 — 서비스의 이름과 개수("카카오(kakao-playmcp) 2개"),
 * 여럿이면 쉼표로.
 *
 * 무엇을 말하는가: 검토를 기다리느라 어느 목록에도 없는 도구가 있다는 것, 어느 서비스에 몇 개인지,
 * 찾아도 다시 연결해도 나오지 않는다는 것, 그리고 어디서 검토하는지 — 위의 설명과 같은 낱말로,
 * 관리 메뉴의 플러그인 화면. 헛걸음 둘을 이름으로 막는다: 이 줄을 읽고 `tool_search`로 찾아보는 것
 * (한 바퀴를 더 쓰고 빈손이다), 그리고 연결이 덜 된 줄 알고 다시 연결하라고 권하는 것 — 연결 카드의
 * 답(`laf:connection_unusable`)이 도구 없는 계정에 바로 그 말을 시키는데, 기다리는 도구는 다시
 * 연결해도 기다린다. "새로 생긴"이라고 하지 않는다: 이 빌드가 모르는 까닭으로 멈춘 툴도 여기
 * 세어지고, 그것이 새것인지는 모른다.
 *
 * 혼자서도 서는 문장이다. 다리 뒤에 이름이 하나도 없는 실행 — 연결한 서비스의 도구가 전부 검토를
 * 기다리는 루틴이 그렇다 — 에서는 이 줄이 그 문단의 전부다. 그래서 앞 문장에 기대는 말("다만")로
 * 열지 않는다. 위의 설명처럼 '사람에게'도 '사장님'도 쓰지 않는다
 * (`tests/owner-words-prompt.test.ts`).
 */
export const withheldToolsText = (named: string): string =>
  `검토를 기다리고 있어 어느 목록에도 없는 도구가 있다: ${named}. tool_search로 찾아도, 다시 연결해도 나오지 않는다 — 이 가운데 하나가 필요한 일이면 그 서비스의 도구가 검토를 기다리는 중이라고 알리고, 관리 메뉴의 플러그인 화면에서 검토해 달라고 말한다.`;
