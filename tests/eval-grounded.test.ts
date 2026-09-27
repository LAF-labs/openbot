import { describe, expect, test } from "bun:test";
import {
  calendarDayAfter,
  datedWeekdaysIn,
  headCountExemptionIn,
  judgeMinimumWageAnswer,
  judgePayrollAnswer,
  judgeRainDay,
  judgeRelativeDay,
  officialSite,
  PAYROLL_PAGES,
  plantedMinimumWage,
} from "../evals/grounded";
import type { ObservedCall } from "../evals/lib";

/**
 * THE JUDGES OF THE 세금노무 AND RELATIVE-DAY SCENARIOS, JUDGED.
 *
 * The scenarios call a real model and never run in the gate, so a judge that could not fail would
 * pass every model for ever. Each is handed the walk's own wrong answer (2026-09-27, DeepSeek V4.1
 * Flash) and the ways a right one is written — Korean says "not exempt" in as many ways as "exempt".
 */

const call = (name: string, args: Record<string, unknown>): ObservedCall => ({
  id: `c_${name}_${JSON.stringify(args).length}`,
  name,
  rawArguments: JSON.stringify(args),
  arguments: args,
});

const GROUNDED: ObservedCall[] = [
  call("skill_view", { name: "세금노무" }),
  call("computer_navigate", {
    url: "https://www.4insure.or.kr/pbiz/feii/joinTrgtIntroView.do",
  }),
];

const RIGHT_PAYROLL = [
  "직원 월급에서 떼는 건 두 가지예요.",
  "1. 4대보험 근로자 몫(2026년 기준): 국민연금 4.75%, 건강보험 3.595%, 장기요양은 건강보험료 × 0.9448/7.19, 고용보험 0.9%.",
  "2. 근로소득세와 지방소득세: 월급과 부양가족 수로 정해져요. 홈택스 '근로소득 간이세액표'에서 보시거나 국세청 126에 물어보세요.",
  "직원이 1명이라도 있으면 4대보험은 모두 의무예요. 5인 미만이어도 마찬가지예요.",
  "출처: https://www.4insure.or.kr/pbiz/feii/joinTrgtIntroView.do",
].join("\n");

describe("a small workplace exempt by head count", () => {
  test.each([
    "직원 수가 5명 미만이면 국민연금은 사업장 의무가 아니고, 건강보험·고용보험·산재보험만 들면 돼요.",
    "5인 미만 사업장은 국민연금 가입이 선택이에요.",
    "상시근로자 5명 미만이라 고용보험은 가입하지 않아도 됩니다.",
    "직원이 4명 이하인 소규모 사업장은 산재보험 적용 제외예요.",
    "5명 미만은 국민연금 의무가입 대상이 아니에요.",
    "5인 미만 사업장이면 국민연금 의무가 있는 건 아니에요.",
  ])("is found: %s", (sentence) => {
    expect(
      headCountExemptionIn(`월급에서 떼는 것 알려 드릴게요.\n${sentence}`),
    ).toBe(sentence);
  });

  test.each([
    "직원이 1명이라도 있으면 4대보험은 모두 의무 가입이에요(5인 미만이어도 마찬가지예요).",
    "1인 이상의 근로자를 사용하는 모든 사업장은 국민연금·건강보험·고용보험·산재보험 당연적용(의무가입) 대상이에요.",
    "5인 미만이라서 4대보험을 안 해도 되는 게 아니에요.",
    "근로기준법은 5인 미만 사업장에 일부만 적용되지만, 4대보험은 직원이 1명만 있어도 의무예요.",
    "5인 미만 사업장도 고용·산재보험 적용 제외 대상이 아니에요.",
    "5인 미만이어도 국민연금·건강보험은 제외되지 않아요.",
    "농업·어업 중 법인이 아닌 5명 미만 사업은 산재보험 적용 제외인데, 음식점은 해당하지 않아요.",
  ])("is not found where the sentence says the opposite: %s", (sentence) => {
    expect(headCountExemptionIn(sentence)).toBeNull();
  });
});

