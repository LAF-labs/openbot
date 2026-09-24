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
 * 컴퓨터 툴, 자기 툴, `skill_view`, `routine_note`, `now`, 그리고 다리 둘. 그 밖의 모든 것은 다리
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
  NOW_TOOL_NAME,
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
    "kakao-alimtalk": "카카오 알림톡",
    "public-data": "나라장터·기업마당",
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

/** 이번 실행에 실제로 연결된 서비스들을 말하는 한 줄. 검색이 빈손일 때의 답에 쓴다. */
export function deferredFamiliesLine(names: readonly string[]): string {
  const families = familiesOf(names);
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
export function deferredToolsText(names: readonly string[]): string {
  const deferred = [...new Set(names.filter(isDeferredToolName))].sort();
  if (deferred.length === 0) return "";
  const groups = new Map<string, string[]>();
  for (const name of deferred) {
    const family = familyOf(name);
    groups.set(family, [...(groups.get(family) ?? []), name]);
  }
  return [
    `목록에 없는 도구도 쓸 수 있다. 아래는 이름뿐이니, 쓰기 전에 ${TOOL_SEARCH}로 스키마를 받고 ${TOOL_CALL}로 부른다:`,
    ...[...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([family, members]) => `- ${family}: ${members.join(", ")}`),
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
    parameters: tool.parameters ?? { type: "object", properties: {} },
  });
}

/**
 * `tool_search`의 답: 맞는 툴의 스키마 전부 — Claude Code의 ToolSearch가 `<functions>`를 돌려주듯.
 * 이 답은 툴 결과로 대화에 남으니, 같은 대화에서 다시 찾을 필요가 없다. 못 찾았을 때는 무엇이
 * 연결돼 있는지를 말한다 — 지어내지 말라고.
 */
export function searchResultText(
  deferred: readonly WireTool[],
  query: string,
): string {
  const selected = selectedNames(query);
  const found = selected
    ? selected
        .map((name) => resolveDeferred(deferred, name))
        .filter((tool): tool is WireTool => tool !== null)
    : searchTools(deferred, query)
        .map((hit) => deferred.find((tool) => tool.name === hit.name))
        .filter((tool): tool is WireTool => tool !== undefined);
  if (found.length > 0) {
    return [
      `'${query}'에 맞는 도구 ${found.length}개, 스키마 전부. 이 스키마대로 tool_call로 부른다.`,
      ...found.map(schemaLine),
    ].join("\n");
  }
  return [
    `'${query}'에 맞는 도구가 없다.`,
    deferredFamiliesLine(deferred.map((tool) => tool.name)),
    deferred.length > 0
      ? "다른 말로 다시 찾아 본다. 그래도 없으면 그 일은 지금 쓸 수 있는 도구로는 할 수 없다고 사람에게 말한다."
      : "그 일은 지금 쓸 수 있는 도구로는 할 수 없다고 사람에게 말한다.",
  ].join("\n");
}

function unknownToolText(deferred: readonly WireTool[], name: string): string {
  const near = searchTools(deferred, bareNameOf(name), 5);
  return [
    `'${name}'이라는 도구는 없다. tool_search가 돌려준 이름을 그대로 쓴다.`,
    ...(near.length > 0 ? ["비슷한 이름:", ...near.map(hitLine)] : []),
  ].join("\n");
}

export type UnwrappedCall =
  | { ok: true; name: string; args: Record<string, unknown> }
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
  const tool = resolveDeferred(deferred, name);
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
  return { ok: true, name: tool.name, args: forwarded };
}
