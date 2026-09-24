/**
 * 봇이 읽는 시스템 메시지 하나를, 한 곳에서 조립한다.
 *
 * 부르는 곳은 `server/src/copilot.ts`의 미들웨어 하나뿐이다. 그것이 이 제품에서 모든 실행이
 * 지나가는 유일한 이음새라서다 — 대화도, 루틴도. `agent-bot`은 자기
 * 프롬프트를 더 이상 갖지 않는다: 서버가 조립한 이 메시지가 프롬프트의 전부이고, 그 서비스는
 * 받은 것을 그대로 모델에게 넘기는 멍청한 종단으로 남는다. 두 곳이 프롬프트를 가지면 둘 중
 * 어느 쪽이 실제로 읽히는지 아무도 모르게 된다.
 *
 * 두 층이다(2026-09-25, Claude Code를 따라 — `~/laf/docs/agent-harness-design.md`):
 *
 *  1. **정적 층** (`staticPrompt`) — 기본 규칙, 알림과 시각을 다루는 법, 이번 모드. 배포와 모드가
 *     같으면 바이트까지 같다. 툴 목록 바로 뒤에 서서, 툴과 함께 모든 대화가 캐시에서 나눠 읽는
 *     앞부분이 된다. 분마다, 날마다, 사람이 무엇을 고칠 때마다 바뀌는 것은 여기 하나도 없다.
 *  2. **맥락 층** (`contextLayerText`, `./context.ko.ts`) — 이 봇의 이름·직무·가게·위치·시간대·
 *     날짜·기억·스킬. 에포크마다 한 번 그려지고 서버가 대화마다 얼린다. 에포크 중에 바뀐 것은
 *     사람의 새 메시지 끝에 `<알림>`으로 붙는다.
 *
 * 시각은 어디에도 없다. 매분 바뀌던 시계 줄(`nowLine`)이 이 메시지의 끝, 대화 전체의 앞에 있었고,
 * 일주일 된 대화(~39K 토큰, 2분 간격)에서 캐시로 읽힌 몫이 Wafer 0%·Z.AI 10%였다
 * (agent-harness-review §4.3). 날짜는 맥락 층과 날짜 알림이, 시각은 `now` 툴이 나른다.
 *
 * 모드가 정적 층에 선 이유도 캐시다. 모드는 대화마다 정해져 있고(대화와 루틴은 한 대화를 나누지
 * 않는다) 바뀌지 않으므로 앞에 서도 된다. 전에는 신원과 기억 뒤에 서서 "부딪히면 모드가 이긴다"를
 * 순서로 말했는데, 모드의 문단들은 신원이나 기억과 부딪히지 않는다(부를 사람이 있는가, 답은 누가
 * 읽는가).
 */
import type { ShopProfile } from "../shop/catalogue";
import { BASE_KO } from "./base.ko";
import {
  CONTEXT_RULES_KO,
  type ContextFacts,
  contextFactsOf,
  contextLayerText,
} from "./context.ko";
import { CHAT_KO } from "./mode/chat.ko";
import { ROUTINE_KO } from "./mode/routine.ko";
import { notepadText, type RoutineNote } from "./notepad.ko";
import { type PromptPerson, placeText } from "./person.ko";
import { shopText } from "./shop.ko";
import { deferredToolsText } from "../tools/bridge";
import { type PromptSkill, skillIndexText } from "./skill-index";

export { BASE_KO } from "./base.ko";
export {
  CONTEXT_RULES_KO,
  type ContextFacts,
  clockText,
  contextFactsOf,
  contextLayerText,
  knownFacts,
  REMINDER_CLOSE,
  REMINDER_OPEN,
  reminderBlock,
  reminderLines,
  routineRunLine,
  withReminder,
  ANSWER_NOW_KO,
  answerNowText,
} from "./context.ko";
export {
  NOTEPAD_MAX_BYTES,
  NOTEPAD_MAX_KEYS,
  notepadBytes,
  notepadOf,
  notepadText,
  type RoutineNote,
} from "./notepad.ko";
export { copula } from "./particles";
export { type PromptPerson, placeText } from "./person.ko";
export { shopText } from "./shop.ko";
export { type PromptSkill, skillIndexText } from "./skill-index";
export { TOOL_RESULT_KO } from "./tool-results.ko";
export {
  DEFAULT_TIME_ZONE,
  dayLabel,
  isKnownTimeZone,
  resolveTimeZone,
  zoneLabel,
} from "./zone";