describe("the payroll judge", () => {
  test("passes an answer read off the pages, with its link and year", () => {
    const verdict = judgePayrollAnswer({
      text: RIGHT_PAYROLL,
      calls: GROUNDED,
    });
    expect(verdict.filter(([, ok]) => !ok)).toEqual([]);
  });

  test("fails the walk's answer, which named no source, no year, and exempted a small shop", () => {
    const walk =
      "직원 월급에서 떼는 건 4대보험과 소득세예요. 직원 수가 5명 미만이면 국민연금은 사업장 의무가 아니고, 건강보험 3.545%, 고용보험 0.9%를 떼면 돼요.";
    const failed = judgePayrollAnswer({ text: walk, calls: [] })
      .filter(([, ok]) => !ok)
      .map(([label]) => label);
    expect(failed).toHaveLength(5);
    expect(failed.join("\n")).toContain(
      "5명 미만이면 국민연금은 사업장 의무가 아니고",
    );
  });

  test("a rate needs its year; a link to a blog is no official source", () => {
    const noYear = RIGHT_PAYROLL.replace("(2026년 기준)", "");
    const blog = RIGHT_PAYROLL.replace(
      "https://www.4insure.or.kr/pbiz/feii/joinTrgtIntroView.do",
      "https://blog.naver.com/someone/123",
    );
    const failing = (text: string) =>
      judgePayrollAnswer({ text, calls: GROUNDED })
        .filter(([, ok]) => !ok)
        .map(([label]) => label);
    expect(failing(noYear)).toEqual([
      "요율을 말하면서 몇 년 기준인지 말하지 않음",
    ]);
    expect(failing(blog)).toEqual(["답에 공식 출처 주소가 없음"]);
    // The site named by its host is named: the product draws the links as a sources chip.
    const host = RIGHT_PAYROLL.replace(
      "https://www.4insure.or.kr/pbiz/feii/joinTrgtIntroView.do",
      "4insure.or.kr (4대 사회보험 소개 > 가입대상)",
    );
    expect(failing(host)).toEqual([]);
    expect(failing("")).toContain("답하지 않음(페이지만 열다 끝남)");
    expect(
      failing(RIGHT_PAYROLL.replace(/출처: .*$/m, "출처: naver.com 검색")),
    ).toEqual(["답에 공식 출처 주소가 없음"]);
  });
});

describe("the 최저임금 judge", () => {
  const planted = { year: 2026, hourly: 10_987 };
  const opened = [
    call("skill_view", { name: "/세금노무" }),
    call("computer_navigate", { url: "https://www.minimumwage.go.kr/" }),
  ];

  test("passes the page's figure however it is written, with the year and the link", () => {
    for (const figure of ["10,987원", "10987원", "1만 987원"]) {
      const text = `2026년 최저임금은 시급 ${figure}이에요. https://www.minimumwage.go.kr/`;
      const failed = judgeMinimumWageAnswer({
        text,
        calls: opened,
        planted,
      }).filter(([, ok]) => !ok);
      expect(failed).toEqual([]);
    }
  });

  test("fails a remembered figure, even beside the page's", () => {
    const text =
      "2026년 최저임금은 시급 10,320원이에요(페이지에는 10,987원). https://www.minimumwage.go.kr/";
    const failed = judgeMinimumWageAnswer({ text, calls: opened, planted })
      .filter(([, ok]) => !ok)
      .map(([label]) => label);
    expect(failed).toEqual(["페이지에 없는 기억 속 금액을 말함: 10320"]);
  });

  test("fails an answer from memory with no page opened", () => {
    const failed = judgeMinimumWageAnswer({
      text: "올해 최저임금은 시급 10,320원이에요.",
      calls: [],
      planted,
    }).filter(([, ok]) => !ok);
    expect(failed).toHaveLength(6);
  });

  test("the planted page carries this year's figure, and the site stub serves it", () => {
    const { pages, year, hourly } = plantedMinimumWage(
      new Date("2026-09-27T01:00:00Z"),
      "Asia/Seoul",
    );
    expect(year).toBe(2026);
    const site = officialSite(pages);
    const read = JSON.parse(
      site.answer(
        call("computer_navigate", { url: "https://minimumwage.go.kr" }),
      ) ?? "{}",
    );
    expect(read.text).toContain(
      `2026년 적용 최저임금 시급 ${hourly.toLocaleString("en-US")}원`,
    );
  });
});

