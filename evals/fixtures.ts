/**
 * What a stubbed page says.
 *
 * `computer_navigate` used to be answered with `{ ok: true }` and `computer_read` with an empty
 * string, so every scenario that opened a page then had to answer from nothing — which means the
 * one thing the product's prompt insists on ("답은 돌아온 내용으로 하고, 가서 직접 보라고 하지
 * 마라") was never once exercised. A model can pass an eval like that while being completely unable
 * to read a Korean order list, which is the actual first task this product has.
 *
 * Small on purpose. This is a fixture for "can it answer from the page", not a load test; the
 * context-budget scenario builds its own long pages.
 */

export const SHOP_PAGE_TITLE = "미소상회 · 주문 관리";

/** Three orders, two of them today's. The kind of table a small shop's admin page draws. */
export const SHOP_PAGE_TEXT = [
  "미소상회 주문 관리",
  "",
  "주문번호 | 주문일시 | 고객 | 상품 | 수량 | 금액 | 상태",
  "20260045 | 오늘 09:12 | 김민수 | 수제 딸기잼 250g | 2 | 24,000원 | 결제완료",
  "20260046 | 오늘 10:40 | 박지영 | 유자청 500g | 1 | 15,000원 | 결제완료",
  "20260044 | 어제 18:03 | 이수현 | 수제 딸기잼 250g | 3 | 36,000원 | 배송중",
  "",
  "오늘 신규 주문 2건 · 오늘 결제 금액 합계 39,000원",
  "미발송 2건",
].join("\n");

/**
 * One long page, for the context-budget scenario.
 *
 * Roughly what `agent-computer` actually hands back: its extraction is capped at 6,000 characters,
 * and in Korean that is roughly as many tokens. Twelve of these unbudgeted is the fifty-thousand
 * token transcript §3.2 measured.
 */
export function longPage(step: number, orderNumber: string): string {
  const line = `${step}번 창고 재고 점검 기록 · 품목 확인 · 수량 확인 · 이상 없음 · 담당자 확인 필요 없음`;
  const filler = Array.from({ length: 100 }, (_, at) => `${at + 1}. ${line}`);
  return [
    `${step}번 창고 페이지`,
    ...filler,
    `이 페이지의 발주번호는 ${orderNumber} 입니다.`,
  ].join("\n");
}
