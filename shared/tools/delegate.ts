/**
 * 맡기는 툴 — 대화하는 쪽이 일 하나를 통째로 넘긴다 (docs/laf/redesign-2026-10.md §4, 조각 6-2).
 *
 * 브라우저를 다루는 툴은 열한 개이고, 대화의 머리에 실려 모든 턴이 그 값을 낸다. 브라우징을
 * 맡기면 대화의 머리에는 이 하나만 남고, 열한 개는 맡은 쪽의 대화에만 실린다. 맡은 쪽은 같은
 * 봇이고 같은 컴퓨터를 쓰지만 자기 대화를 따로 가진다: 맡긴 쪽의 대화를 보지 못하고 `task`의
 * 글만 읽는다. 그래서 설명의 절반이 "무엇을 적어야 하는가"다.
 *
 * `to`는 값으로 는다 — 툴을 하나 더 싣는 대신이다(§4 "위임 도구 하나가 남는다").
 *
 * `think`(조각 6-3): 깊이 따질 일을 맡는 쪽. 같은 봇이 새 대화에서 툴 없이 생각만 하고, 얼마나
 * 깊게 생각하는지는 서버가 그 모드에만 정한다(`server/src/copilot.ts`, `shared/fixed-effort.ts`의
 * `DEEP_EFFORT`) — 사람도 봇도 정하지 못한다. 봇이 고르는 것은 "이 일을 맡길까" 하나다. 그래서
 * 설명의 나머지 절반이 "언제 맡기지 않는가"다: 바로 답할 수 있는 것까지 맡기면 대화의 모든 답이
 * 요청 둘이 되고 수십 초가 는다. 백그라운드 일은 아직 값이 아니다(§4의 6-3 메모).
 */
import { COMPUTER_TOOLS, drivesTheBrowser } from "./computer";
import type { JsonSchema } from "./standard-schema";

/** 맡을 수 있는 쪽: 브라우저로 하는 일, 그리고 깊이 따지는 일. */
export const DELEGATE_TARGETS = ["browser", "think"] as const;

export type DelegateTarget = (typeof DELEGATE_TARGETS)[number];

/**
 * 맡은 쪽이 도는 모드 — 그 실행이 자기 자리를 읽는 글의 이름(`shared/prompt/mode/`).
 *
 * 맡은 쪽의 대화도 모드마다 하나다(`server/src/turns/engine.ts`의 `delegatedThreadOf`): 머리(툴과
 * 글)가 모드마다 다르고 공급자의 캐시는 대화 단위라서, 한 대화에 두 머리를 번갈아 실으면 둘 다
 * 매번 정가를 낸다.
 */
export const DELEGATED_MODES = {
  browser: "browse",
  think: "think",
} as const satisfies Record<DelegateTarget, string>;

export type DelegatedMode = (typeof DELEGATED_MODES)[DelegateTarget];

export const DELEGATE: {
  name: string;
  description: string;
  parameters: JsonSchema;
} = {
  name: "delegate",
  description:
    "일 하나를 통째로 맡긴다. 맡을 쪽은 둘이다. browser: 네 컴퓨터의 브라우저로 해야 하는 일. 웹 페이지를 열어 보고, 찾고, 누르고, 입력하고, 로그인하고, 파일을 올리는 일은 전부 이것으로 한다 — 보라·열어라·확인해라·들어가 봐라·찾아봐라는 말을 들으면 이것을 부른다. 사람에게 물어야 하는 것 — 비밀번호 같은 값, 되돌릴 수 없는 일의 허락 — 은 맡은 쪽이 직접 묻는다. think: 깊이 따져야 답이 나오는 일. 조건이 여럿 얽힌 계산, 여러 안의 비교, 순서를 짜는 계획처럼 한 번에 답하면 틀리기 쉬운 것을 맡긴다. 맡은 쪽은 툴 없이 생각만 하므로, 알아봐야 하는 것이 있으면 먼저 알아본 뒤에 맡긴다. 바로 답할 수 있는 것은 맡기지 않는다. 어느 쪽이든 맡은 쪽은 이 대화를 보지 못하고 task의 글만 읽는다. 그래서 task에는 무엇을 어디서 하는지, 무엇을 알아 오거나 따져야 하는지, 어떤 모양의 답을 돌려받고 싶은지를 빠짐없이 적는다. 끝나면 한 일과 알아낸 것이 글로 돌아오고, 사람에게는 네가 그 글로 답한다.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        enum: [...DELEGATE_TARGETS],
        description:
          "맡을 쪽. browser는 네 컴퓨터의 브라우저로 하는 일, think는 툴 없이 깊이 따져 보는 일이다.",
      },
      task: {
        type: "string",
        description:
          "맡기는 일의 전부. 이 글만 읽고 해낼 수 있게 쓴다: 주소나 사이트, 찾을 것, 따져 볼 숫자와 조건 전부, 사람이 한 말 가운데 필요한 것, 돌려받을 답의 모양.",
      },
    },
    required: ["to", "task"],
  },
};

/**
 * 브라우징을 맡기는 대화의 봇이 컴퓨터의 것 가운데 드는 것: 폴더의 셋과 `delegate`.
 *
 * 한 군데다. 서버가 턴에 주는 목록(`server/src/turns/chat-tools.ts`)과 모델 평가가 "대화하는
 * 봇이 받는 것"이라고 부르는 목록(`evals/deferral.ts`)이 이것을 함께 읽는다 — 평가가 제품이 주지
 * 않는 목록을 재면, 통과는 아무것도 말하지 않는다.
 */
export const CONVERSATION_COMPUTER_TOOLS: readonly {
  name: string;
  description: string;
  parameters: JsonSchema;
}[] = [
  ...COMPUTER_TOOLS.filter((tool) => !drivesTheBrowser(tool.name)),
  DELEGATE,
];

/** `to`로 온 값이 맡을 수 있는 쪽인가. */
export function delegateTargetOf(value: unknown): DelegateTarget | undefined {
  return DELEGATE_TARGETS.find((target) => target === value);
}

/**
 * 맡은 쪽이 남긴 메시지의 표시 — 그 메시지가 어느 `delegate` 호출을 위해 쓰였는지.
 *
 * 맡은 쪽의 걸음(연 페이지, 누른 것, 그 사이에 한 말)은 맡긴 쪽의 대화에 그대로 남는다: 사람이
 * 보는 화면 — 사이트 줄, 화면 보기, 한 일, 승인과 비밀번호 카드 — 은 전부 대화의 메시지에서
 * 그려지고, 카드는 자기를 물은 호출의 줄 위에 선다. 그런데 맡긴 쪽의 모델은 그 걸음을 읽지
 * 않는다: 읽으면 브라우저 툴을 뺀 까닭(머리의 값)이 기록의 값으로 돌아온다. 그래서 표시가
 * 있는 메시지는 화면에는 가고 봇에게는 가지 않는다(`server/src/turns/engine.ts`).
 */
export type DelegatedMark = {
  /** 이 메시지를 낳은 `delegate` 호출의 id. 맡긴 쪽이 직접 쓴 메시지에는 없다. */
  lafDelegated?: string;
};

/** 맡은 쪽이 남긴 메시지인가. */
export function isDelegated(message: object): boolean {
  return typeof (message as DelegatedMark).lafDelegated === "string";
}
