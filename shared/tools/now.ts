/**
 * 봇의 `date` — 사장님 시계로 지금이 몇 시인지 보는 툴 하나.
 *
 * 왜 툴인가. 시각은 프롬프트에 둘 수 없다. 시스템 메시지는 대화 전체의 앞에 서고, 공급자는
 * 프롬프트를 앞에서부터 같은 만큼만 캐시에서 읽는다 — 매분 바뀌는 한 줄이 거기 있으면 그 뒤의
 * 대화 전부가 매 턴 제값을 치른다. 실측(2026-09-24, ~39K 토큰의 일주일 된 대화, 2분 간격):
 * 시계가 시스템 메시지에 있을 때 Wafer 0%·Z.AI 10%, 뺐을 때 둘 다 99.8%가 캐시에서 읽혔다
 * (`~/laf/docs/agent-harness-review.md` §4.3). Claude Code도 같은 답을 냈다: 날짜는 세션을 열 때 한
 * 번, 날짜가 바뀌면 덧붙는 알림으로, 시각은 모델이 `date`를 돌려서 본다.
 *
 * 날짜는 툴이 아니다. "오늘/이번 주/내일"은 거의 매 턴 필요하고, 툴이면 매번 한 바퀴를 돌고
 * 모델이 부르기를 잊는 날 날짜를 지어낸다. 그래서 날짜는 대화의 맥락 층과 날짜 알림이 나르고
 * (`shared/prompt`), 이 툴은 분이 중요할 때 — "지금 몇 시야", "마감까지 몇 분" — 만 불린다.
 *
 * 발자국 사다리(CLAUDE.md)의 맨 아래 칸들을 건너뛴 이유. 기존 코드를 늘리는 길(프롬프트의 시계
 * 줄)이 바로 캐시를 깨던 그것이고, 필요할 때만 내미는 툴은 툴 목록을 바꿔서 같은 캐시를 깬다
 * (툴은 프롬프트의 맨 앞에 선다). 그래서 언제나 있는 핵심 툴이 되, 스키마는 인자 없이 가장 작게
 * 둔다. 답은 `agent-bot`이 실행 안에서 한다 — 표면까지 한 바퀴 돌 이유가 없는 사실이고, 대화와
 * 루틴이 같은 한 곳을 지난다. 사장님의 시간대는 서버의 미들웨어가 `forwardedProps.timeZone`으로
 * 보낸다(`server/src/copilot.ts`).
 */
import { resolveTimeZone, zonedParts } from "../prompt/zone";
import type { JsonSchema } from "./standard-schema";

export const NOW_TOOL_NAME = "now";

export const NOW_TOOL: {
  name: string;
  description: string;
  parameters: JsonSchema;
} = {
  name: NOW_TOOL_NAME,
  description:
    "사장님 시계로 지금의 날짜·요일·시각·시간대를 본다. 몇 시 몇 분인지가 필요할 때 부른다.",
  parameters: { type: "object", properties: {} },
};

/** 지금, 사장님 시간대로. 모르는 시간대는 서울이다(`resolveTimeZone`). */
export function nowReading(
  now: Date,
  timeZone?: string | null,
): {
  date: string;
  weekday: string;
  time: string;
  timeZone: string;
} {
  const zone = resolveTimeZone(timeZone);
  const { date, weekday, time } = zonedParts(now, zone);
  return { date, weekday: `${weekday}요일`, time, timeZone: zone };
}

/** 툴 결과의 봉투. 다른 툴 결과처럼 JSON 한 덩어리다. */
export function nowResultText(now: Date, timeZone?: string | null): string {
  return JSON.stringify({ ok: true, ...nowReading(now, timeZone) });
}
