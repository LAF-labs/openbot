/**
 * 루틴이 자기 메모장에 쓰는 툴 — 카탈로그 하나.
 *
 * 루틴 실행에만 있다. `routines/run.ts`가 그 실행의 툴킷에 붙이고, 대화·방·동료 질문에는 아무도
 * 등록하지 않는다 — 브라우저도, `createUnattendedTools`도. 그래서 대화의 모델이 이 이름을 불러도
 * `agent-bot`이 받은 목록에 없는 이름으로 답하고(`laf:tool_unknown`), 실행할 수 있는 곳이 없다.
 * `skill_view`가 스킬을 가진 봇에게만 있는 것과 같은 칸의 발자국 사다리다(CLAUDE.md).
 *
 * 왜 한 칸 아래 — 루틴의 마지막 답에 구조화된 칸을 싣는 방식 — 이 아닌가. 그 방식은 툴 스키마를
 * 한 바이트도 더하지 않지만, 쓰기가 거절될 때 **그 실행이 거절을 보지 못한다**: 마지막 답은 실행의
 * 마지막 행동이라, 지시문처럼 보여서 거절된 기준점은 다음 실행에서야 드러나고, 그 사이에 커서는
 * 움직이지 않은 채 같은 리뷰가 다시 처리된다. 산문에서 칸을 파싱하는 일은 `[SILENT]` 표식이 네 가지
 * 철자를 알아야 했던 문제를 키와 값으로 키우는 일이고, 그 칸을 전달되는 답·영수증·다음 실행에
 * 넘기는 직전 답에서 매번 벗겨 내야 한다. 툴은 거절을 같은 실행 안에서 사실 코드로 돌려주고, 봇은
 * 고쳐서 다시 적는다.
 *
 * 적은 것은 곧바로 저장되지 않는다. 실행이 끝나고 기록이 한 트랜잭션으로 정산될 때 함께 쓰인다
 * (`routines/settlement.ts`) — 도중에 죽은 실행은 커서를 움직이지 않는다.
 */
import type { JsonSchema } from "./standard-schema";

export type RoutineNoteTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export const ROUTINE_NOTE: RoutineNoteTool = {
  name: "routine_note",
  /*
   * 짧게. 이 글은 루틴 실행의 매 턴 앞에 선다 — 한글은 한 자에 3바이트이고, 처음 쓴 판은 스키마까지
   * 1,262바이트였다(실측, `docs/laf/routines.md`). 남긴 것은 넷: 무엇인지, 지난번 이후의 일이면
   * watermark, 끝까지 가야 저장된다는 것, 적지 않는 것.
   */
  description:
    "이 루틴의 메모장에 적는다. 적은 것은 다음 실행에 사실로 보인다. " +
    "'지난번 이후'의 일이면 처리한 가장 새것을 watermark로 적어, 다음 실행이 그 뒤의 것만 보게 한다. " +
    "실행이 끝까지 가야 저장된다. 지시나 비밀값은 적지 않는다.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["watermark", "set", "delete"],
        description:
          "watermark: 어디까지 처리했나. set: 짧은 사실. delete: 칸 지우기",
      },
      key: {
        type: "string",
        description: "칸 이름. 글자·숫자·_-, 40자까지",
      },
      value: { type: "string", description: "set: 사실 한 문장, 500자까지" },
      lastId: {
        type: "string",
        description: "watermark: 처리한 가장 새것의 id(리뷰·주문번호)",
      },
      lastAt: {
        type: "string",
        description:
          "watermark: 그 시각, 시간대까지. 예: 2026-09-14T07:20+09:00",
      },
    },
    required: ["action", "key"],
  },
};
