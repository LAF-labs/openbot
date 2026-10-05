/**
 * 핵심 목록 밖의 툴은 스키마에서 빼고, 다리 둘(`tool_search`, `tool_call`)로 닿게 한다.
 *
 * 봇 하나의 스키마에는 늘 서른여섯 개쯤이 실린다: 컴퓨터 툴 열넷, 자기 툴 셋, 그리고 연결된
 * 서비스마다 그 서비스의 툴 전부 — 구글 시트 넷, 지메일 넷, 캘린더 둘, 비즈니스 프로필 셋,
 * 카페24 다섯, 알림톡 둘. 그중 한 턴에 실제로 쓰이는 것은 하나둘이고, 나머지는 매 턴 토큰으로만
 * 값을 치른다. Hermes Agent가 288회로 쟀다: 핵심 툴만 남기고 나머지를 `tool_search` /
 * `tool_describe` / `tool_call` 다리로 닿게 하면 스키마가 47.4 KB → 21.0 KB(−56%), 토큰이
 * 7–23% 줄고 정확도는 그대로였다. 딱 하나 퇴보한 것이 **사람에게 묻는 툴**을 숨겼을 때였다
 * — 구조화된 질문이 산문으로 무너졌다(18/18 → 7/18). 그래서 여기서 갈리는 규칙은 하나다:
 *
 * **스키마에 실리는 것은 고정된 핵심 목록뿐이다** — 이 저장소의 카탈로그(`shared/tools`)에 있는
 * 컴퓨터 툴, 자기 툴, `skill_view`, `routine_note`, `feed_post`, `now`, 웹 검색과 날씨(키가 있는
 * 배포에서, `WEB_SEARCH_TOOL_NAME`·`WEATHER_TOOL_NAME`), 그리고 다리 둘. 그 밖의 모든 것은 다리
 * 뒤에 선다: 연결된 서비스의 툴(`mcp__<서버>__<툴>`), 화면 카드(갤러리), 배포가 만든 컴포넌트.
 * 사람에게 손을 내미는 툴(`computer_request_help`, `computer_request_secret`)은 핵심 목록에 있으니
 * 절대 미뤄지지 않는다. `tests/tool-bridge.test.ts`가 그것을 이름 하나하나 확인한다.
 *
 * 왜 목록이 고정되는가 (Claude Code를 따른다, `~/laf/docs/agent-harness-design.md` 5행). 툴은
 * 프롬프트의 머리다 — GLM의 템플릿은 툴을 시스템 메시지보다 앞에 그린다 — 그래서 툴 하나가 생기거나
 * 사라지면 그 뒤의 대화 전부가 캐시에서 떨어진다. 다리는 전에는 첫 서비스가 연결될 때 나타났고,
 * `tool_search`의 설명에 연결된 서비스 이름이 들어 있었고, 화면 카드는 봇에 허용될 때마다 목록에
 * 들고 났다 — 셋 다 머리를 바꿨다. 이제 다리는 연결된 것이 없어도 늘 있고, 설명은 정적이다. 무엇이
 * 다리 뒤에 있는지는 Claude Code가 미뤄 둔 툴을 알리는 방식 그대로 이름만, 맥락 층과 알림으로 간다
 * (`deferredToolsText`, `shared/prompt/context.ko.ts`).
 *
 * 다리는 아무것도 더하지 않고 아무것도 숨기지 않는다. `tool_search`는 봇이 이미 받은 목록을
 * 되읽어 맞는 툴의 스키마 전부를 대화에 돌려주고(Claude Code의 ToolSearch처럼), `tool_call`은
 * `agent-bot`이 **실제 툴 이름과 인자로 바꿔서** 와이어에 싣는다 — 표면과 무인 실행기는 직접 부른
 * 것과 구별할 수 없고, 같은 `settle`, 같은 감사 행(실제 툴 이름으로), 같은 가드 바닥을 지난다.
 * 다리 자체는 서버에 닿지 않는다.
 *
 * 채택할 오픈소스를 먼저 찾았다(2026-09-25). OpenAI의 `tool_search`/`defer_loading`은 Responses
 * API의 서버 쪽 기능(gpt-5.4 이상)이고, OpenAI Agents SDK의 ToolSearchTool은 그것에 기댄다 —
 * `/v1/chat/completions`로 GLM을 부르는 이 스택에는 닿지 않는다. LangGraph의 bigtool은 요청마다
 * 툴 목록을 바꾸는 방식이라 이 파일이 막으려는 바로 그것이다. opencode의 모델 무관 툴 검색은 아직
 * 제안(issue #49645)이다. 그래서 Hermes Agent의 다리를 따른 이 작은 구현을 유지한다.
 */
import { COMPUTER_TOOLS } from "./computer";
import { FEED_POST } from "./feed-post";
import {
  accountStatesIn,
  CONNECT_CARD,
  FILE_CARD,
  withoutAccountStates,
} from "./gallery";
import { NOW_TOOL_NAME } from "./now";
import { ROUTINE_NOTE } from "./routine-note";
import { SELF_TOOLS } from "./self";
import { SKILL_VIEW } from "./skills";
import type { JsonSchema } from "./standard-schema";

/** 스키마에 실리는가(`core`), 다리로만 닿는가(`deferred`). */
export type ToolExposure = "core" | "deferred";

/**
 * 연결된 서비스의 툴 이름이 붙이는 접두사.
 *
 * 서버의 `toolNameFor`가 여기서 읽는다. 두 곳이 각자 문자열을 갖고 있으면 어느 날 한쪽만 바뀌고,
 * 그날부터 모든 연결된 서비스 툴이 스키마에 다시 실리면서 아무도 눈치채지 못한다.
 */
export const DEFERRED_TOOL_PREFIX = "mcp__";

/**
 * 웹 검색 툴의 이름 — 서버 카탈로그의 `web-search` 엔트리, `search`
 * (`server/src/plugins/web-search-rest.ts`). 연결된 서비스의 이름 모양이지만 **핵심 목록에 있다.**
 *
 * 발자국 사다리(CLAUDE.md)의 마지막 칸을 고른 까닭, 재서 적는다(2026-10-02, muse-spark, 로컬 스택,
 * 같은 봇·같은 대화에서 가격을 묻는 질문 하나씩):
 *
 *   - 다리 뒤(미뤄 둠, 이름 옆에 "브라우저보다 먼저"라는 한마디): 16.9초 — `tool_search` 한 바퀴가
 *     먼저 돌았고, 스키마를 이미 받은 같은 대화의 두 번째 질문에서도 다시 돌았다. 첫 질문은
 *     25.9초(검색 뒤 브라우저로 한 번 더 확인).
 *   - 스키마에 실음: 6.1초 — 2.4초에 검색, 4.3초에 답이 시작됐다. 브라우저는 열리지 않았다.
 *
 * 검색 자체는 0.3–0.5초라 차이는 전부 모델에게 한 바퀴 더 물은 값이다(요청 하나, 3–4초, 대화
 * 전체를 다시 읽는 토큰). "찾아봐 줘"는 이 제품에서 가장 흔한 부탁이고, 그때마다 그 값을 치르는
 * 것보다 스키마 하나(1 KB 남짓)를 매 요청에 싣는 쪽이 싸다 — 캐시에서 읽히는 토큰이다. `now`가
 * 같은 이유로 핵심 툴이다.
 *
 * 키가 없는 배포에는 이 툴이 없고, 그러면 이 이름은 아무 목록에도 실리지 않는다. 키는 재시작
 * 때만 바뀌니 대화 도중에 나타나거나 사라지지 않는다. 서버가 실행하는 턴에서는 창이 무엇을
 * 선언했든 서버가 아는 정의로 싣는다(`server/src/turns/chat-tools.ts`) — 창이 목록을 아직 못 읽은
 * 첫 메시지에 빠졌다가 다음 메시지에 생기면 대화 전체가 두 번 다시 청구된다.
 */
