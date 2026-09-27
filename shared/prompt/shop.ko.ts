/**
 * 봇이 일하는 가게에 대해 아는 한 줄 — 프롬프트의 문맥 층.
 *
 * 첫 실행에서 사람이 두 가지를 눌러서 답한다: 어떤 일을 하는지, 매일 어디에 들어가는지
 * (`shared/shop/catalogue.ts`). 그 답이 모든 봇의 모든 실행에 이 한두 줄로 실린다 — 봇이 인사할 때
 * 가게에 맞는 일을 먼저 꺼내고, 어디서 찾을지 정할 때 사장님이 실제로 쓰는 곳부터 떠올리게.
 *
 * 짧게 두는 이유는 값이다. 이 줄은 매 턴 모든 봇 앞에 실리므로, 곳이 많아도 앞의 몇 곳만 이름을
 * 대고 나머지는 개수만 말한다. 사이트는 주소를 붙인다: 사장님들이 쓰는 관리자 화면은 손님용
 * 페이지와 주소가 달라서(`sell.smartstore.naver.com`), 이름만으로는 봇이 엉뚱한 곳으로 간다.
 * 계정으로 연결하는 곳(지메일 같은)은 툴로 닿으므로 주소가 필요 없다.
 *
 * 여기에는 묻는 것·허락하는 것에 대한 말이 한 마디도 없어야 한다. 무엇이 멈추고 사람에게 묻는지는
 * 경계가 코드로 정하고, 경계는 이 줄을 읽지 않는다. "사장님의 사이트"라는 말이 봇에게 물어볼
 * 이유를 없애 주는 식으로 읽히면, 프롬프트가 경계를 흐리는 것이다.
 *
 * 이름은 사람 화면의 한국어(`app/src/lib/i18n-ko.ts`)와 같은 말이어야 한다 — 사장님이 "배달의민족"
 * 이라고 고른 곳을 봇이 다른 이름으로 부르면 안 된다. `app/tests/shop-copy.test.ts`가 둘을 맞춰 본다.
 */
import type { Persona } from "../persona";
import {
  type BusinessKindId,
  dailyPlaceById,
  type ShopProfile,
} from "../shop/catalogue";
import { siteById } from "../sites/catalogue";

/** 사람이 고른 일의 이름. 그 밖에는 봇에게 아무것도 말하지 않는다 — 틀린 것보다 없는 것이 낫다. */
export const BUSINESS_KIND_KO: Readonly<Record<BusinessKindId, string>> = {
  food: "음식점·카페",
  online: "온라인 판매",
  store: "매장 판매",
  beauty: "미용·뷰티",
  education: "학원·교육",
  health: "병원·약국",
  office: "사무·전문직",
  other: "그 밖에",
};

/** 곳의 이름. 사람 화면에 그려지는 것과 같은 말. */
export const PLACE_KO: Readonly<Record<string, string>> = {
  "naver-smartplace": "네이버 스마트플레이스",
  "naver-smartstore": "네이버 스마트스토어",
  "naver-booking-talk": "네이버 예약·톡톡",
  "naver-searchad": "네이버 검색광고",
  "baemin-ceo": "배달의민족",
  "coupangeats-store": "쿠팡이츠",
  "yogiyo-ceo": "요기요",
  "coupang-wing": "쿠팡 윙",
  "catchtable-ceo": "캐치테이블",
  "kakao-channel": "카카오톡 채널",
  "kakao-alimtalk": "카카오 알림톡",
  instagram: "인스타그램",
  "daangn-business": "당근비즈니스",
  cafe24: "카페24",
  tosspayments: "토스페이먼츠",
  hometax: "홈택스",
  gmail: "지메일",
  "google-calendar": "구글 캘린더",
  "google-sheets": "구글 스프레드시트",
  "google-drive": "구글 드라이브",
  "google-business-profile": "구글 비즈니스 프로필",
  notion: "노션",
};

/** 이름을 대는 곳의 수. 넘치는 곳은 개수만 — 스물두 곳을 다 고른 사람도 한 줄로 끝난다. */
export const SHOP_PLACES_SHOWN = 8;

/**
 * 곳 하나를 봇이 읽는 모양으로: 사이트면 "이름(주소)", 계정이면 이름만.
 *
 * 주소는 사이트 카탈로그의 `loginUrl`에서 온다 — 사람이 연결 화면에서 로그인하러 가는 바로 그
 * 주소이고, 봇이 찾아가야 할 곳도 거기다. 첫 번째 문이 계정인 곳(카페24)은 툴로 닿으므로 주소를
 * 붙이지 않는다.
 */
function placeLabel(id: string): string | null {
  const place = dailyPlaceById(id);
  const name = PLACE_KO[id];
  if (!place || !name) return null;
  const door = place.connections[0];
  if (door?.kind !== "site") return name;
  const site = siteById(door.id);
  if (!site) return name;
  try {
    return `${name}(${new URL(site.loginUrl).host})`;
  } catch {
    return name;
  }
}