/**
 * 실행이 벌어지는 자리. `forwardedProps.mode`로 오고, 아무 말이 없으면 대화다.
 *
 * 둘뿐이다. 방(봇 여럿의 대화)과 동료 봇의 질문은 2026-09-24에 사람의 봇이 하나가 되면서 지워졌다
 * (docs/laf/deployment-model.md "봇은 하나다"). 옛 클라이언트가 그 이름을 보내면 모르는 값이고,
 * 모르는 값은 대화다.
 */
export type PromptMode = "chat" | "routine";

const MODES: readonly PromptMode[] = ["chat", "routine"];

/**
 * 조립에 쓰이는 봇의 신원 — 이름뿐이다.
 *
 * 직함(`title`)이 있었다. 2026-09-24부터 봇의 프로필은 이름과 얼굴이 전부라서(docs/laf/
 * deployment-model.md "봇은 하나다") 사람이 직함을 쓸 곳도 볼 곳도 없다. 볼 수 없는 칸이 봇에게
 * "너는 무엇이다"라고 말하게 둘 수는 없으므로, 이미 적혀 있는 직함도 더는 읽지 않는다. 행에는
 * 남는다(지우는 것은 사람의 결정이다).
 */
export type PromptBot = {
  id: string;
  name: string;
};

export type ComposePromptInput = {
  mode: PromptMode;
  /** 서버 시계. 날짜만 읽힌다 — 시각은 프롬프트에 없다. */
  now: Date;
  /** 배포의 시간대. 사장님의 것을 모를 때 쓴다. */
  timeZone?: string;
  bot: PromptBot;
  /**
   * 사람이 대화로 맡긴 이 봇의 상시 직무 — 봇이 `update_profile`로 적어 둔 것. 비어 있는 것이
   * 정상이다: 봇은 하나이고 무엇을 시킬지는 적어 두지 않는다. 채팅이 전부다.
   */
  standingRole?: string;
  /**
   * 사람이 고른 가게의 일과 매일 쓰는 곳. 봇 하나가 아니라 사람의 것이라 그 사람의 모든 봇이 같은
   * 줄을 읽는다. 비어 있거나 없으면 아무 줄도 없다.
   */
  shop?: ShopProfile;
  /** 이 봇이 이 사람에 대해 알아낸 것, 오래된 것부터. */
  memories?: readonly string[];
  /** 이 봇에게 허용된 스킬. 이름과 한 줄만 — 본문은 skill_view가 읽는다. */
  skills?: readonly PromptSkill[];
  /** 루틴의 메모장. 루틴 모드에서만 실린다 — 다른 자리에서 온 것은 그리지 않는다. */
  notepad?: readonly RoutineNote[];
  /**
   * 사장님의 시간대·언어·위치(`person.ko.ts`). 시간대가 있으면 날짜는 그것으로 읽힌다 — 위의
   * `timeZone`은 사장님의 것을 모를 때 쓰는 배포의 시간대다.
   */
  person?: PromptPerson;
  /**
   * 이번 실행이 받은 툴 이름 전부. 다리 뒤에 설 것만 맥락 층에 이름으로 그려진다
   * (`deferredToolsText`) — 핵심 툴은 툴 목록에 이미 있다.
   */
  toolNames?: readonly string[];
};

/** 이번 실행의 자리에만 해당하는 부분. */
export function modeText(mode: PromptMode): string {
  return mode === "routine" ? ROUTINE_KO : CHAT_KO;
}

/** `forwardedProps`가 말한 자리. 모르는 값과 침묵은 둘 다 대화다. */
export function promptModeOf(forwardedProps: unknown): PromptMode {
  if (!forwardedProps || typeof forwardedProps !== "object") return "chat";
  const named = (forwardedProps as Record<string, unknown>).mode;
  return MODES.includes(named as PromptMode) ? (named as PromptMode) : "chat";
}

/**
 * 정적 층 — 배포와 모드가 같으면 모든 대화, 모든 요청에서 바이트까지 같은 글.
 *
 * 툴 목록 바로 뒤에 서므로, 툴과 이것이 모든 대화가 공급자의 캐시에서 나눠 읽는 앞부분이다.
 */