export const WEB_SEARCH_TOOL_NAME = `${DEFERRED_TOOL_PREFIX}web-search__search`;

/**
 * 날씨 툴의 이름 — 서버 카탈로그의 `kma-weather` 엔트리, `get_weather`
 * (`server/src/plugins/kma-weather-rest.ts`). 웹 검색처럼 연결된 서비스의 이름 모양이지만 **핵심
 * 목록에 있다.**
 *
 * 사다리의 마지막 칸을 한 번 더 고른 까닭, 재서 적는다(2026-10-02, muse-spark, 평가 팩의 날씨
 * 시나리오 넷을 세 번씩, 프롬프트의 위치 줄은 같은 것 — `evals/weather.ts`):
 *
 *   - 다리 뒤: 저장된 곳의 날씨 16.6초·19.7K 토큰, 다른 곳의 날씨 16.4초·20.3K. 열두 번 중 아홉 번이
 *     날씨를 불렀고 아홉 번 다 `tool_search` 한 바퀴가 먼저 돌았다.
 *   - 스키마에 실음: 12.5초·13.6K, 12.6초·14.0K. 아홉 번 중 여덟 번이 곧장 불렀다.
 *
 * 한 바퀴가 4초와 토큰 삼분의 일이다. 날씨는 사람이 가장 자주 묻는 것 가운데 하나이고 아침 브리핑
 * 루틴이 매일 부른다. 그 값을 매번 치르는 것보다 스키마 942바이트를 매 요청에 싣는 쪽이 싸다 —
 * 캐시에서 읽히는 토큰이다(`prompt_cache_key`, `agent-bot/src/turn.ts`).
 *
 * 그리고 다리 뒤에 두면 웹 검색에 진다. 위치 줄이 날씨를 네이버 검색의 예로 들던 동안, 날씨 툴을
 * 다리 뒤에 쥔 봇은 세 번 중 세 번 스키마에 있는 웹 검색을 부르고 네이버를 열었다(19.9초, 다른 곳을
 * 물으면 43.5초). 위치 줄을 고친 뒤에는 다리 뒤에서도 날씨 툴로 갔다 — 그 줄이 먼저다
 * (`shared/prompt/person.ko.ts`).
 *
 * 키가 없는 배포에는 이 툴이 없고, 그러면 이 이름은 아무 목록에도 실리지 않는다 — 웹 검색과 같다.
 */
export const WEATHER_TOOL_NAME = `${DEFERRED_TOOL_PREFIX}kma-weather__get_weather`;

/**
 * 스키마에 늘 실리는 이름들 — 이 저장소의 카탈로그가 정한다.
 *
 * 표면이나 루틴이 무엇을 등록했든 이 목록에 없는 이름은 다리 뒤에 선다. 목록이 코드에 있으니 목록이
 * 바뀌는 것은 배포이고, 배포는 하네스 판(`HARNESS_VERSION`)과 함께 새 에포크를 연다.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...COMPUTER_TOOLS.map((tool) => tool.name),
  ...SELF_TOOLS.map((tool) => tool.name),
  SKILL_VIEW.name,
  ROUTINE_NOTE.name,
  // 소식 실행에만 있다(`feed-post.ts`). routine_note처럼, 있는 곳에서는 스키마에 실린다.
  FEED_POST.name,
  NOW_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEATHER_TOOL_NAME,
  /*
   * 파일을 건네는 카드. 화면 카드 가운데 이것 하나만 스키마에 싣는다 — 창이 등록한 대화에서만
   * 있다(루틴에는 창이 없다).
   *
   * 다리 뒤에 있는 동안 잰 것(2026-10-02, 플릿의 모델, 연결된 서비스 전부와 카드 열다섯):
   *   - "방금 그 메모 파일을 화면에 카드로 띄워서 건네줘" → 여섯 번 중 두 번만 건넸다. 넷은
   *     "화면에 카드로 띄우는 기능은 지금 없어서"라고 답했다. 한국어로 찾았고("화면에 카드 띄우기,
   *     파일 보여주기"), 영어로 적힌 카드는 그 말에 닿지 않거나 드라이브의 파일 도구 넷에 밀렸다.
   *   - "이번 주 매출을 CSV 파일로 만들어 줘" → 여섯 번 중 한 번도 건네지 않았다. 파일을 쓰고
   *     "제 컴퓨터에 weekly_sales.csv로 저장해 뒀고"라고 했다 — 사람이 닿을 수 없는 곳이다.
   * 실제 대화에서도 같은 날 아침에는 건넸고 오후에는 "기능이 없다"고 했다. 있다가 없다가 하는
   * 기능은 없는 것보다 나쁘고, 만든 파일을 받는 것은 이 제품에서 `computer_write_file`만큼
   * 기본이다. 값은 스키마 611바이트다.
   */
  FILE_CARD,
]);

export function isDeferredToolName(name: string): boolean {
  return !CORE_TOOL_NAMES.has(name) && !isBridgeToolName(name);
}

export function exposureOf(name: string): ToolExposure {
  return isDeferredToolName(name) ? "deferred" : "core";
}

/**
 * AG-UI가 나르는 툴 하나. 와이어에는 이 셋만 실리므로 여기서 아는 것도 이 셋뿐이다.
 *
 * `parameters`가 선택인 것은 AG-UI의 `Tool`이 그렇기 때문이다. 있는 그대로 넘긴다.
 */
export type WireTool = {
  name: string;
  description: string;
  parameters?: unknown;
};

export function splitExposure<T extends { name: string }>(
  tools: readonly T[],
): { core: T[]; deferred: T[] } {
  const core: T[] = [];
  const deferred: T[] = [];
  for (const tool of tools) {
    (isDeferredToolName(tool.name) ? deferred : core).push(tool);
  }
  return { core, deferred };
}

/* ------------------------------------------------------------------------------------------ */
/* 이름 읽기: mcp__<서버>__<툴>                                                                */
/* ------------------------------------------------------------------------------------------ */

/** `mcp__gmail__send_message` → `gmail`. 접두사가 없으면 null. */
export function serverKeyOf(name: string): string | null {
  if (!name.startsWith(DEFERRED_TOOL_PREFIX)) return null;
  const rest = name.slice(DEFERRED_TOOL_PREFIX.length);
  const at = rest.indexOf("__");
  return at > 0 ? rest.slice(0, at) : rest || null;
}

/** `mcp__gmail__send_message` → `send_message`. 접두사가 없으면 이름 그대로. */
export function bareNameOf(name: string): string {
  if (!name.startsWith(DEFERRED_TOOL_PREFIX)) return name;
  const rest = name.slice(DEFERRED_TOOL_PREFIX.length);
  const at = rest.indexOf("__");
  return at > 0 ? rest.slice(at + 2) : rest;
}

/**
 * 서비스 하나를 사람이 부르는 한국어 이름.
 *
 * 서버 카탈로그의 `key`로 찾는다. 여기 없는 키(관리자가 주소로 더한 서버)는 키 그대로 나간다 —
 * 지어낸 이름보다 낫다. `tests/tool-bridge.test.ts`가 카탈로그의 모든 키에 이름이 있는지 걷는다.
 */
