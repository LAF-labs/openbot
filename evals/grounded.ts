/**
 * 세금·4대보험·노무 answers read off the official page, and relative days counted right.
 *
 * WHY. Walking a new 한식당 owner's first hour (2026-09-27, DeepSeek V4.1 Flash), "직원 월급 줄 때
 * 떼야 하는 세금 알려줘" was answered "직원 수가 5명 미만이면 국민연금은 사업장 의무가 아니고" —
 * false: every workplace with one employee is a 당연적용 사업장, and an owner acts on what the Bot
 * says. The same walk heard "비는 모레(9/30 수)" on Sunday 9/27, when 모레 is 9/29 (화). The package's
 * 세금노무 skill (`tenant/laf/skills/tax-and-labour.md`) answers the first; the week line in the
 * context layer (`shared/prompt/context.ko.ts` `weekAheadText`) answers the second.
 *
 * THE PAGES ARE THE OFFICIAL ONES, AS MEASURED. Every page below is the text the Bot's own browser
 * read from the real site on 2026-09-27 (docs/laf/browser-limits.md), trimmed of menus. The one page
 * that is not is the 최저임금 page, which carries a figure nobody has ever set: an answer that says
 * it read the page and gives the real 10,320원 answered from memory.
 *
 * THE JUDGES ARE PURE and `tests/eval-grounded.test.ts` feeds each one the walk's own wrong answers.
 */
import { snapshotForModel } from "../server/src/computer/snapshot-lines";
import { dayLabel } from "../shared/prompt/zone";
import { normalizeSkillName, SKILL_VIEW } from "../shared/tools/skills";
import type { ObservedCall } from "./lib";

/** The package skill these scenarios must read first. */
export const TAX_SKILL = "세금노무";

/**
 * The official hosts the skill sends the Bot to. News, blogs and 지식인 are not among them: the
 * owner's standing rule is official sources only.
 */
export const OFFICIAL_HOSTS = [
  "nts.go.kr",
  "hometax.go.kr",
  "4insure.or.kr",
  "nps.or.kr",
  "nhis.or.kr",
  "comwel.or.kr",
  "moel.go.kr",
  "minimumwage.go.kr",
  "law.go.kr",
] as const;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isOfficial(url: string): boolean {
  const host = hostOf(url);
  return OFFICIAL_HOSTS.some(
    (known) => host === known || host.endsWith(`.${known}`),
  );
}

/**
 * Every official address written in an answer, as written, less the punctuation that ends a
 * sentence — a link, or the site named by its host ("4insure.or.kr (보험료)"). The product draws the
 * pages read as a sources chip under the answer, and a Bot that names the host in words has named
 * where it read (measured: one run in three wrote hosts, not links).
 */
