/**
 * 하네스의 판 — 이 빌드가 모델 앞에 세우는 글의 지문.
 *
 * 판이 바뀌면 모든 대화가 새 에포크를 연다(`server/src/context/conversations.ts`). Claude Code가
 * 세션을 새로 여는 것과 같은 이유다: 시스템 프롬프트의 글이 바뀐 배포에서 옛 에포크에 얼려 둔
 * 맥락 층을 계속 보내면, 새 정적 층 뒤에 옛 모양의 맥락이 붙는다. 어차피 캐시는 정적 층이 바뀐
 * 그 자리에서 깨졌으므로 새로 그리는 값은 없다.
 *
 * 손으로 올리는 번호가 아니라 글에서 계산한다. 번호는 누군가 올리는 것을 잊는 날 거짓이 된다.
 * 정적 층 둘, 고정된 사실로 그린 맥락 층 둘, 알림의 모양, `now` 툴의 정의 — 봇이 읽는 글 중에
 * 배포가 정하는 것 전부다. 표면이 보내는 툴 목록은 여기 없다: 그것은 요청마다 해시되고
 * (`toolsHash`), 바뀌면 그 자체로 새 에포크다.
 *
 * 서버에서만 읽는다(`node:crypto`). 앱이 부르는 모듈에서 이것을 가져오면 안 된다.
 */
import { createHash } from "node:crypto";
import { NOW_TOOL } from "../tools/now";
import {
  type ContextFacts,
  contextLayerText,
  reminderBlock,
  reminderLines,
  routineRunLine,
} from "./context.ko";
import { staticPrompt } from "./index";

/** 판을 재는 데 쓰는 고정된 사실. 무엇이든 좋다 — 같은 사실로 그린 글이 바뀌었는가만 본다. */
const FIXTURE: ContextFacts = {
  name: "미소",
  role: "주문을 챙긴다.",
  shop: "이 사람이 하는 일: 카페.",
  place: "사장님 가게 위치: 성수동.",
  timeZone: "Asia/Seoul",
  zoneIsPerson: true,
  locale: "ko-KR",
  day: "2026-09-25 (금)",
  memories: ["택배는 우체국을 쓴다."],
  skills: "- /재고정리 — 재고를 정리한다",
};

const MOVED: ContextFacts = {
  ...FIXTURE,
  name: "다솜",
  place: "사장님 가게 위치: 망원동.",
  timeZone: "Asia/Dubai",
  day: "2026-09-26 (토)",
  memories: ["주말에는 쉰다."],
};

export const HARNESS_VERSION = createHash("sha256")
  .update(
    JSON.stringify([
      staticPrompt("chat"),
      staticPrompt("routine"),
      contextLayerText(FIXTURE),
      contextLayerText(FIXTURE, "메모장"),
      reminderBlock(reminderLines(FIXTURE, MOVED)),
      routineRunLine({
        startedAt: new Date("2026-09-24T22:30:05Z"),
        scheduledFor: new Date("2026-09-24T22:30:00Z"),
        timeZone: "Asia/Seoul",
      }),
      NOW_TOOL,
    ]),
    "utf8",
  )
  .digest("hex")
  .slice(0, 12);