export const FAMILY_LABELS_KO: Readonly<Record<string, string>> = Object.freeze(
  {
    "google-drive": "구글 드라이브",
    "google-sheets": "구글 시트",
    gmail: "지메일",
    "google-calendar": "구글 캘린더",
    "google-business-profile": "구글 비즈니스 프로필",
    cafe24: "카페24",
    notion: "노션",
    canva: "캔바",
    "kakao-playmcp": "카카오",
    "kakao-alimtalk": "카카오 알림톡",
    "public-data": "나라장터·기업마당",
    "web-search": "웹 검색",
    "kma-weather": "날씨",
    // 연결된 서비스가 아니라 이 배포의 서버가 실행하는 목표 툴(`shared/tools/goals.ts`).
    goals: "목표",
  },
);

/** 연결된 서비스가 아닌 것(화면 카드, 배포가 만든 컴포넌트)을 한데 부르는 이름. */
export const SCREEN_FAMILY_KO = "화면에 띄우는 카드";

/** 미뤄진 툴 하나가 속한 무리의 한국어 이름. */
function familyOf(name: string): string {
  const key = serverKeyOf(name);
  return key ? (FAMILY_LABELS_KO[key] ?? key) : SCREEN_FAMILY_KO;
}

/** 미뤄진 툴 이름들이 속한 서비스들, 처음 나온 순서로, 한국어로. 화면 카드는 세지 않는다. */
export function familiesOf(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const name of names) {
    const key = serverKeyOf(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(FAMILY_LABELS_KO[key] ?? key);
  }
  return labels;
}

/**
 * 다리 뒤나 스키마에 서 있지만 누가 연결한 것이 아닌 무리: 이 배포의 서버가 실행하는 목표, 그리고
 * 플릿의 키로 도는 것들. 부팅 때부터 있고, 사람이 무엇을 연결했는지와는 무관하다.
 *
 * 이름으로 가려 두는 까닭(2026-10-05 실측). 빈손인 검색의 답은 연결된 서비스가 있을 때만 "다른
 * 말로 다시 찾아 본다"고 하는데, 그 판단이 무리의 수를 셌다 — 목표는 모든 대화에, 나라장터·기업마당은
 * 플릿의 키가 있는 모든 배포에 있으니, 아무것도 연결하지 않은 사람의 봇도 늘 "지금 연결된 서비스:
 * 목표, 나라장터·기업마당. 다른 말로 다시 찾아 본다"를 읽었고, 그 말대로 다시 찾았다(메일을 물은
 * 여섯 번은 여섯 번 다, 시트는 네 번, 일정은 두 번). `server/tests/tool-exposure.test.ts`가
 * 카탈로그의 `deployment-key` 항목을 걸어 이 목록과 맞춘다.
 */
export const DEPLOYMENT_FAMILIES: ReadonlySet<string> = new Set([
  "goals",
  "public-data",
  "web-search",
  "kma-weather",
]);

/** 사람이 연결한 서비스들, 처음 나온 순서로, 한국어로. 이 배포의 것은 세지 않는다. */
function connectedFamiliesOf(names: readonly string[]): string[] {
  return familiesOf(
    names.filter((name) => {
      const key = serverKeyOf(name);
      return key !== null && !DEPLOYMENT_FAMILIES.has(key);
    }),
  );
}

/** 이번 실행에 실제로 연결된 서비스들을 말하는 한 줄. 검색이 빈손일 때의 답에 쓴다. */
export function deferredFamiliesLine(names: readonly string[]): string {
  const families = connectedFamiliesOf(names);
  if (families.length === 0) return "지금 연결된 서비스는 없다.";
  return `지금 연결된 서비스: ${families.join(", ")}.`;
}

/**
 * 다리 뒤에 무엇이 있는지, 맥락 층에 그려질 글로 — Claude Code가 미뤄 둔 툴을 알리는 방식 그대로
 * 이름만, 무리별로, 이름순으로.
 *
 * 툴 목록이 아니라 맥락 층에 서는 이유: 이것은 사람이 서비스를 연결하거나 카드를 허용할 때 바뀌고,
 * 툴 목록이 바뀌면 대화 전부가 캐시에서 떨어진다. 맥락 층은 에포크마다 얼고, 에포크 중에 바뀌면
 * 사장님의 새 메시지 끝에 알림으로 간다(`reminderLines`). 이름순인 것은 표면이 등록한 순서가 같은
 * 목록을 다른 글로 만들지 않게 하려는 것이다. 없으면 빈 글 — 층에 줄을 세우지 않는다.
 */
export function deferredToolsText(
  names: readonly string[],
  /** 이 사람이 연결할 수 있는데 아직 연결하지 않은 계정의 키들. 하나라도 있으면 문단 끝에 한 문장이 선다. */
  open: readonly string[] = [],
): string {
  const deferred = [...new Set(names.filter(isDeferredToolName))].sort();
  if (deferred.length === 0) return "";
  const groups = new Map<string, string[]>();
  for (const name of deferred) {
    const family = familyOf(name);
    groups.set(family, [...(groups.get(family) ?? []), name]);
  }
  /*
   * "아래가 전부다"가 첫 메시지의 20초였다(0.5.4 리뷰 9번, 2026-09-25 측정). 목록에 날씨 도구가
   * 없는데도 봇은 대화의 첫 질문마다 `tool_search("날씨 확인")`부터 했고, 그 한 라운드(4.8–8초,
   * 사람에게는 "생각 중"만 보이는)가 지나서야 브라우저를 열었다. 다음 질문부터는 빗나간 검색이
   * 대화에 남아 있어서 하지 않았다 — 첫 메시지만 느렸던 까닭이다. 목록이 전부라고 말해 주면 찾을
   * 까닭이 없다.
   */
  return [
    `목록에 없는 도구도 쓸 수 있다. 아래는 이름뿐이니, 쓰기 전에 ${TOOL_SEARCH}로 스키마를 받고 ${TOOL_CALL}로 부른다. 다리 뒤에 있는 것은 아래가 전부다 — 여기 없는 일을 하려고 ${TOOL_SEARCH} 하지 말고, 가진 도구로 곧바로 한다:`,
    ...[...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([family, members]) => `- ${family}: ${members.join(", ")}`),
    /*
     * 연결할 수 있는 계정이 남아 있을 때만 서는 한 문장 — 위의 "여기 없는 일을 하려고 찾지 말고"에
     * 다는 단서다.
     *
     * 왜. 찾으면 다리가 무엇을 연결할 수 있는지와 카드 부르는 법을 말한다(`searchResultText`) — 그런데
     * 위 문장을 그대로 따른 봇은 찾지 않는다. "오늘 일정 뭐 있어?"에 제 루틴만 보고 "제가 챙기고
     * 있는 일정은 없어요" — 읽지도 않은 캘린더가 비었다는 말이다.
     *
     * 세 가지를 재서 골랐다(2026-10-05, 플릿의 모델, 연결한 것이 없는 사람, 일정·메일·시트를 여섯
     * 번씩 — `docs/laf/eval-pack.md` "A service that is not connected"):
     *   이 문장            열여덟 번 중 열여덟 번, 한 번 찾고 두 번째 요청에서 카드. 요청마다 55토큰.
     *   아무것도 없이       열다섯 번. 일정을 물은 여섯 번 중 두 번은 끝내 찾지 않았다.
     *   계정 이름을 적은 줄  열한 번(다리 그대로) — 세 번은 "연결이 필요해요"라고 말만 하고 카드를
     *                     띄우지 않았다. 그 줄만 보고 카드를 바로 부르게 다리를 고쳐도 열여섯 번이고
     *                     (메일·시트는 한 번의 요청에 카드), 요청마다 144토큰이다.
     *
     * 값. 툴 목록도 정적 층도 아니다 — 맥락 층의 이 문단 끝에 서므로 프롬프트의 머리는 그대로다.
     * 남은 계정이 없으면(다 연결했거나, 루틴처럼 카드가 없으면) 이 문장도 없다. 이미 열린 대화는
     * 얼린 층을 그대로 쓰고, 바뀐 이 문단을 사람의 다음 메시지에 알림으로 한 번 받는다
     * (`reminderLines`).
     */
    ...(open.length > 0
      ? [
          `다만 이 사람의 메일·캘린더 일정·시트처럼 계정을 연결해야 볼 수 있는 것은, 위에 그 도구가 없어도 못 본다고 답하기 전에 ${TOOL_SEARCH}로 한 번 찾는다 — 연결을 권할 길이 답에 온다.`,
        ]
      : []),
  ].join("\n");
}