/**
 * 가게 문단. 아무것도 답하지 않았으면 빈 문자열 — 조립기가 빈 문단을 떨어뜨린다.
 *
 * 일만 답했으면 사실 한 줄. 곳을 골랐으면 둘째 줄이 붙는다: 어디서 시작할지, 그리고 필요한 곳이
 * 아직 연결되어 있지 않으면 연결부터 권하라는 것. "시작할 때 이 곳들을 살펴라"가 아니라 "먼저
 * 떠올려라"인 이유는 루틴 때문이다 — 루틴의 지시가 다른 일을 말하는데 봇이 매번 배민부터 열면
 * 안 된다.
 */
export function shopText(shop: ShopProfile | undefined): string {
  if (!shop) return "";
  const kind =
    shop.kind && shop.kind !== "other" ? BUSINESS_KIND_KO[shop.kind] : null;
  const places = shop.places
    .map(placeLabel)
    .filter((label): label is string => label !== null);

  const facts: string[] = [];
  if (kind) facts.push(`이 사람이 하는 일: ${kind}.`);
  if (places.length > 0) {
    const shown = places.slice(0, SHOP_PLACES_SHOWN).join(", ");
    const more = places.length - SHOP_PLACES_SHOWN;
    facts.push(`매일 쓰는 곳: ${shown}${more > 0 ? ` 외 ${more}곳` : ""}.`);
  }
  if (facts.length === 0) return "";
  if (places.length === 0) return facts.join(" ");
  return [
    facts.join(" "),
    "할 일을 제안하거나 어디서 찾을지 정할 때 이 곳들을 먼저 떠올리고, 필요한 곳이 아직 연결되어 있지 않으면 연결부터 권한다.",
  ].join("\n");
}

/**
 * 부를 수 있는 이름인가. 이메일 주소(개발용 계정의 이름이 그렇다)나 너무 긴 글은 이름이 아니다 —
 * "dev@laf.local님"이라고 부르느니 호칭 없이 말하는 편이 낫다.
 */
function callableName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  if (!trimmed || trimmed.includes("@") || [...trimmed].length > 20) {
    return null;
  }
  return trimmed;
}

/** 사람이 고른 답마다, 예를 들 때 무엇에 맞추는지. 기타와 모름은 짐작하지 않는다. */
export const PERSONA_KO: Readonly<Record<Persona, string>> = {
  owner:
    "이 사람은 가게나 사업을 하는 사장님이다. 예를 들거나 할 일을 제안할 때는 가게 일에 맞춘다.",
  student:
    "이 사람은 학생이다(스스로 고른 답). 예를 들거나 할 일을 제안할 때는 공부·과제·시험·용돈에 맞춘다.",
  worker:
    "이 사람은 직장인이다(스스로 고른 답). 예를 들거나 할 일을 제안할 때는 회사 일에 맞춘다.",
  other:
    "이 사람은 학생·직장인·사장님 어디에도 들지 않는다고 답했다. 예를 들 때 한쪽으로 짐작하지 않는다.",
};

/**
 * 이 사람에 대한 문단 — 호칭, 누구인지, 가게. 맥락 층의 한 자리(`ContextFacts.shop`)에 선다.
 *
 * 2026-09-27부터 이 제품은 사장님만의 것이 아니다(`shared/persona.ts`). 호칭이 정적 층의
 * "사장님"에서 여기로 내려왔다: 사장님에게는 "사장님", 다른 사람에게는 "{이름}님"이나 호칭 없이.
 * 정적 층은 배포마다 바이트까지 같아야 하므로 사람마다 다른 것은 전부 이쪽이다.
 *
 * 끝 문장이 늘 붙는다: 누구인지는 예를 드는 방향일 뿐 거절할 이유가 아니다. 사장님도 공부 계획을,
 * 학생도 가게 소개 문구를 부탁할 수 있다.
 *
 * `about`이 없으면(읽지 못했거나, 테스트와 평가) 예전 그대로 가게 줄만.
 */
export function aboutText(
  about: { persona: Persona | null; name: string | null } | undefined,
  shop: ShopProfile | undefined,
): string {
  const shopLines = shopText(shop);
  if (!about) return shopLines;
  const name = callableName(about.name);
  const address =
    about.persona === "owner"
      ? "호칭: 사장님."
      : name
        ? `호칭: ${name}님. '사장님'이라고 부르지 않는다.`
        : "호칭: 따로 없다. 이름이나 '사장님' 같은 호칭 없이 해요체로만 말한다.";
  /*
   * 봇은 묻기만 한다. askChoice의 `saves: "persona"`는 표면이 네 칸을 자기 말로 그리고, 사람이
   * 누른 답만 서버가 적는다(`server/src/turns/chat-tools.ts`) — 봇의 호출은 아무것도 적지 않는다.
   */
  const who = about.persona
    ? `${PERSONA_KO[about.persona]} 학생·직장인·사장님이 바뀌었다고 하면 askChoice(saves: "persona")로 확인받는다.`
    : `이 사람이 학생·직장인·사장님 중 누구인지 아직 모른다. 예를 들 때 한쪽으로 짐작하지 않는다. 필요할 때 한 번 askChoice(saves: "persona")로 묻는다.`;
  return [address, `${who} 다른 종류의 일을 부탁하면 그대로 돕는다.`, shopLines]
    .filter(Boolean)
    .join("\n");
}