export function staticPrompt(mode: PromptMode): string {
  return [BASE_KO, CONTEXT_RULES_KO, modeText(mode)].join("\n\n");
}

/**
 * 평가 보고서가 해시로 남기는 뼈대. 이제 정적 층 그대로다 — 시계와 기억은 여기에 없다.
 */
export function promptSkeleton(mode: PromptMode): string {
  return staticPrompt(mode);
}

/**
 * 직무가 비어 있을 때의 문단 — 이제 대부분의 봇이 읽는 문단이다.
 *
 * 예전 문단은 "너는 방금 만들어졌고, 무엇을 하는 봇인지 아직 아무도 말해 주지 않았다. 한 줄로
 * 자신을 소개하고 무엇을 도와주면 좋을지 물어라"였다. 직무를 적는 칸이 있고 봇이 여럿이던 때에는
 * 빈 직무가 잠깐 거치는 상태였다. 2026-09-24부터는 봇이 하나이고 직무 칸이 없으므로 빈 직무가
 * 평상시다 — 그 문단을 그대로 두면 백 번째 대화에서도 봇이 "방금 만들어졌다"고 믿고 매번 자기
 * 소개부터 한다. 그래서 이 문단은 사실을 말한다: 정해진 직무는 없고, 이 사람이 대화로 맡기는 일이
 * 네 일이다. 앞으로 계속 맡길 일을 들으면 적어 두는 길(`update_profile`)은 그대로 남는다.
 */
export function unassignedRoleText(mode: PromptMode): string {
  return [
    "정해 둔 직무는 없다 — 이 사람이 대화로 맡기는 일이 곧 네 일이다.",
    mode === "chat"
      ? "이 사람이 앞으로 계속 맡길 일을 말하면 update_profile로 네 설명에 적어 두어 다음에도 알고 있게 하라."
      : "이 사람이 맡긴 일을 해라.",
  ].join(" ");
}

/**
 * 이번 실행이 아는 사실들, 맥락 층에 그려질 글로. 에포크가 이것을 얼리고 알림이 이것끼리 견준다.
 *
 * 가게와 위치는 사람의 것이다 — 가게는 사람이 눌러서 고른 답이고 위치는 모를 때도 한 줄이 선다:
 * 모른다고 말해야 봇이 사이트의 짐작으로 빈칸을 메우지 않는다.
 */
export function contextFactsFor(input: ComposePromptInput): ContextFacts {
  const role = input.standingRole?.trim();
  return contextFactsOf({
    mode: input.mode,
    now: input.now,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    name: input.bot.name,
    role: role || unassignedRoleText(input.mode),
    shop: shopText(input.shop),
    place: placeText(input.person, input.mode),
    ...(input.memories ? { memories: input.memories } : {}),
    skills: skillIndexText(input.skills ?? []),
    tools: deferredToolsText(input.toolNames ?? []),
    ...(input.person ? { person: input.person } : {}),
  });
}

/**
 * 루틴의 메모장, 그려진 글로 — 루틴에서만. 대화에 메모장이 실려 오면 그것은 루틴이 아닌 누군가가
 * 보낸 것이고, 거기서 그리면 루틴의 커서가 대화의 "사실"이 된다.
 */
export function notepadLayerText(
  mode: PromptMode,
  notepad: readonly RoutineNote[] | undefined,
): string {
  return mode === "routine" ? notepadText(notepad ?? []) : "";
}

/** 두 층을 한 시스템 메시지로. */
export function systemPromptText(
  mode: PromptMode,
  contextLayer: string,
): string {
  return [staticPrompt(mode), contextLayer].filter(Boolean).join("\n\n");
}

/**
 * 새 에포크의 시스템 메시지 전문 — 지금의 사실로 그린 맥락 층을 정적 층 뒤에.
 *
 * 서버의 미들웨어는 이것을 에포크가 시작될 때 한 번 부르고 얼린다. 대화 기록이 없는 곳(테스트,
 * 평가)에서는 부를 때마다 새 에포크다.
 */
export function composePrompt(input: ComposePromptInput): string {
  return systemPromptText(
    input.mode,
    contextLayerText(
      contextFactsFor(input),
      notepadLayerText(input.mode, input.notepad),
    ),
  );
}