/* ------------------------------------------------------------------------------------------ */
/* 다리 둘                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const TOOL_SEARCH = "tool_search";
export const TOOL_CALL = "tool_call";

/**
 * 다리는 둘이다: 찾기와 부르기. `tool_describe`가 셋째로 있었지만, Claude Code의 ToolSearch처럼
 * 찾기가 스키마 전부를 돌려주면 따로 볼 일이 없다 — 한 라운드와 매 턴의 툴 하나가 준다.
 */
export const BRIDGE_TOOL_NAMES = [TOOL_SEARCH, TOOL_CALL] as const;
export type BridgeToolName = (typeof BRIDGE_TOOL_NAMES)[number];

export function isBridgeToolName(name: string): name is BridgeToolName {
  return (BRIDGE_TOOL_NAMES as readonly string[]).includes(name);
}

export type BridgeTool = {
  name: BridgeToolName;
  description: string;
  parameters: JsonSchema;
};

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): JsonSchema => ({ type: "object", properties, required });

/** 한 번에 돌려주는 최대 개수. 스키마 전부가 오므로 다섯이면 한 서비스의 쓸 만한 것은 다 온다. */
export const SEARCH_LIMIT = 5;

/**
 * 다리 둘의 정의 — 정적이다. 어느 봇의 어느 대화에서도 바이트까지 같다.
 *
 * 설명에 이번 실행에 연결된 서비스가 덧붙던 것을 뺐다: 서비스 하나를 연결하면 툴 목록의 글이
 * 바뀌었고, 툴 목록은 프롬프트의 머리다. 무엇이 연결돼 있는지는 맥락 층이 말한다
 * (`deferredToolsText`).
 */
export const BRIDGE_TOOLS: readonly BridgeTool[] = [
  {
    name: TOOL_SEARCH,
    description:
      "목록에 없는 도구(연결된 서비스 — 지메일, 구글 시트, 캘린더, 카페24, 알림톡 같은 것 — 와 화면에 띄우는 카드)를 찾아 그 스키마 전부를 받는다. 하려는 일을 한국어나 영어로 적거나, 맥락에 적힌 이름을 'select:이름1,이름2'로 적는다. 받은 스키마대로 tool_call로 부른다.",
    parameters: object(
      {
        query: {
          type: "string",
          description:
            "하려는 일, 또는 select:이름. 예: '메일 보내기', '시트에 행 추가', 'select:mcp__gmail__send_message'",
        },
      },
      ["query"],
    ),
  },
  {
    name: TOOL_CALL,
    description:
      "tool_search로 스키마를 받은 도구를 부른다. 직접 부른 것과 똑같이 실행되고, 사람의 승인이 필요한 일은 똑같이 승인을 거친다.",
    parameters: object(
      {
        name: {
          type: "string",
          description: "부를 도구 이름. tool_search가 돌려준 이름 그대로",
        },
        args: {
          type: "object",
          description: "그 도구의 인자. tool_search가 돌려준 스키마대로",
        },
      },
      ["name", "args"],
    ),
  },
];

/* ------------------------------------------------------------------------------------------ */
/* 찾기                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * 영어 한 단어와 한국어 한 단어를 잇는 작은 표.
 *
 * 툴 이름은 영어(`send_message`)고 설명은 한국어("메일을 실제로 보낸다")다. 사람은 "메일 보내줘"
 * 라고도 "send email"이라고도 말하므로, 어느 쪽으로 물어도 양쪽에 닿아야 한다. 형태소 분석기를
 * 들이지 않는 대신 자주 쓰는 말 몇 개를 서로 잇는다. 없는 말은 그냥 부분 문자열로 찾는다.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  email: ["mail", "메일", "gmail"],
  mail: ["메일", "gmail"],
  이메일: ["mail", "메일", "gmail"],
  메일: ["mail", "gmail"],
  send: ["보내", "발송", "전송"],
  보내: ["send"],
  발송: ["send"],
  전송: ["send"],
  sheet: ["시트", "스프레드시트"],
  spreadsheet: ["sheet", "시트"],
  시트: ["sheet"],
  엑셀: ["sheet", "시트"],
  row: ["행"],
  행: ["row"],
  calendar: ["캘린더", "일정"],
  event: ["일정", "캘린더"],
  일정: ["event", "calendar"],
  캘린더: ["calendar"],
  약속: ["event", "일정"],
  order: ["주문"],
  주문: ["order"],
  product: ["상품"],
  상품: ["product"],
  review: ["리뷰", "후기"],
  리뷰: ["review"],
  후기: ["review"],
  file: ["파일"],
  파일: ["file"],
  drive: ["드라이브"],
  드라이브: ["drive"],
  document: ["문서", "file"],
  문서: ["document", "file"],
  kakao: ["알림톡", "카카오"],
  카카오: ["alimtalk", "알림톡"],
  알림톡: ["alimtalk"],
  문자: ["알림톡", "alimtalk"],
  template: ["서식"],
  서식: ["template"],
  draft: ["초안"],
  초안: ["draft"],
  search: ["찾", "검색"],
  find: ["찾", "검색"],
  검색: ["search", "find"],
  찾: ["search", "find"],
  read: ["읽"],
  읽: ["read"],
  list: ["목록", "나열"],
  목록: ["list"],
  reply: ["답글", "답장"],
  답글: ["reply"],
  답장: ["reply"],
  board: ["게시판", "게시글"],
  게시판: ["board"],
  status: ["상태"],
  상태: ["status"],
  배송: ["status", "ship"],
  chart: ["차트", "그래프"],
  차트: ["chart"],
  그래프: ["chart"],
  표: ["record", "metrics"],
  선택지: ["choice"],
  승인: ["approval"],
  /*
   * 화면 카드를 한국어로 찾는 말. 카드의 이름과 설명은 영어라(`showChecklist`, "Show a list of
   * things…"), 이 표에 없는 한국어는 하나도 닿지 않았다 — 봇은 "화면에 카드 띄우기", "카드
   * 보여주기"로 찾았고 다리는 맞는 도구가 없다고 답했다(2026-10-02, 여섯 번 중 네 번).
   * "카드"는 이름이 show로 시작하는 것 전부다. "보여"는 넣지 않는다: 무엇이든 보여 달라는 말에
   * 카드 다섯이 딸려 나온다.
   */
  카드: ["show"],
  건네: ["hand", "file"],
  내려받: ["download"],
  다운로드: ["download"],
  체크리스트: ["checklist"],
  진행: ["progress"],
  진척: ["progress"],
  인용: ["quote"],
  공지: ["notice"],
  지표: ["metrics"],
  연결: ["connection"],
  선택: ["choice"],
  허락: ["approval"],
});

