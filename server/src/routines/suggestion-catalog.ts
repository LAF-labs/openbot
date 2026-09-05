/**
 * Routines worth having, written out so that one press makes one.
 *
 * WHAT THIS IS. Hermes Agent's `cron/suggestion_catalog.py`, for a Korean shop: a short, curated
 * list of the standing jobs a Bot can actually do on the sites and accounts this product connects —
 * read yesterday's orders, find the unanswered enquiry, notice the low star. The routines page
 * offers them as cards; nothing here is ever created on anybody's behalf (`routines/suggestions.ts`
 * is the consent path), and a card somebody declines does not come back.
 *
 * ELEVEN, NOT THIRTY. A catalogue is read; an example is taken. These are the ones a shop owner
 * recognises as their own morning, and the page shows at most five of them at a time.
 *
 * EVERY ENTRY NAMES WHAT IT NEEDS, AND IS OFFERED ONLY WHEN THE PERSON HAS IT. `needsAnyOf` is a
 * list of the sites and accounts the routine could run on; one connected is enough, none means
 * the card is not drawn. A suggestion for a routine that would open a login wall at seven in the
 * morning is not a suggestion, it is a failed run scheduled in advance. An empty list means the
 * routine needs nothing but the calendar, and is offered to everybody.
 *
 * 공고·입찰 감시 is deliberately not here. 나라장터 is not a catalogued site, and a bid watch is
 * only worth anything with the keywords of one business in it — which a catalogue cannot know.
 * It is a routine somebody writes, not one they are offered.
 *
 * THE NAME AND THE INSTRUCTION ARE THE ROUTINE, VERBATIM. They are stored as the routine's own
 * `name` and `instruction` on accept, exactly as if the person had typed them, and the person reads
 * them back on the same page and can delete and rewrite them. They are the Bot's standing orders,
 * so they are in the language the Bot works in — the same arrangement as `shared/prompt/`. The
 * card's own words (why this is worth having) are the surface's, in `lib/routines/suggestions.ts`
 * on the app side, keyed by `key`; a test there walks this file so the two cannot drift apart.
 *
 * NO IMPORTS, ON PURPOSE. The app's tests read this file to check their copy table against it, and
 * a file that pulled the routine service in would pull drizzle into the app's typecheck with it.
 */

/** Which of the product's connections a suggestion can run on. `id` is a catalogue key. */
export type SuggestionRequirement = {
  /** A site the person signs into on the Bot's browser (`shared/sites/catalogue.ts`). */
  kind: "site" | "account";
  id: string;
};

/**
 * A daily schedule on the Seoul clock, structurally the routine service's own `daily` shape.
 *
 * Only `daily`: a suggestion is a time of day somebody recognises, never "every 45 minutes".
 */
export type SuggestionSchedule = {
  kind: "daily";
  /** "HH:MM" on the wall clock of `timeZone`. */
  time: string;
  timeZone: string;
  /** Weekdays it may run on, 0 = Sunday. Absent means every day. */
  days?: number[];
};

export type RoutineSuggestionEntry = {
  /** The dedup key — what a routine made from this carries, and what a dismissal latches on. */
  key: string;
  /** The routine's name, as it will be stored. */
  name: string;
  /** The Bot's standing instruction, as it will be stored and sent. */
  instruction: string;
  schedule: SuggestionSchedule;
  /** One of these connected makes the card eligible. Empty means nothing is needed. */
  needsAnyOf: readonly SuggestionRequirement[];
};

const SEOUL = "Asia/Seoul";
const site = (id: string): SuggestionRequirement => ({ kind: "site", id });
const account = (id: string): SuggestionRequirement => ({
  kind: "account",
  id,
});

/** Monday to Friday, 0 = Sunday, the way `laf_routines.daily_days` stores it. */
const WEEKDAYS = [1, 2, 3, 4, 5];
const MONDAY = [1];
const WEDNESDAY = [3];

/** The sites and accounts where orders are placed and paid for. */
const SELLING = [
  site("naver-smartstore"),
  site("coupang-wing"),
  account("cafe24"),
  site("cafe24-admin"),
];