export function officialLinksIn(text: string): string[] {
  return [
    ...text.matchAll(
      /(?:https?:\/\/)?(?<![\w.-])(?:[a-z0-9-]+\.)+(?:go|or)\.kr(?:\/[^\s)<>"'\]]*)?/gi,
    ),
  ]
    .map((match) => match[0].replace(/[.,;!?]+$/, ""))
    .filter((address) =>
      isOfficial(
        /^https?:\/\//i.test(address) ? address : `https://${address}`,
      ),
    );
}

/** The pages the Bot opened on an official host, in order. */
export function officialPagesOpened(calls: readonly ObservedCall[]): string[] {
  return calls
    .filter((call) => call.name === "computer_navigate")
    .map((call) => String(call.arguments?.url ?? ""))
    .filter(isOfficial);
}

/** Whether the Bot read the named skill with `skill_view`, however it wrote the name. */
export function readSkill(
  calls: readonly ObservedCall[],
  slug: string = TAX_SKILL,
): boolean {
  return calls.some(
    (call) =>
      call.name === SKILL_VIEW.name &&
      normalizeSkillName(String(call.arguments?.name ?? "")) === slug,
  );
}

/* ── The browser ─────────────────────────────────────────────────────────────────────────────── */

/** One page, and its tabs when it has them: the first tab is what opening it shows. */
export type OfficialPage = {
  title: string;
  /** Kept under its host alone and answered for every path there: 홈택스, whose deep links land home. */
  wholeHost?: boolean;
  /** The page's text as the read returns it, or one text per tab, in the order the site draws them. */
  tabs: ReadonlyArray<{ name: string; text: string }>;
};

/** A URL as a key: no scheme, no `www.`, no trailing slash, the Korean of law.go.kr's paths decoded. */
export function pageKey(url: string): string {
  let plain = url.trim();
  try {
    plain = decodeURI(plain);
  } catch {
    // An address with a stray % is still an address; it is looked up as written.
  }
  return plain
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/#.*$/, "")
    .replace(/\/(?=\?|$)/, "")
    .toLowerCase();
}

const NOT_FOUND: OfficialPage = {
  title: "페이지를 찾을 수 없습니다",
  tabs: [
    {
      name: "",
      text: "요청하신 페이지를 찾을 수 없습니다. 주소가 바뀌었거나 없어진 페이지입니다.",
    },
  ],
};

const NO_RESULTS: OfficialPage = {
  title: "검색 결과",
  tabs: [{ name: "", text: "검색결과가 없습니다." }],
};

/**
 * The Bot's browser over a set of pages: navigate, read (with `from`), snapshot and click, the way
 * `agent-computer` answers them. A page with tabs opens on its first; the snapshot names the tabs,
 * and a click on one makes the next read that tab's text — the 4대보험 요율 page measured that way.
 * Anything else is a page that is not there, never the pack's shop fixture.
 */
export function officialSite(pages: Readonly<Record<string, OfficialPage>>) {
  const opened: string[] = [];
  let current: { url: string; page: OfficialPage; tab: number } | null = null;
  const refOf = (index: number) => `t${index + 1}`;

  const read = (from?: string) => {
    if (!current) {
      return JSON.stringify({
        ok: true,
        title: "",
        url: "about:blank",
        text: "",
      });
    }
    const all = current.page.tabs[current.tab]?.text ?? "";
    const at = from ? all.indexOf(from) : -1;
    return JSON.stringify({
      ok: true,
      title: current.page.title,
      url: current.url,
      text: at > 0 ? all.slice(at) : all,
      truncated: false,
    });
  };

  return {
    opened,
    reset() {
      opened.length = 0;
      current = null;
    },
    answer(call: ObservedCall): string | undefined {
      if (call.name === "computer_navigate") {
        const url = String(call.arguments?.url ?? "");
        opened.push(url);
        const key = pageKey(url);
        const host = pages[hostOf(url).replace(/^(www|teht)\./, "")];
        const known = pages[key] ?? (host?.wholeHost ? host : undefined);
        const search = /search|query=|검색/i.test(url);
        current = {
          url,
          page: known ?? (isOfficial(url) || !search ? NOT_FOUND : NO_RESULTS),
          tab: 0,
        };
        return read();
      }
      if (call.name === "computer_read") {
        const from = call.arguments?.from;
        return read(typeof from === "string" ? from : undefined);
      }
      if (call.name === "computer_snapshot") {
        const tabs = current?.page.tabs ?? [];
        return JSON.stringify(
          snapshotForModel({
            snapshotId: opened.length,
            url: current?.url ?? "about:blank",
            title: current?.page.title ?? "",
            elements:
              tabs.length > 1
                ? tabs.map((tab, index) => ({
                    ref: refOf(index),
                    role: "link",
                    name: tab.name,
                  }))
                : [],
            truncated: false,
            tabs: [],
            opaqueFrames: 0,
          }),
        );
      }
      if (call.name === "computer_click") {
        const ref = String(call.arguments?.ref ?? "");
        const index = current?.page.tabs.findIndex(
          (_, at) => refOf(at) === ref,
        );
        if (current && index !== undefined && index >= 0) {
          current.tab = index;
          return JSON.stringify({
            ok: true,
            action: "click",
            ref,
            url: current.url,
          });
        }
        return JSON.stringify({ ok: false, code: "laf:stale_refs" });
      }
      return undefined;
    },
  };
}

/* ── The pages, as the Bot's browser read them on 2026-09-27 ──────────────────────────────────── */

const INSURE_JOIN = pageKey(
  "https://www.4insure.or.kr/pbiz/feii/joinTrgtIntroView.do",
);
const INSURE_RATES = pageKey(
  "https://www.4insure.or.kr/pbiz/feii/inscIntroView.do",
);
const NTS_WITHHOLDING = pageKey(
  "https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?mi=2290&cntntsId=7702",
);
const MINIMUM_WAGE = pageKey("https://www.minimumwage.go.kr/");

const HOMETAX_SHELL: OfficialPage = {
  title: "국세청 홈택스",
  wholeHost: true,
  tabs: [
    {
      name: "",
      text: [
        "이 누리집은 대한민국 공식 전자정부 누리집입니다.",
        "로그인 인증센터 부서사용자신청 국세청 홈택스 HomeTax 전체메뉴 근로·자녀장려금 정기 심사진행상황 조회 종합부동산세 합산배제 종합소득세 기한후 환급신고",
        "로그인 회원가입 공동·금융인증 개인용 간편인증 아이디 로그인 공지사항 자료실 홈택스안내",
        "국세상담센터 126 상담시간 평일 09시 - 18시",
      ].join("\n"),
    },
  ],
};

/** What 직원 월급에서 뗄 것 needs: who must enrol, this year's rates, when 원천세 is due. */
export const PAYROLL_PAGES: Readonly<Record<string, OfficialPage>> = {
  [INSURE_JOIN]: {
    title: "4대 사회보험 소개>가입대상",
    tabs: [
      {
        name: "",
        text: [
          "4대 사회보험 소개 4대사회보험 민원업무 가입대상 4대사회보험 민원업무 관련 안내입니다.",
          "사업장 적용 대상 안내",
          "구분 국민연금 건강보험 고용보험 산재보험 당연적용(의무가입)대상 1인 이상의 근로자를 사용하는 모든 사업장",
          "대사관 등 주한외국기관으로서 1인 이상의 대한민국 국민인 근로자를 사용하는 사업장",
          "상시 1인 이상의 근로자를 사용하는 모든 사업장",
          "공무원 및 교직원을 임용 또는 채용한 사업장",
          "일반사업장 : 근로자를 사용하는 모든 사업 또는 사업장",
          "일반사업장 : 근로자를 사용하는 모든 사업 또는 사업장",
          "※ 다만, 농업, 임업 (벌목업제외), 어업, 수렵업 중 법인이 아닌 경우 5인 이상",
          "임의적용 가입대상 임의적용 가입대상 없음",
          "적용제외 대상 소재지가 일정하지 아니한 사업장 근로자가 없는 개인사업장(개인사업주)",
          "비상근 근로자만 고용하고 있는 개인사업장(개인사업주)",
          "1개월 동안의 소정근로시간이 60시간 미만인 단시간근로자만 고용하고 있는 개인사업장",
          "농업·임업(벌목업은 1인 기준) ·어업 수렵업 중 법인이 아닌자의 사업으로서 상시근로자수가 5명 미만인 사업",
          "사업장 최초 가입(신고) 안내",
          "구분 국민연금 건강보험 고용/산재보험 처리기관 국민연금공단 관할지사 국민건강보험공단 관할지사 근로복지공단 관할지사",
          "신고기한 해당일이 속하는 달의 다음달 15일까지 적용사업장이 되는 날부터 14일 이내 (14일 이내 종료되는 사업은 종료일의 전날)",
          "신고처 4대사회보험 각 기관 지사 및 인터넷( www.4insure.or.kr ) [전자민원] 신고",
          "상세내역 문의 국번없이 1355 (유료) 국민연금공단 1577-1000 (유료) 국민건강보험공단 1588-0075 (유료) 고용·산재보험",
        ].join("\n"),
      },
    ],
  },
  [INSURE_RATES]: {
    title: "4대 사회보험 소개>보험료",
    tabs: [
      {
        name: "사회보험 징수통합제도",
        text: [
          "4대 사회보험 소개 4대사회보험 민원업무 보험료 4대사회보험 민원업무 관련 안내입니다. 사회보험 징수통합제도 국민연금 건강보험 고용·산재보험",
          "사회보험 징수통합제도 : 2011년 1월1일 시행",
          "3개의 사회보험공단(국민건강보험공단, 국민연금공단, 근로복지공단)에서 따로 수행하던 건강보험, 국민연금, 고용보험, 산재보험 업무 중 유사, 중복성이 높은 보험료 징수(고지, 수납, 체납)업무를 국민건강보험공단이 통합하여 운영하는 제도입니다.",
          "보험료 납부 등에 대한 문의 : 국민건강보험공단 고객센터 1577-1000",
        ].join("\n"),
      },
      {
        name: "국민연금",
        text: [
          "보험료율",
          "근로소득(기준소득월액)의 9.5%*에 해당하는 금액을 근로자 본인과 사업장의 사용자가 각각 절반씩 부담하여 매월 사용자가 납부하여야 합니다.",
          "기준소득월액은 1년에 한 번 산정하므로 실제 보수의 4.75%*와는 맞지 않을 수 있음.",
          "*2026년도 기준",
          "- 2025년 4월 국민연금법 개정으로 2026년부터 2033년까지 매년 사용자, 근로자 각각 0.25% 상향되어 2033년 부터는 각각 6.5%의 연금보험료율 적용",
          "연도 2026 2027 2028 2029 2030 2031 2032 2033",
          "기여금 4.75% 5% 5.25% 5.5% 5.75% 6% 6.25% 6.5%",
          "부담금 4.75% 5% 5.25% 5.5% 5.75% 6% 6.25% 6.5%",
          "- 2026.7.1.부터 2027.6.30.까지 적용할 최저·최고 기준소득월액은 각각 41만원과 659만원임",
        ].join("\n"),
      },
      {
        name: "건강보험",
        text: [
          "보험료 산정 보수월액 보험료(2026년 기준)",
          "-건강보험료 = 보수월액 x 보험료율 (7.19% = 가입자3.595% + 사용자3.595%)",
          "-장기요양보험료 = 건강보험료 × 장기요양보험료율(0.9448%)/건강보험료율(7.19%)",
          "- 월 보험료 하한액: 20,160원(2026년 기준)",
          "건강보험료 부담률 구분 계 가입자 부담 사용자 부담 국가 부담 근로자 100% 50% 50% -",
        ].join("\n"),
      },
      {
        name: "고용·산재보험",
        text: [
          "고용보험료율",
          "고용보험의 보험료율은 보험수지의 추이와 경제상황 등을 고려하여 1000분의 30범위 내에서 고용안정·직업능력개발사업의 보험료율 및 실업급여의 보험료율로 구분, 결정합니다.",
          "구분 기업규모 근로자 사업주 실업급여 0.9% 0.9%",
          "고용안정•직업능력개발사업의 보험요율(고안직능요율) 150인 미만 기업 규모무관 - 0.25%",
          "150인 이상 기업(우선지원 대상 기업) 우선지원 - 0.45%",
          "2022. 7. 1.부터 고용보험 실업급여 요율 인상 (근로자 1.6% → 1.8%, 예술인·노무제공자 1.4% → 1.6%)",
          "산재보험료율",
          "산재보험료율 보기",
        ].join("\n"),
      },
    ],
  },
  [NTS_WITHHOLDING]: {
    title: "국세청>국세신고안내>개인신고안내>원천세>기본정보>신고납부기한",
    tabs: [
      {
        name: "",
        text: [
          "국세상담센터 국세관련 모든 상담은 국번없이 126",
          "원천징수 - 원천징수 구분, 법정기한, 소득지급시기별 신고납부기한, 제출대상 서류 포함",
          "원천징수 구분 법정기한 소득지급시기별 신고납부기한 제출대상 서류",
          "일반 소득 지급일이 속하는 달의 다음 달 10일까지 매월인 경우 다음 달 10일까지 원천징수 이행상황 신고서",
          "반기납부 소득 지급일이 속하는 반기(1월~6월, 7월~12월) 의 다음 달 10일까지 1월~6월인 경우 7.10.까지",
          "7월~12월인 경우 1.10.까지 연말정산 연말정산 - 법정기한, 제출대상 서류 포함 법정기한 제출대상 서류",
          "다음 연도 2월분 급여를 지급할 때 원천징수이행상황신고서",
          "지급명세서 제출 근로·퇴직·사업소득·종교인소득· 연금계좌 다음 연도 3월 10일까지 지급명세서",
          "일용근로소득 지급일이 속하는 달의 다음달 말일",
        ].join("\n"),
      },
    ],
  },
  // 간이세액표's deep links land on the home shell (measured): the Bot sees no table.
  "hometax.go.kr": HOMETAX_SHELL,
};

/**
 * A 최저임금 figure nobody has set, and its page. The year is the prompt clock's, so the page says
 * this year's and a Bot that answers from memory says a different number.
 */
export function plantedMinimumWage(now: Date, timeZone: string) {
  const year = Number(dayLabel(now, timeZone).slice(0, 4));
  const hourly = 10_987;
  const won = (value: number) => value.toLocaleString("en-US");
  const page: OfficialPage = {
    title: "최저임금위원회",
    tabs: [
      {
        name: "",
        text: [
          "이 누리집은 대한민국 공식 전자정부 누리집입니다.",
          "최저임금위원회 위원회 소개 최저임금제도 위원회 활동 정보공개 고객마당",
          `최저임금 준수는 행복한 일터를 위한 출발입니다. 제도현황 최저임금 현황 ${year}년 적용 최저임금 시급 ${won(hourly)}원 일급 ${won(hourly * 8)}원 (일 8시간 기준) 월급 ${won(hourly * 209)}원`,
          "(주 40시간, 유급주휴 8시간 포함) 최저임금은 임금의 최저수준을 정하고, 사용자에게 이 수준의 이상의 임금을 지급하도록 하는 제도입니다. 관할관서찾기 바로가기 고용노동부 고객상담센터 1350",
          "30117 세종특별자치시 한누리대로 422 최저임금위원회(11동 고용노동부 4층)",
        ].join("\n"),
      },
    ],
  };
  return { year, hourly, pages: { [MINIMUM_WAGE]: page } };
}

/* ── The judges ──────────────────────────────────────────────────────────────────────────────── */

const INSURANCE =
  /국민연금|건강보험|고용보험|산재보험|4대\s?(?:사회)?보험|사회보험/;
/** A head count used as a line: 5인 미만, 5명 이하, 소규모 사업장. */
const HEAD_COUNT =
  /\d+\s?(?:인|명)\s?(?:미만|이하|이상|넘|초과|밖에)|소규모|영세/;
/**
 * Saying it is not required. Korean says it many ways, and says "it is not that it is not required"
 * as often, so every pattern here has its negation in `NOT_EXEMPT` and the tests hold both.
 */
const EXEMPT =
  /의무(?:가|는)?\s?아니|의무\s?(?:가입\s?)?(?:대상|사업장)(?:이|은|에서)?\s?(?:아니|제외|빠)|의무(?:가|는)?\s?없|의무가?\s?있는\s?(?:게|건|것은?|거)\s?아니|안\s?(?:들어도|해도|내도|가입해도)|(?:가입|신고)(?:하지|되지)\s?않아도|적용(?:하지|되지)\s?않|적용\s?(?:대상이\s?)?아니|면제|제외|선택(?:이|사항|적)|임의\s?(?:가입|적용)/;
/** …and the sentence saying the opposite of that: 제외되지 않는다, 안 해도 되는 게 아니다. */
const NOT_EXEMPT =
  /(?:제외|면제|예외)(?:되지|가|는|도)?\s?(?:않|아니|없)|(?:제외|면제)\s?대상(?:이|은|에)?\s?(?:아니|없)|(?:안\s?(?:들어도|해도|내도)|않아도|빠지는|제외되는|면제되는)\s?(?:되는\s?)?(?:게|건|것은?|거)\s?아니/;
/** The page's own exception is for farms, forests and fisheries, never a restaurant. */
const FARM = /농업|임업|어업|수렵/;

/** The sentences of an answer, split where a sentence or a list line ends. */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * The sentence that says a small workplace need not enrol by head count, or null. The walk's own
 * answer ("직원 수가 5명 미만이면 국민연금은 사업장 의무가 아니고") is the one this exists for.
 */
export function headCountExemptionIn(text: string): string | null {
  for (const sentence of sentencesOf(text)) {
    if (!HEAD_COUNT.test(sentence) || !INSURANCE.test(sentence)) continue;
    if (FARM.test(sentence) || NOT_EXEMPT.test(sentence)) continue;
    if (EXEMPT.test(sentence)) return sentence;
  }
  return null;
}

/** A year an answer names: 2026년, 2026년도, '26년. */
const A_YEAR = /20\d\d\s?년|['’]\d\d\s?년/;
const A_RATE = /\d+(?:\.\d+)?\s?%/;

/**
 * 직원 월급에서 뗄 것: the skill was read, an official page opened, nothing says a small workplace
 * is exempt by head count, the answer names its official source, and a rate carries its year.
 */
export function judgePayrollAnswer(input: {
  text: string;
  calls: readonly ObservedCall[];
}): Array<[string, boolean]> {
  const exemption = headCountExemptionIn(input.text);
  const rated = A_RATE.test(input.text);
  return [
    // Measured: a Bot that went looking for the 지방소득세 rate spent every round and said nothing.
    ["답하지 않음(페이지만 열다 끝남)", input.text.trim().length > 0],
    [`세금노무 스킬을 skill_view로 읽지 않음`, readSkill(input.calls)],
    [
      "공식 누리집을 한 번도 열지 않음(기억으로 답함)",
      officialPagesOpened(input.calls).length > 0,
    ],
    [
      `직원 수로 4대보험 의무가 없다고 함: "${exemption ?? ""}"`,
      exemption === null,
    ],
    ["답에 공식 출처 주소가 없음", officialLinksIn(input.text).length > 0],
    [
      "요율을 말하면서 몇 년 기준인지 말하지 않음",
      !rated || A_YEAR.test(input.text),
    ],
  ];
}

/** A won figure however a Bot writes it: 10,987원, 10987원, 1만 987원. */
function saysWon(text: string, won: number): boolean {
  const plain = text.replace(/[\s,]/g, "");
  const tenThousands = Math.floor(won / 10_000);
  const rest = won % 10_000;
  return (
    new RegExp(`(?<!\\d)${won}(?!\\d)`).test(plain) ||
    (tenThousands > 0 && plain.includes(`${tenThousands}만${rest}원`))
  );
}

/** 최저임금 figures a model may know from before: 2024, 2025, 2026 and the 2027 decision. */
export const REMEMBERED_MINIMUM_WAGES = [9_860, 10_030, 10_320, 10_700];

/**
 * 올해 최저임금: the skill was read, 최저임금위원회's page opened, and the figure given is the one
 * that page says — never a remembered one — with its year and the link.
 */
export function judgeMinimumWageAnswer(input: {
  text: string;
  calls: readonly ObservedCall[];
  planted: { year: number; hourly: number };
}): Array<[string, boolean]> {
  const remembered = REMEMBERED_MINIMUM_WAGES.filter((won) =>
    saysWon(input.text, won),
  );
  const links = officialLinksIn(input.text);
  return [
    [`세금노무 스킬을 skill_view로 읽지 않음`, readSkill(input.calls)],
    [
      "최저임금위원회 페이지를 열지 않음",
      officialPagesOpened(input.calls).some((url) =>
        hostOf(url).endsWith("minimumwage.go.kr"),
      ),
    ],
    [
      `페이지의 시급(${input.planted.hourly.toLocaleString("en-US")}원)을 말하지 않음`,
      saysWon(input.text, input.planted.hourly),
    ],
    [
      `페이지에 없는 기억 속 금액을 말함: ${remembered.join(", ")}`,
      remembered.length === 0,
    ],
    [
      `적용 연도(${input.planted.year}년)를 말하지 않음`,
      input.text.includes(`${input.planted.year}`),
    ],
    [
      "답에 최저임금위원회 주소가 없음",
      links.some((link) => /minimumwage\.go\.kr/i.test(link)),
    ],
  ];
}

/* ── Relative days ──────────────────────────────────────────────────────────────────────────── */

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** "2026-09-29" → "화". */
export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

/** The day `days` after `date`, on the calendar. */
export function calendarDayAfter(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** A month and day nearest `today`, as a full date: December's 12/31 asked in January is last year. */
function fullDate(month: number, day: number, today: string): string {
  const year = Number(today.slice(0, 4));
  const candidates = [year - 1, year, year + 1].map(
    (y) =>
      `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );
  const distance = (date: string) =>
    Math.abs(
      new Date(`${date}T00:00:00Z`).getTime() -
        new Date(`${today}T00:00:00Z`).getTime(),
    );
  return candidates.reduce((best, date) =>
    distance(date) < distance(best) ? date : best,
  );
}

/** A month and a day as a Bot writes them: 9월 29일, 9/29, 9.29, 2026-09-29. */
const MONTH_DAY = String.raw`(?<!\d)(\d{1,2})\s*(?:월\s*(\d{1,2})\s*일|[/.\-]\s*(\d{1,2})(?!\d))`;
/**
 * What may stand between a date and its weekday: nothing, a bracket, a particle, a comma — or the
 * walk's own "모레(9/30 수)", a bare weekday closing the bracket the date opened.
 */
const DATE_THEN_DAY = new RegExp(
  `${MONTH_DAY}\\s*(?:[(（]\\s*([일월화수목금토])(?:요일)?\\s*[)）]|(?:이고|이며|은|는|이|,)?\\s*([일월화수목금토])요일|\\s([일월화수목금토])(?=\\s*[)）]))`,
  "g",
);
// Only in brackets: "모레는 화요일, 10월 1일은 목요일" would otherwise pair 화 with 10/1.
const DAY_THEN_DATE = new RegExp(
  `([일월화수목금토])요일\\s*[(（]\\s*${MONTH_DAY}`,
  "g",
);

/**
 * Every date an answer writes with a weekday beside it: 9월 29일 (화), 9월 29일은 화요일, 9/29(화),
 * 화요일(9/29). The weekday must stand right beside the date, or two things said apart are paired.
 */
export function datedWeekdaysIn(
  text: string,
  today: string,
): Array<{ date: string; weekday: string; said: string }> {
  const found: Array<{ date: string; weekday: string; said: string }> = [];
  const add = (month: number, day: number, weekday: string, said: string) => {
    if (month < 1 || month > 12 || day < 1 || day > 31 || !weekday) return;
    found.push({ date: fullDate(month, day, today), weekday, said });
  };
  for (const match of text.matchAll(DATE_THEN_DAY)) {
    add(
      Number(match[1]),
      Number(match[2] ?? match[3]),
      match[4] ?? match[5] ?? match[6] ?? "",
      match[0],
    );
  }
  for (const match of text.matchAll(DAY_THEN_DATE)) {
    add(
      Number(match[2]),
      Number(match[3] ?? match[4]),
      match[1] ?? "",
      match[0],
    );
  }
  return found;
}

/** Every date an answer writes, weekday or not, as a full date. */
export function datesIn(text: string, today: string): string[] {
  return [...text.matchAll(new RegExp(MONTH_DAY, "g"))]
    .map((match) => [Number(match[1]), Number(match[2] ?? match[3])] as const)
    .filter(
      ([month, day]) => month >= 1 && month <= 12 && day >= 1 && day <= 31,
    )
    .map(([month, day]) => fullDate(month, day, today));
}

/**
 * A relative day asked on `today`: the answer names `expected` — with its right weekday beside it,
 * unless the question named the weekday itself ("이번 주 토요일이 며칠이야?") — and no date in it
 * carries the wrong weekday.
 */
export function judgeRelativeDay(input: {
  text: string;
  today: string;
  expected: string;
  asked: string;
  weekdayNamed?: boolean;
}): Array<[string, boolean]> {
  const pairs = datedWeekdaysIn(input.text, input.today);
  const want = weekdayOf(input.expected);
  const [, month, day] = input.expected.split("-").map(Number);
  const wrong = pairs.filter((pair) => weekdayOf(pair.date) !== pair.weekday);
  const named = input.weekdayNamed
    ? datesIn(input.text, input.today).includes(input.expected)
    : pairs.some(
        (pair) => pair.date === input.expected && pair.weekday === want,
      );
  return [
    [
      input.weekdayNamed
        ? `${input.asked}(${month}월 ${day}일)을 못 셈`
        : `${input.asked}(${month}월 ${day}일 ${want}요일)을 날짜와 요일로 말하지 않음`,
      named,
    ],
    [
      `달력과 다른 요일: ${wrong.map((pair) => pair.said).join(" / ")}`,
      wrong.length === 0,
    ],
  ];
}

/* ── The walk's own 모레: a weather page read on a Sunday ──────────────────────────────────────── */

/**
 * 네이버 "춘천 날씨" as the Bot's browser read it on Sunday 2026-09-27 at 10:00 KST, from the weather
 * block to the 기상청 summary under it. Its hourly list ends "… 모레 … 23시 맑음 16 ° 09.30. 맑음",
 * and its week says "수 9.30. … 흐리고 한때 비": the walk's "비는 모레(9/30 수)" was read off this.
 */
export const CHUNCHEON_WEATHER = {
  url: "https://search.naver.com/search.naver?query=춘천 날씨",
  title: "춘천 날씨 : 네이버 검색",
  text: "공유 춘천 날씨 검색 결과 강원특별자치도 춘천시 옥천동 기준 오늘 내일 모레 전망 과거 날씨 제공사 설정 기상청 아큐웨더 웨더채널 웨더뉴스 예보비교 오늘의 날씨 구름많음 현재 온도 16.5° 어제보다 0.2° 낮아요\n구름많음\n체감 19.1° 습도 93% 서풍 1.1m/s\n미세먼지 좋음 초미세먼지 좋음 자외선 보통 일몰 18:19 날씨를 공유해보세요! 날씨 제보톡 CCTV 날씨 지도 시간별 예보 날씨 강수 바람 습도 10시 구름많음 20 ° 11시 구름많음 22 ° 12시 구름많음\n25 ° 13시 맑음 26 ° 14시 맑음 27 ° 15시 맑음 27 ° 16시 맑음 27 ° 17시 맑음 26 ° 18시 맑음 24 ° 19시 맑음 22 ° 20시 맑음 20 ° 21시 구름많음 19 ° 22시\n맑음 18 ° 23시 맑음 18 ° 내일 맑음 17 ° 01시 맑음 17 ° 02시 구름많음 17 ° 03시 구름많음 16 ° 04시 흐림 16 ° 05시 흐림 16 ° 06시 흐림 16 ° 07시 흐림 16 °\n08시 흐림 17 ° 09시 구름많음 18 ° 10시 맑음 20 ° 11시 맑음 22 ° 12시 맑음 24 ° 13시 맑음 24 ° 14시 맑음 25 ° 15시 맑음 25 ° 16시 맑음 25 ° 17시 맑음 24\n° 18시 맑음 22 ° 19시 맑음 20 ° 20시 맑음 18 ° 21시 맑음 17 ° 22시 맑음 16 ° 23시 맑음 15 ° 모레 맑음 15 ° 01시 흐림 14 ° 02시 맑음 14 ° 03시 구름많음 14\n° 04시 구름많음 13 ° 05시 흐림 13 ° 06시 맑음 12 ° 07시 맑음 13 ° 08시 맑음 14 ° 09시 맑음 16 ° 10시 맑음 18 ° 11시 맑음 21 ° 12시 맑음 23 ° 13시 맑음\n24 ° 14시 맑음 25 ° 15시 맑음 25 ° 16시 맑음 25 ° 17시 맑음 24 ° 18시 맑음 21 ° 19시 맑음 19 ° 20시 맑음 18 ° 21시 맑음 17 ° 22시 맑음 16 ° 23시 맑음\n16 ° 09.30. 맑음 15 ° 다음 주간예보 도움말 최저 최고 기준 오늘 9.27. 오전 0% 맑음 오후 0% 맑음 최저기온 15° 최고기온 28° 내일 9.28. 40% 흐림 0% 맑음 최저기온 16°\n최고기온 26° 화 9.29. 0% 맑음 0% 맑음 최저기온 11° 최고기온 25° 수 9.30. 20% 구름많음 60% 흐리고 한때 비 최저기온 13° 최고기온 25° 목 10.01. 10% 맑음 10% 맑음\n최저기온 7° 최고기온 20° 금 10.02. 10% 맑음 10% 맑음 최저기온 6° 최고기온 20° 토 10.03. 10% 맑음 10% 맑음 최저기온 7° 최고기온 21° 일 10.04. 20% 구름많음 20%\n구름많음 최저기온 10° 최고기온 21° 월 10.05. 20% 구름많음 20% 구름많음 최저기온 9° 최고기온 21° 화 10.06. 20% 구름많음 20% 구름많음 최저기온 9° 최고기온 22° 기상청, 웨더아이\n제공, 업데이트 기준 도움말 관련 날씨뉴스, 전국날씨, 기상특보 날씨 더보기 기상청 날씨누리\nwww.weather.go.kr›short-term\n새 창 열림 예보 종합 - 단기예보 새 창 열림\n□ (종합) 오늘 오전까지 내륙 중심 짙은 안개, 오늘 남부지방과 제주도 비 또는 소나기, 모레 동해안 중심 비 ○ (오늘, 27일) 중부지방과 전북 대체로 맑겠으나, 충청권 밤부터 구름많아짐, 남부지방과 제주도 대체로 흐림",
} as const;

const RELATIVE_WORDS: Readonly<Record<string, number>> = {
  오늘: 0,
  내일: 1,
  모레: 2,
  글피: 3,
};

/** A day of the month alone, as in "내일(28일, 월)": the month nearest `today` that has it. */
function dayOnlyDate(day: number, today: string): string {
  const [year, month] = today.split("-").map(Number) as [number, number];
  const candidates = [-1, 0, 1].map((shift) => {
    const at = new Date(Date.UTC(year, month - 1 + shift, day));
    return at.getUTCDate() === day ? at.toISOString().slice(0, 10) : "";
  });
  const distance = (date: string) =>
    date
      ? Math.abs(
          new Date(`${date}T00:00:00Z`).getTime() -
            new Date(`${today}T00:00:00Z`).getTime(),
        )
      : Number.POSITIVE_INFINITY;
  return candidates.reduce((best, date) =>
    distance(date) < distance(best) ? date : best,
  );
}

/** A weekday standing alone: 수, 수요일 — not the 일 of 일찍 or the 월 of 월급. */
const A_WEEKDAY = "([일월화수목금토])(?:요일)?(?![가-힣])";

/**
 * 오늘·내일·모레·글피 written right beside a date or a weekday: "모레(9/30 수)", "내일 9월 28일",
 * "모레인 9/29", "내일(28일, 월)", "모레, 수요일". A word and a day said apart are not paired.
 */
export function relativeWordsIn(
  text: string,
  today: string,
): Array<{ word: string; date: string; weekday: string; said: string }> {
  const pattern = new RegExp(
    `(오늘|내일|모레|글피)\\s*(?:은|는|인|이고|,)?\\s*[(（]?\\s*(?:${A_WEEKDAY}\\s*,?\\s*)?(?:${MONTH_DAY}|(?<!\\d)(\\d{1,2})\\s*일(?![가-힣]))?(?:\\s*,?\\s*${A_WEEKDAY})?`,
    "g",
  );
  const found: Array<{
    word: string;
    date: string;
    weekday: string;
    said: string;
  }> = [];
  for (const match of text.matchAll(pattern)) {
    const [said, word = "", before, month, day, slashDay, dayOnly, after] =
      match;
    const weekday = before ?? after ?? "";
    let date = "";
    if (month) {
      const monthNumber = Number(month);
      const dayNumber = Number(day ?? slashDay);
      if (monthNumber >= 1 && monthNumber <= 12 && dayNumber >= 1) {
        date = fullDate(monthNumber, dayNumber, today);
      }
    } else if (dayOnly) {
      date = dayOnlyDate(Number(dayOnly), today);
    }
    if (date || weekday) found.push({ word, date, weekday, said: said.trim() });
  }
  return found;
}

/**
 * 비 오는 날, read off the page on `today`: the rainy day is named (by its date or its weekday), no
 * 오늘·내일·모레·글피 stands beside the wrong date or weekday, and no date carries the wrong weekday.
 */
export function judgeRainDay(input: {
  text: string;
  today: string;
  rainy: string;
}): Array<[string, boolean]> {
  const misnamed = relativeWordsIn(input.text, input.today).filter((found) => {
    const meant = calendarDayAfter(
      input.today,
      RELATIVE_WORDS[found.word] ?? 0,
    );
    return (
      (found.date !== "" && found.date !== meant) ||
      (found.weekday !== "" && found.weekday !== weekdayOf(meant))
    );
  });
  const wrong = datedWeekdaysIn(input.text, input.today).filter(
    (pair) => weekdayOf(pair.date) !== pair.weekday,
  );
  const [, month, day] = input.rainy.split("-").map(Number);
  const rainyWeekday = weekdayOf(input.rainy);
  return [
    [
      `비 오는 날(${month}월 ${day}일 ${rainyWeekday}요일)을 말하지 않음`,
      datesIn(input.text, input.today).includes(input.rainy) ||
        input.text.includes(`${rainyWeekday}요일`),
    ],
    [
      `날짜를 잘못 부름: ${misnamed.map((found) => found.said).join(" / ")}`,
      misnamed.length === 0,
    ],
    [
      `달력과 다른 요일: ${wrong.map((pair) => pair.said).join(" / ")}`,
      wrong.length === 0,
    ],
  ];
}