/** 한국어 조사. 검색어 토큰 끝에 붙은 것 하나를 뗀다 — "시트에" → "시트". 긴 것부터. */
const PARTICLES = [
  "으로",
  "에서",
  "한테",
  "께서",
  "을",
  "를",
  "이",
  "가",
  "은",
  "는",
  "에",
  "의",
  "로",
  "도",
  "만",
  "와",
  "과",
  "께",
];

const isHangul = (text: string) => /^[가-힣]+$/.test(text);

/**
 * 한글 음절을 자모로 편다. "보내"가 "보낸다"에 닿게 하려고 — 음절로는 '내'와 '낸'이 다르지만
 * 자모로는 ㅂㅗㄴㅐ가 ㅂㅗㄴㅐㄴㄷㅏ의 앞부분이다. 한글이 아닌 글자는 그대로 둔다.
 */
function jamo(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0xac00 || code > 0xd7a3) {
      out += char;
      continue;
    }
    const index = code - 0xac00;
    const lead = Math.floor(index / 588);
    const vowel = Math.floor((index % 588) / 28);
    const tail = index % 28;
    out += String.fromCodePoint(0x1100 + lead, 0x1161 + vowel);
    if (tail > 0) out += String.fromCodePoint(0x11a7 + tail);
  }
  return out;
}

/**
 * 한국어 동사 어미. 검색어는 "보내줘", "추가해줘", "만들기"처럼 오고 설명은 "보낸다", "덧붙인다"
 * 처럼 쓰여 있다. 어미를 떼면 어간("보내", "추가", "만들")이 남고, 그것이 자모로 설명에 닿는다.
 * 긴 것부터. 실측: 이것이 없을 때 "메일 보내줘"는 create_draft와 send_message를 같은 점수로 봤다.
 */
const ENDINGS = [
  "해주세요",
  "해주십시오",
  "해줄래",
  "해줘요",
  "해줘",
  "하세요",
  "합니다",
  "해야",
  "하기",
  "할래",
  "할까",
  "해서",
  "하고",
  "하는",
  "한다",
  "주세요",
  "줄래",
  "줘요",
  "줘",
  "세요",
  "니다",
  "는다",
  "해",
  "기",
];

function withoutParticle(token: string): string {
  if (!isHangul(token) || token.length < 2) return token;
  for (const particle of PARTICLES) {
    if (token.endsWith(particle) && token.length > particle.length) {
      return token.slice(0, -particle.length);
    }
  }
  return token;
}

function withoutEnding(token: string): string {
  if (!isHangul(token) || token.length < 2) return token;
  for (const ending of ENDINGS) {
    if (token.endsWith(ending) && token.length > ending.length) {
      return token.slice(0, -ending.length);
    }
  }
  return token;
}

/**
 * 검색어의 토큰들, 그리고 조사와 어미를 뗀 꼴까지.
 *
 * 한 토큰이 여러 꼴로 들어가면 그 꼴마다 점수가 붙는다. 그것이 의도다: "보내줘"가 "보내"로도
 * 들어가야 이름의 send와 설명의 보낸다에 닿고, 조사가 붙은 "시트에"가 "시트"로도 들어가야
 * 이름의 sheet에 닿는다.
 */