/** Delivery-app owner consoles. */
const DELIVERY = [
  site("baemin-ceo"),
  site("coupangeats-store"),
  site("yogiyo-ceo"),
];

/**
 * In the order they are offered. The order is a judgement about what a shop owner gets the most
 * out of first, and the page shows the first five that are eligible — so the one that needs no
 * connection at all goes last, where it is the card somebody with nothing connected sees alone.
 */
export const ROUTINE_SUGGESTIONS: readonly RoutineSuggestionEntry[] = [
  {
    key: "morning-brief",
    name: "아침 브리핑",
    instruction:
      "로그인해 둔 판매·주문 사이트를 모두 열어 어제 들어온 주문 수와 매출, 아직 답하지 않은 문의, 새로 달린 리뷰를 읽고, 오늘 아침에 먼저 볼 것 세 가지로 간추려 주세요. 숫자는 사이트에 적힌 그대로 옮기고, 못 연 사이트가 있으면 그 이름만 적고 넘어가세요. 답장이나 처리는 하지 말고 읽기만 하세요.",
    schedule: { kind: "daily", time: "07:30", timeZone: SEOUL },
    needsAnyOf: [
      ...SELLING,
      ...DELIVERY,
      site("tosspayments"),
      site("naver-booking-talk"),
      site("catchtable-ceo"),
      site("daangn-business"),
    ],
  },
  {
    key: "review-watch",
    name: "리뷰 감시",
    instruction:
      "로그인해 둔 리뷰 사이트를 열어 어제 이후 새로 달린 리뷰를 모두 읽어 주세요. 별점이 낮거나 불만이 담긴 리뷰는 내용을 그대로 옮기고 왜 답이 필요한지 한 줄로 적어 주세요. 답글은 절대 직접 달지 말고, 달면 좋을 답글 초안만 리뷰마다 한 개씩 써 주세요.",
    schedule: { kind: "daily", time: "09:00", timeZone: SEOUL },
    needsAnyOf: [
      site("naver-smartplace"),
      ...DELIVERY,
      account("google-business-profile"),
      site("daangn-business"),
    ],
  },
  {
    key: "unanswered-enquiries",
    name: "미답 문의 알림",
    instruction:
      "로그인해 둔 문의·메시지 창구를 열어 아직 답하지 않은 문의를 모두 찾아 주세요. 하나마다 누가 언제 무엇을 물었는지 한 줄로 적고, 오래 기다린 순서로 정리해 주세요. 답장은 보내지 말고, 바로 보낼 수 있게 답장 초안만 붙여 주세요.",
    schedule: { kind: "daily", time: "11:00", timeZone: SEOUL },
    needsAnyOf: [
      site("naver-smartstore"),
      site("naver-booking-talk"),
      site("kakao-channel"),
      site("instagram"),
      account("cafe24"),
      site("cafe24-admin"),
      site("daangn-business"),
      account("gmail"),
    ],
  },
  {
    key: "weekly-settlement",
    name: "주간 정산 요약",
    instruction:
      "지난주(월요일부터 일요일까지) 매출과 주문 수를 판매·결제 사이트마다 읽어 사이트별로 정리하고, 이번 주에 들어올 정산 금액과 정산일을 함께 적어 주세요. 그 전주와 비교해 늘었는지 줄었는지 한 줄로 알려 주세요. 숫자는 사이트에 적힌 그대로 옮기고, 계산이 필요하면 식을 같이 적어 주세요.",
    schedule: { kind: "daily", time: "08:00", timeZone: SEOUL, days: MONDAY },
    needsAnyOf: [...DELIVERY, site("tosspayments"), ...SELLING],
  },
  {
    key: "stock-check",
    name: "재고 확인",
    instruction:
      "판매 사이트의 상품 목록을 열어 재고가 5개 이하거나 품절인 상품, 판매 중지나 노출 제한이 걸린 상품을 찾아 주세요. 상품명과 남은 수량을 그대로 옮기고, 오늘 발주해야 할 것을 맨 위에 두세요. 발주나 가격 변경은 하지 마세요.",
    schedule: {
      kind: "daily",
      time: "08:30",
      timeZone: SEOUL,
      days: WEEKDAYS,
    },
    needsAnyOf: SELLING,
  },
  {
    key: "booking-check",
    name: "내일 예약 확인",
    instruction:
      "예약 관리 화면을 열어 내일 예약을 시간 순서로 정리해 주세요. 인원, 요청 사항, 아직 확정되지 않은 예약을 표시하고, 내일 예약이 없으면 없다고만 적어 주세요. 예약을 확정하거나 취소하지는 마세요.",
    schedule: { kind: "daily", time: "18:00", timeZone: SEOUL },
    needsAnyOf: [
      site("naver-booking-talk"),
      site("catchtable-ceo"),
      account("google-calendar"),
    ],
  },
  {
    key: "delivery-delay",
    name: "배송 지연 확인",
    instruction:
      "판매 사이트의 주문 목록에서 결제된 지 이틀이 지났는데 아직 발송되지 않은 주문과, 발송 기한이 오늘까지인 주문을 찾아 주세요. 주문번호, 상품, 주문일을 그대로 옮기고 기한이 급한 순서로 정리해 주세요. 주문 상태를 바꾸거나 고객에게 연락하지는 마세요.",
    schedule: { kind: "daily", time: "16:00", timeZone: SEOUL },
    needsAnyOf: SELLING,
  },
  {
    key: "store-open-check",
    name: "영업 상태 확인",
    instruction:
      "배달 앱 사장님 화면을 열어 지금 가게가 영업 중으로 표시되는지, 주문 접수가 멈춰 있지는 않은지, 오늘 남은 영업시간이 맞는지 확인해 주세요. 꺼져 있거나 이상하면 어느 앱이 그런지 한 줄로 알려 주세요. 영업 상태를 직접 바꾸지는 마세요.",
    schedule: { kind: "daily", time: "17:30", timeZone: SEOUL },
    needsAnyOf: DELIVERY,
  },
  {
    key: "ad-spend",
    name: "광고비 점검",
    instruction:
      "네이버 검색광고에서 지난주 광고비, 클릭 수, 전환을 캠페인별로 읽어 주세요. 광고비가 늘었는데 클릭이 줄어든 캠페인과 예산이 다 떨어져 멈춘 캠페인을 따로 표시해 주세요. 입찰가나 예산은 바꾸지 마세요.",
    schedule: { kind: "daily", time: "09:30", timeZone: SEOUL, days: MONDAY },
    needsAnyOf: [site("naver-searchad")],
  },
  {
    key: "competitor-price",
    name: "경쟁 가격 확인",
    instruction:
      "판매 사이트에서 가장 많이 팔리는 상품 다섯 개의 이름과 판매가를 읽은 다음, 네이버 쇼핑에서 같은 상품을 검색해 최저가와 우리 가격의 차이를 상품마다 적어 주세요. 우리보다 싼 곳이 있으면 어디가 얼마인지 그대로 옮기고, 우리 가격은 바꾸지 마세요.",
    schedule: {
      kind: "daily",
      time: "10:00",
      timeZone: SEOUL,
      days: WEDNESDAY,
    },
    needsAnyOf: SELLING,
  },
  {
    key: "tax-calendar",
    name: "세금 일정 알림",
    instruction:
      "오늘 날짜를 기준으로 앞으로 2주 안에 돌아오는 세금·신고 일정을 알려 주세요. 부가가치세(1월 25일·7월 25일, 예정신고 4월 25일·10월 25일), 원천세와 4대보험(매월 10일), 종합소득세(5월 31일), 사업장현황신고(2월 10일)를 기준으로 하고, 그날이 주말이나 공휴일이면 다음 평일로 옮겨서 적어 주세요. 2주 안에 아무것도 없으면 없다고만 알려 주세요.",
    schedule: { kind: "daily", time: "09:00", timeZone: SEOUL, days: MONDAY },
    needsAnyOf: [],
  },
];

export function suggestionEntry(key: string): RoutineSuggestionEntry | null {
  return ROUTINE_SUGGESTIONS.find((entry) => entry.key === key) ?? null;
}
