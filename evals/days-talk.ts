/**
 * What is said on one of the `days` case's days (`./cache-days.ts`): the owner's four requests and
 * the Bot's scripted answers.
 *
 * ON ITS OWN SO THAT A TEST CAN READ IT. `./cache-days.ts` imports the model's client
 * (`agent-bot/src/provider.ts`), which is built when it is imported and throws without
 * `OPENAI_API_KEY`. `tests/eval-memory-days.test.ts` read these two from there and passed only
 * beside a file that had set a key first — in a process of its own, with no key, it failed to
 * import (2026-10-11, pull request 183). Nothing here imports anything.
 */

export const TURNS = [
  "좋은 아침. 오늘 들어온 주문 몇 건인지 정리해줘.",
  "주문 관리 들어가서 아직 발송 안 된 주문 확인해줘.",
  "고객 문의 들어온 거 답장 초안 짧게 써줘.",
  "오늘 마감 전에 할 일 세 가지만 정리해줘.",
];

/** A Bot's answer of the length real ones run to. Scripted, so both arms carry the same bytes. */
export function answerText(day: number, turn: number): string {
  const lines = [
    `${day + 1}일차 ${turn + 1}번째 요청 정리입니다.`,
    `오늘 들어온 주문은 ${12 + day}건이고, 그중 ${3 + (day % 3)}건은 아직 발송 전입니다.`,
    "발송 전 주문은 오후 네 시 택배 마감 전에 송장을 출력하면 오늘 안에 나갈 수 있습니다.",
    "고객 문의는 배송 일정 문의가 대부분이라, 주문번호와 예상 도착일을 넣은 짧은 답장을 권해 드립니다.",
    "재고는 유자청 500g이 조금 부족해 보여서 이번 주 안에 추가 발주를 검토하시면 좋겠습니다.",
    "그 밖의 주문은 결제 완료 상태이고, 특이사항이나 취소 요청은 없습니다.",
  ];
  return Array.from({ length: 3 }, () => lines.join(" ")).join("\n");
}