function tokensOf(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query
    .toLowerCase()
    .split(/[\s,./()'"“”‘’·:;!?[\]{}]+/)
    .filter(Boolean)) {
    const forms = [raw, withoutParticle(raw), withoutEnding(raw)];
    forms.push(withoutEnding(withoutParticle(raw)));
    for (const form of forms) if (form) seen.add(form);
  }
  return [...seen];
}

/** 이름을 검색어에 닿는 글로: `mcp__gmail__send_message` → `gmail send message`. */
function nameText(name: string): string {
  return name
    .replace(DEFERRED_TOOL_PREFIX, "")
    .replaceAll("__", " ")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .toLowerCase();
}

function scoreOf(tool: WireTool, tokens: readonly string[]): number {
  const inName = nameText(tool.name);
  const inDescription = tool.description.toLowerCase();
  const descriptionJamo = jamo(inDescription);
  let score = 0;
  for (const token of tokens) {
    let hit = 0;
    if (inName.includes(token)) hit += 4;
    if (inDescription.includes(token)) hit += 2;
    else if (isHangul(token) && token.length >= 2) {
      // 활용형: "보내"는 "보낸다"에, "읽"은 "읽는다"에.
      if (descriptionJamo.includes(jamo(token))) hit += 2;
    }
    for (const alias of ALIASES[token] ?? []) {
      if (inName.includes(alias)) hit += 3;
      if (inDescription.includes(alias)) hit += 1;
    }
    score += hit;
  }
  return score;
}

/** 설명의 첫 문장, 한 줄로. 목록에서는 무엇을 하는지만 보이면 된다. */
export function oneLine(description: string): string {
  const first = description.split(/(?<=[.!?다])\s+/)[0] ?? description;
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

export type SearchHit = { name: string; description: string };

/** 검색어에 닿는 미뤄진 툴, 잘 맞는 순서로, 최대 `limit`개. 아무것도 닿지 않으면 빈 배열. */
export function searchTools(
  deferred: readonly WireTool[],
  query: string,
  limit = SEARCH_LIMIT,
): SearchHit[] {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return [];
  return deferred
    .map((tool) => ({ tool, score: scoreOf(tool, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(({ tool }) => ({
      name: tool.name,
      description: oneLine(tool.description),
    }));
}

/**
 * 이름 하나를 미뤄진 툴로 푼다.
 *
 * 정확한 이름이 먼저다. 접두사 없는 이름(`send_message`)은 그 이름을 가진 툴이 딱 하나일 때만
 * 받는다 — 지메일과 알림톡이 둘 다 `send`를 갖고 있을 때 아무거나 고르는 것이 이 다리가 해서는
 * 안 되는 유일한 일이다.
 */
export function resolveDeferred(
  deferred: readonly WireTool[],
  name: string,
): WireTool | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const exact = deferred.find((tool) => tool.name === wanted);
  if (exact) return exact;
  const bare = deferred.filter((tool) => bareNameOf(tool.name) === wanted);
  return bare.length === 1 ? (bare[0] ?? null) : null;
}

/* ------------------------------------------------------------------------------------------ */
/* 모델이 읽는 답                                                                              */
/* ------------------------------------------------------------------------------------------ */

const hitLine = (hit: SearchHit) => `- ${hit.name}: ${hit.description}`;

/** `select:a,b` 꼴의 검색어가 고른 이름들. 그 꼴이 아니면 null. */
function selectedNames(query: string): string[] | null {
  const match = /^\s*select\s*:(.*)$/is.exec(query);
  if (!match) return null;
  return (match[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** 툴 하나의 스키마 전부, 한 줄 JSON으로. 모델이 tool_call의 인자를 쓰는 근거다. */
function schemaLine(tool: WireTool): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    // 연결 카드에 턴이 적어 둔 계정의 상태는 다리가 읽는 것이고, 봇이 읽는 스키마에는 없다.
    parameters: withoutAccountStates(
      tool.parameters ?? { type: "object", properties: {} },
    ),
  });
}

/**
 * 다리로 찾았는데 이미 스키마에 실려 있는 툴을 이름으로 푼다 — 정확한 이름, 또는 연결된 서비스의
 * 이름 모양(`mcp__…`)인 것 가운데 접두사 없는 이름이 딱 하나일 때.
 */
export function resolveOffered(
  offered: readonly WireTool[],
  name: string,
): WireTool | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const exact = offered.find((tool) => tool.name === wanted);
  if (exact) return exact;
  const bare = offered.filter(
    (tool) =>
      tool.name.startsWith(DEFERRED_TOOL_PREFIX) &&
      bareNameOf(tool.name) === wanted,
  );
  return bare.length === 1 ? (bare[0] ?? null) : null;
}

/**
 * 찾은 것 가운데 다리 뒤가 아니라 이미 스키마에 있는 툴.
 *
 * 다리는 미뤄 둔 툴만 알았고, 그래서 스키마에 실린 툴을 찾으면 "맞는 도구가 없다"고 답했다 — 있는
 * 것을 없다고 한 것이다. 실측(2026-10-02, muse-spark, 로컬 스택): "KTX 요금 검색해서 알려줘"에 봇이
 * `tool_search("select:mcp__web-search__search")`를 불렀고(그 툴이 다리 뒤에 있던 때의 대화가
 * 기록에 남아 있었다), 없다는 답을 받고는 검색을 포기하고 브라우저로 네이버를 열었다. 검색이면
 * 6초인 답이 40초 걸렸다. 다리는 아무것도 숨기지 않는다는 것이 이 파일의 약속이니, 이미 가진 것을
 * 물으면 가졌다고, 찾지 말고 바로 부르라고 답한다.
 *
 * 이름으로 고른 것(`select:`)은 어떤 핵심 툴이든 받는다 — 이름은 모호하지 않다. 말로 찾은 것은
 * 연결된 서비스의 이름 모양인 핵심 툴(웹 검색, 날씨)과 파일 카드에서만 찾는다: 브라우저나 수첩 툴이 느슨한
 * 말에 걸려 "이미 있다"고 나오면 그것은 소음이다. 다리 뒤에서 무언가 찾았어도 함께 말한다 —
 * 지메일이 연결된 봇이 "웹 검색"을 찾으면 다리 뒤에서는 지메일의 메일 검색이 걸리고, 그것만
 * 돌려주면 봇은 웹을 지메일에서 찾는다.
 */
function alreadyOffered(
  deferred: readonly WireTool[],
  offered: readonly WireTool[],
  query: string,
  selected: string[] | null,
): WireTool[] {
  if (offered.length === 0) return [];
  if (selected) {
    const listed = selected
      .filter((name) => resolveDeferred(deferred, name) === null)
      .map((name) => resolveOffered(offered, name))
      .filter((tool): tool is WireTool => tool !== null);
    return [...new Set(listed)];
  }
  /*
   * 파일을 건네는 카드도 여기 든다. 화면 카드는 다리 뒤에 있는 것이 보통이라 봇은 카드를 다리로
   * 찾는다 — 그 하나가 스키마에 있다고 "맞는 도구가 없다"거나 엉뚱한 카드 넷만 돌려주면, 있는
   * 것을 없다고 한 그 답이다.
   */
  const sought = offered.filter(
    (tool) =>
      tool.name.startsWith(DEFERRED_TOOL_PREFIX) || tool.name === FILE_CARD,
  );
  return searchTools(sought, query)
    .map((hit) => sought.find((tool) => tool.name === hit.name))
    .filter((tool): tool is WireTool => tool !== undefined);
}

/** 이미 스키마에 있는 툴을 찾았을 때 모델이 읽는 줄들. 없으면 빈 배열. */
function offeredLines(listed: readonly WireTool[]): string[] {
  if (listed.length === 0) return [];
  return [
    "이미 목록에 있는 도구다. 찾지 않고, tool_call도 거치지 않고, 그 이름으로 바로 부른다:",
    ...listed.map((tool) =>
      hitLine({ name: tool.name, description: oneLine(tool.description) }),
    ),
  ];
}

/** 서비스 키들을 사람이 부르는 이름과 함께, 키 순으로: `구글 캘린더(google-calendar), 지메일(gmail)`. */
function namedByKey(keys: readonly string[]): string {
  return [...keys]
    .sort()
    .map((key) =>
      FAMILY_LABELS_KO[key] ? `${FAMILY_LABELS_KO[key]}(${key})` : key,
    )
    .join(", ");
}

/**
 * 연결할 수 있는 계정을 말하는 줄의 머리. 이 줄이 대화에 건네졌다는 것을 `describedToolNames`가
 * 이것으로 알아본다 — 같은 파일이 그 줄을 쓰므로 모양을 아는 곳도 여기 하나다.
 */
export const OPEN_ACCOUNTS_HEAD = "이 사람이 아직 연결하지 않은 계정: ";

/**
 * 이 사람이 연결할 수 있는데 아직 연결하지 않은 계정의 키들 — 이 실행이 받은 목록에서 읽는다.
 *
 * 둘 다여야 열려 있는 것이다: 턴이 연결 카드에 적은 상태가 "연결 안 됨"이고, 그 서비스의 도구가
 * 목록에 하나도 없다. 뒤의 조건은 턴 도중에 연결이 들어왔을 때를 위한 것이다(검토, 2026-10-06, 실제
 * 경로에서). 카드에 적힌 상태는 턴이 시작될 때 한 번 읽은 것인데, 사람이 카드에서 지메일을 켜면
 * 그 도구가 같은 턴의 목록에 더해진다(`offerLandedTools`, `server/src/turns/chat-tools.ts`). 카드의
 * 답이 "연결됐다, tool_search로 스키마를 받아 쓰라"고 해서 봇이 찾으면, 그 답의 끝에 "아직 연결하지
 * 않은 계정: 지메일(gmail)… 연결 카드를 띄운다"가 서 있었다 — 방금 연결한 계정이다. 도구가 여기
 * 있다는 것이 적어 둔 상태보다 새 사실이다.
 *
 * 맥락 층의 한 문장도 이것으로 정한다(`server/src/copilot.ts`): 열린 계정의 뜻은 하나다. 카드가
 * 없거나 적힌 것이 없으면 빈 배열.
 */
export function openAccountsIn(
  tools: readonly { name: string; parameters?: unknown }[],
): string[] {
  const card = tools.find((tool) => tool.name === CONNECT_CARD);
  const held = new Set(tools.map((tool) => serverKeyOf(tool.name)));
  return (accountStatesIn(card?.parameters) ?? [])
    .filter((account) => !account.connected && !held.has(account.key))
    .map((account) => account.key);
}

/**
 * 모든 검색의 답 끝에 서는 줄 — 이 사람이 연결할 수 있는데 아직 연결하지 않은 계정들, 사실로.
 *
 * 어느 서비스가 필요한 일인지도, 이 줄이 지금 쓸모 있는지도 다리가 고르지 않는다. 두 번 골랐고 두
 * 번 틀렸다(2026-10-05). 낱말 표로 골랐을 때는 "배송 일정 조회"에 구글 캘린더를, "카페 24시간"에
 * 카페24를 권했다. 그다음엔 "연결된 서비스의 도구가 걸렸으면 말하지 않는다"로 골랐는데, 지메일만
 * 연결한 사람의 "캘린더 일정 확인"에 지메일의 초안 쓰기가 "확인" 한 낱말로 걸려서 캘린더를 권할
 * 길이 사라졌다 — 서비스 하나만 연결한 사람의 일정 검색 마흔여덟 가운데 열여덟, 메일 검색 서른
 * 가운데 열다섯이 그랬다(검토). 그래서 남은 계정이 있는 사람에게는 언제나 같은 한 줄이 서고,
 * 그것이 지금 필요한지는 부탁을 읽은 모델이 정한다.
 *
 * 짧아야 한다: 차트 카드를 찾아도, 목표를 저장하려 해도 따라오는 줄이다. 그래서 연결 카드의
 * 스키마(천사백 자)는 싣지 않고, 부르는 모양 전부를 이 줄이 말한다 — 이름, 인자 하나와 그 값(괄호
 * 안의 키), 선택 인자 하나. 이 줄을 받은 대화는 카드를 곧바로 부를 수 있다(`describedToolNames`).
 * "tool_search 없이 바로"라고 적는 까닭: 맥락 층은 "쓰기 전에 tool_search로 스키마를 받으라"고
 * 하고, 그 말을 따른 봇은 이 줄을 받고도 `select:showConnection`부터 했다 — 여섯 번에 세 번, 요청
 * 하나씩을 더 썼다. 이 말이 있으면 쉰여덟 번에 한 번이다(2026-10-06).
 *
 * 사실은 서버가 연결의 상태에서 읽어 연결 카드에 적어 넘긴 것이다(`accountStatesIn`,
 * `./gallery.ts`): 목록에 그 서비스의 도구가 없다는 것으로 짐작하지 않는다. 연결돼 있는데 도구가
 * 하나도 오지 않은 계정은 그렇게 따로 말한다 — 그것을 "연결돼 있지 않다"고 하면 봇은 카드를
 * 띄우고, 카드는 이미 켜져 있다고 답하고, 봇은 다시 찾는다.
 *
 * 이름은 `FAMILY_LABELS_KO` 하나에서 온다. 사이트(배민, 스마트스토어…)는 여기 없다: 연결해도 도구가
 * 생기지 않고 봇은 브라우저로 그 일을 한다.
 *
 * 카드가 목록에 없거나(루틴에는 화면이 없다) 적힌 것이 없으면 빈 배열 — 연결할 사람이 없는
 * 자리에서는 연결 이야기를 하지 않는다. 같은 계정 상태에는 글자 하나까지 같은 줄이다.
 */
function connectingLines(deferred: readonly WireTool[]): string[] {
  const card = deferred.find((tool) => tool.name === CONNECT_CARD);
  const accounts = card ? accountStatesIn(card.parameters) : null;
  if (!card || !accounts) return [];
  const held = new Set(deferred.map((tool) => serverKeyOf(tool.name)));
  const open = openAccountsIn(deferred);
  const empty = accounts
    .filter((account) => account.connected && !held.has(account.key))
    .map((account) => account.key);
  return [
    ...(empty.length > 0
      ? [
          `연결돼 있지만 그 연결이 가져온 도구가 없는 계정: ${namedByKey(empty)}. 연결 카드를 띄우지 않는다 — 이것이 필요한 일이면 연결은 돼 있는데 지금 쓸 도구가 없다고 사람에게 말한다.`,
        ]
      : []),
    ...(open.length > 0
      ? [
          `${OPEN_ACCOUNTS_HEAD}${namedByKey(open)}. 부탁받은 일에 이 가운데 하나가 꼭 필요할 때만, 말로만 답하지 말고 ${TOOL_SEARCH} 없이 바로 ${TOOL_CALL}로 연결 카드를 띄운다 — name은 "${CONNECT_CARD}", args는 {"services":["괄호 안의 키"],"reason":"연결하면 해 줄 일 한 줄"}. 이 대화에서 이미 다음으로 미룬 연결은 다시 띄우지 않는다.`,
        ]
      : []),
  ];
}

const foundLine = (query: string, count: number) =>
  `'${query}'에 맞는 도구 ${count}개, 스키마 전부. 이 스키마대로 tool_call로 부른다.`;

/**
 * `tool_search`의 답: 맞는 툴의 스키마 전부 — Claude Code의 ToolSearch가 `<functions>`를 돌려주듯.
 * 이 답은 툴 결과로 대화에 남으니, 같은 대화에서 다시 찾을 필요가 없다. 못 찾았을 때는 무엇이
 * 연결돼 있는지를 말한다 — 지어내지 말라고.
 *
 * 이 사람이 연결할 수 있는 계정이 남아 있으면, 무엇을 찾았든 답의 끝에 그 계정들이 한 줄로 선다
 * (`connectingLines`). 찾은 것이 그 일에 맞는지, 계정이 필요한 일인지는 부탁을 읽은 모델이 안다.
 *
 * 같은 목록과 같은 검색어에는 글자 하나까지 같은 답이다. 답은 만들어질 때 한 번 정해져 대화에
 * 남는다.
 */
export function searchResultText(
  deferred: readonly WireTool[],
  query: string,
  offered: readonly WireTool[] = [],
): string {
  const selected = selectedNames(query);
  const found = selected
    ? selected
        .map((name) => resolveDeferred(deferred, name))
        .filter((tool): tool is WireTool => tool !== null)
    : searchTools(deferred, query)
        .map((hit) => deferred.find((tool) => tool.name === hit.name))
        .filter((tool): tool is WireTool => tool !== undefined);
  const listed = alreadyOffered(deferred, offered, query, selected);
  const connecting = connectingLines(deferred);
  if (found.length > 0) {
    return [
      foundLine(query, found.length),
      ...found.map(schemaLine),
      ...offeredLines(listed),
      ...connecting,
    ].join("\n");
  }
  if (listed.length > 0) {
    return [...offeredLines(listed), ...connecting].join("\n");
  }
  /*
   * 다시 찾으라는 말은 사람이 연결한 서비스가 있을 때만 한다. 연결한 것이 없으면 다리 뒤에는 맥락에
   * 이름이 다 적힌 것(화면 카드, 목표, 플릿의 키로 도는 것)뿐이라, 다른 말로 찾아도 같은 빈손이고
   * 한 라운드만 더 든다.
   */
  const names = deferred.map((tool) => tool.name);
  const again = connectedFamiliesOf(names).length > 0;
  return [
    `'${query}'에 맞는 도구가 없다.`,
    deferredFamiliesLine(names),
    again
      ? "다른 말로 다시 찾아 본다. 그래도 없으면 지금 쓸 수 있는 도구로 하거나, 할 수 없다고 사람에게 말한다."
      : "다시 찾지 않는다. 지금 쓸 수 있는 도구로 하거나, 할 수 없다고 사람에게 말한다.",
    ...connecting,
  ].join("\n");
}

/**
 * 이 대화에서 스키마가 이미 건네진 미뤄진 툴의 이름들 — `tool_search`의 답이 툴 결과로 남긴
 * `schemaLine` 줄을 읽는다. 같은 파일이 그 줄을 쓰므로 모양을 아는 곳도 여기 하나다.
 *
 * 연결 카드는 그 줄 없이도 건네진 것으로 본다 — 남은 계정을 말하는 줄(`OPEN_ACCOUNTS_HEAD`)이
 * 대화에 있으면. 스키마를 받기 전의 호출을 전달하지 않는 규칙이 막는 것은 짐작한 인자다
 * (`undescribedToolText`: 알림톡을 이름만 보고 불러 `template` 대신 `templateCode`를 보낸 일). 그
 * 줄은 카드를 부르는 모양 전부를 말한다 — 이름, 필수 인자 하나, 그 값이 될 키들 — 그러니 그 줄을
 * 받고 부른 것은 짐작이 아니다. 그리고 카드는 받은 키를 서버가 제 연결 화면과 견줘, 띄울 것이
 * 없으면 그 자리에서 없다고 답한다(`connectCard`, `server/src/turns/chat-tools.ts`). 규칙은 그대로
 * 하나다: 모양을 들은 대화만 부른다.
 */
export function describedToolNames(results: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of results) {
    for (const line of text.split("\n")) {
      if (line.startsWith(OPEN_ACCOUNTS_HEAD)) {
        names.add(CONNECT_CARD);
        continue;
      }
      if (!line.startsWith('{"name":')) continue;
      try {
        const parsed = JSON.parse(line) as {
          name?: unknown;
          parameters?: unknown;
        };
        if (
          typeof parsed.name === "string" &&
          parsed.parameters !== undefined
        ) {
          names.add(parsed.name);
        }
      } catch {
        // 스키마 줄이 아니다.
      }
    }
  }
  return names;
}

/**
 * 스키마를 받지 않고 부른 미뤄진 툴의 답: 그 툴의 스키마 전부와, 그대로 다시 부르라는 말.
 *
 * 왜 전달하지 않는가(Claude Code를 따른다 — 미뤄 둔 툴은 ToolSearch로 스키마를 받기 전에는 부를
 * 수 없고, 부르면 먼저 받으라는 오류가 온다). 맥락 층에는 이름만 있으니, 스키마 없이 부른 인자는
 * 짐작이다. 실측(MiMo-V2.6-Pro, 2026-09-25): 알림톡을 `tool_search` 없이 이름으로 바로 불러
 * `template` 대신 `templateCode`를 보냈고, `variables`는 여섯 번 중 네 번 JSON 문자열이었다. 그
 * 호출은 표면에 가서 서버의 인자 검사에 걸리고(`laf:tool_arguments_invalid`), 한 번 더 도는 값을
 * 치른다. 여기서 답하면 같은 실행 안에서 한 라운드로 끝나고, 사람 앞에는 아무것도 가지 않는다.
 */
export function undescribedToolText(
  deferred: readonly WireTool[],
  name: string,
): string {
  const tool = resolveDeferred(deferred, name);
  if (!tool) return unknownToolText(deferred, name);
  return [
    `'${tool.name}'의 스키마를 이 대화에서 아직 받지 않아서 부르지 않았다. 인자 이름을 짐작하지 말고, 아래 스키마의 이름과 타입 그대로 다시 부른다.`,
    schemaLine(tool),
  ].join("\n");
}

/**
 * 스키마가 객체나 배열이라고 한 최상위 인자가 JSON 문자열로 왔을 때, 그 문자열을 풀어 그 타입이
 * 되면 푼 값으로 바꾼다. 풀리지 않거나 다른 타입이 되면 그대로 둔다 — 서버의 검사가 답한다.
 *
 * 왜: OpenAI 호환 모델이 중첩 객체를 한 번 더 문자열로 싸는 것은 흔한 실수이고(실측: MiMo가 알림톡
 * `variables`를 `"{\"#{상호}\": …}"`로), 그 문자열이 뜻하는 값은 모호하지 않다. 스키마가 타입을
 * 말하고 파싱이 그 타입을 돌려줄 때만 바꾸므로, 문자열이어야 하는 인자는 절대 건드리지 않는다.
 */
export function coerceStringifiedArguments(
  parameters: unknown,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties =
    parameters && typeof parameters === "object"
      ? (parameters as { properties?: unknown }).properties
      : undefined;
  if (!properties || typeof properties !== "object") return args;
  let changed = false;
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const declared = (properties as Record<string, { type?: unknown }>)[key]
      ?.type;
    if (declared !== "object" && declared !== "array") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      const isArray = Array.isArray(parsed);
      const fits =
        declared === "array"
          ? isArray
          : parsed !== null && typeof parsed === "object" && !isArray;
      if (!fits) continue;
      out[key] = parsed;
      changed = true;
    } catch {
      // 풀리지 않는 문자열은 그대로 — 서버가 답한다.
    }
  }
  return changed ? out : args;
}

function unknownToolText(deferred: readonly WireTool[], name: string): string {
  const near = searchTools(deferred, bareNameOf(name), 5);
  return [
    `'${name}'이라는 도구는 없다. tool_search가 돌려준 이름을 그대로 쓴다.`,
    ...(near.length > 0 ? ["비슷한 이름:", ...near.map(hitLine)] : []),
  ].join("\n");
}

export type UnwrappedCall =
  | {
      ok: true;
      name: string;
      args: Record<string, unknown>;
      /** 다리 뒤가 아니라 이미 스키마에 있는 툴이었다 — 스키마를 받았는지 물을 것이 없다. */
      offered?: WireTool;
    }
  | { ok: false; text: string };

/**
 * `tool_call`의 인자를 실제 호출로 푼다.
 *
 * 인자는 있는 그대로 넘긴다. 검사는 서버의 것이다 — 여기서 한 번 더 거르면 거절이 두 곳에서
 * 나서 어느 쪽이 답했는지 알 수 없게 된다(`standard-schema.ts`의 같은 이유).
 */
export function unwrapToolCall(
  deferred: readonly WireTool[],
  args: unknown,
  offered: readonly WireTool[] = [],
): UnwrappedCall {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      text: "tool_call에는 name(도구 이름)과 args(인자 객체)가 필요하다.",
    };
  }
  const { name, args: inner } = args as { name?: unknown; args?: unknown };
  if (typeof name !== "string" || !name.trim()) {
    return {
      ok: false,
      text: "tool_call에는 name(도구 이름)이 필요하다. tool_search로 먼저 찾는다.",
    };
  }
  /*
   * 다리 뒤에 없으면 스키마에 이미 실린 툴인지 본다. 그것을 tool_call로 부른 것은 돌아서 온 것일
   * 뿐 틀린 호출이 아니다 — 스키마는 요청의 머리에 있고, 실제 이름으로 바꿔 넘기면 직접 부른 것과
   * 같은 길을 간다. "그런 도구는 없다"고 답하면 있는 것을 없다고 하는 것이다(`alreadyOffered`).
   */
  const behind = resolveDeferred(deferred, name);
  const inSchema = behind ? null : resolveOffered(offered, name);
  const tool = behind ?? inSchema;
  if (!tool) return { ok: false, text: unknownToolText(deferred, name) };
  /*
   * 객체가 아닌 args는 거절한다. 조용히 `{}`로 바꿔 넘기던 것을 고쳤다(감사 2026-09-10): 모델이
   * args를 JSON 문자열로 보내는 흔한 실수가 서버에서 "X가 빠졌다"로 돌아와서, 모델은 args가
   * 객체여야 한다는 것을 끝내 읽지 못하고 같은 실수를 반복했다. 없는 것은 `{}` — 인자가 없는
   * 툴이 있다 — 이고, 있는데 객체가 아닌 것은 잘못이다.
   */
  if (inner !== undefined && inner !== null) {
    if (typeof inner !== "object" || Array.isArray(inner)) {
      return {
        ok: false,
        text: 'tool_call의 args는 JSON 객체여야 한다 — 문자열이나 배열이 아니라 {"필드": 값} 꼴로.',
      };
    }
  }
  const forwarded = (inner ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    name: tool.name,
    args: forwarded,
    ...(inSchema ? { offered: inSchema } : {}),
  };
}