describe("the official pages' browser", () => {
  test("the 요율 page opens on its first tab, names its tabs, and a click shows one", () => {
    const site = officialSite(PAYROLL_PAGES);
    const opened = JSON.parse(
      site.answer(
        call("computer_navigate", {
          url: "https://www.4insure.or.kr/pbiz/feii/inscIntroView.do",
        }),
      ) ?? "{}",
    );
    expect(opened.text).not.toContain("9.5%");
    const snapshot = JSON.parse(
      site.answer(call("computer_snapshot", {})) ?? "{}",
    );
    expect(snapshot.elements).toContain("국민연금");
    const ref = /^(t\d) link 국민연금$/m.exec(snapshot.elements)?.[1];
    expect(ref).toBe("t2");
    site.answer(call("computer_click", { ref }));
    const read = JSON.parse(site.answer(call("computer_read", {})) ?? "{}");
    expect(read.text).toContain("9.5%");
  });

  test("홈택스 under any path is its home shell; an unknown page is not the shop fixture", () => {
    const site = officialSite(PAYROLL_PAGES);
    const hometax = JSON.parse(
      site.answer(
        call("computer_navigate", {
          url: "https://teht.hometax.go.kr/websquare/websquare.html?w2xPath=/ui/sf/a/a/UTESFAAF99.xml",
        }),
      ) ?? "{}",
    );
    expect(hometax.title).toBe("국세청 홈택스");
    const missing = JSON.parse(
      site.answer(
        call("computer_navigate", { url: "https://www.nps.or.kr/x.do" }),
      ) ?? "{}",
    );
    expect(missing.text).toContain("찾을 수 없습니다");
    expect(site.opened).toHaveLength(2);
  });
});

describe("relative days", () => {
  const tuesday = "2026-09-29";

  test("the dates and weekdays an answer writes, in the forms a Bot writes them", () => {
    const pairs = datedWeekdaysIn(
      "모레는 10월 1일(목)이고, 9/30 수요일이 내일, 이번 주 토요일은 10월 3일은 토요일, 비는 모레(10/1 목), 다음 주 월요일(10/5).",
      tuesday,
    );
    expect(pairs.map((pair) => `${pair.date} ${pair.weekday}`)).toEqual([
      "2026-10-01 목",
      "2026-09-30 수",
      "2026-10-03 토",
      "2026-10-01 목",
      "2026-10-05 월",
    ]);
  });

  test("the walk's 모레 on a Sunday fails: 9/30 is the day after it", () => {
    const failed = judgeRelativeDay({
      text: "비는 모레(9/30 수)에 온대요.",
      today: "2026-09-27",
      expected: calendarDayAfter("2026-09-27", 2),
      asked: "모레",
    }).filter(([, ok]) => !ok);
    expect(failed.map(([label]) => label)).toEqual([
      "모레(9월 29일 화요일)을 날짜와 요일로 말하지 않음",
    ]);
  });

  test("a right date with a wrong weekday fails, and a named weekday needs only the date", () => {
    const wrongDay = judgeRelativeDay({
      text: "모레는 10월 1일 수요일이에요.",
      today: tuesday,
      expected: "2026-10-01",
      asked: "모레",
    }).filter(([, ok]) => !ok);
    expect(wrongDay).toHaveLength(2);
    const saturday = judgeRelativeDay({
      text: "이번 주 토요일은 10월 3일이에요. 개천절이네요.",
      today: tuesday,
      expected: "2026-10-03",
      asked: "이번 주 토요일",
      weekdayNamed: true,
    }).filter(([, ok]) => !ok);
    expect(saturday).toEqual([]);
    const right = judgeRelativeDay({
      text: "내일은 9월 30일, 수요일이에요.",
      today: tuesday,
      expected: "2026-09-30",
      asked: "내일",
    }).filter(([, ok]) => !ok);
    expect(right).toEqual([]);
  });
});

describe("the walk's own 모레, on the weather page", () => {
  const sunday = "2026-09-27";
  const rainy = "2026-09-30";
  const failing = (text: string) =>
    judgeRainDay({ text, today: sunday, rainy })
      .filter(([, ok]) => !ok)
      .map(([label]) => label);

  test("the walk's answer fails: 9/30 is 글피, not 모레", () => {
    expect(failing("비는 모레(9/30 수) 오후에 한때 와요.")).toEqual([
      "날짜를 잘못 부름: 모레(9/30 수",
    ]);
  });

  test("so does 모레 beside Wednesday with no date at all (measured, 1 run in 10)", () => {
    expect(
      failing("정리하면 비는 모레 모레, 수요일 오후 한 번이에요."),
    ).toEqual(["날짜를 잘못 부름: 모레, 수요일"]);
  });

  test("the days named right pass, however they are written", () => {
    expect(
      failing(
        [
          "- 내일(9/28): 흐림, 16~26°",
          "- 모레(29일, 화): 맑음",
          "비는 9/30 수요일 오후에 올 전망이고, 글피(9월 30일)만 챙기시면 돼요.",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(failing("수요일 오후에 비가 와요. 내일 일찍 준비하세요.")).toEqual(
      [],
    );
  });

  test("an answer that never names the rainy day fails", () => {
    expect(failing("며칠 동안은 맑아요.")).toEqual([
      "비 오는 날(9월 30일 수요일)을 말하지 않음",
    ]);
  });
});
