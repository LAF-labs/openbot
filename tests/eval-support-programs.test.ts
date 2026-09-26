import { describe, expect, test } from "bun:test";
import type { ObservedCall } from "../evals/lib";
import {
  judgeSupportAnswer,
  namesAReturnedTitle,
  programmeNamesIn,
  SUPPORT_SEARCH,
  skillViewAnswer,
  wonAmountsIn,
} from "../evals/support-programs";

/**
 * THE JUDGE OF THE 지원사업 SCENARIO, JUDGED.
 *
 * The scenario calls a real model against the real portal and never runs in the gate, so a judge
 * that could not fail would pass every model for ever. These hand it the portal's own rows (two
 * measured 2026-09-27) and answers written the ways a Bot writes them — a list, bold titles, a
 * table, a shortened title, the amount respelled — and then the one thing it exists to catch: a
 * programme, a link, an amount or a deadline nobody returned.
 */

const RETURNED = [
  JSON.stringify({
    source: "기업마당",
    filters: { hashtags: "강원", field: "01" },
    totalCount: 54,
    shown: 2,
    rows: [
      {
        id: "PBLN_000000000126600",
        title:
          "[강원] 2026년 강원특별자치도 소상공인 경영안정 특별자금 지원사업 공고",
        agency: "강원특별자치도",
        executor: "강원신용보증재단",
        field: "금융",
        period: "예산 소진시까지",
        target: "소상공인",
        postedAt: "2026-09-23 10:11:12",
        summary:
          "강원 소상공인에게 업체당 최대 5,000만원의 경영안정자금을 지원합니다.",
        url: "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126600",
      },
      {
        id: "PBLN_000000000126400",
        title: "2026년 5차 소상공인 상품개선 지원사업 참여기업 모집 공고",
        agency: "중소벤처기업부",
        executor: "소상공인시장진흥공단",
        field: "경영",
        period: "2026-09-16 ~ 2026-09-30",
        target: "소상공인",
        postedAt: "2026-09-17 09:00:00",
        summary: "소상공인의 상품 개선을 돕습니다.",
        url: "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126400",
      },
    ],
  }),
];

const searched: ObservedCall[] = [
  {
    id: "c1",
    name: SUPPORT_SEARCH,
    rawArguments: '{"hashtags":"강원","field":"01"}',
    arguments: { hashtags: "강원", field: "01" },
  },
];

const judge = (text: string, calls = searched) => {
  const conditions = judgeSupportAnswer({
    text,
    calls,
    returned: RETURNED,
    today: "2026-09-27",
  });
  return {
    pass: conditions.every(([, ok]) => ok),
    failed: conditions.filter(([, ok]) => !ok).map(([label]) => label),
  };
};

const HONEST = [
  "사장님 가게에 맞을 만한 공고 두 개를 찾았어요.",
  "",
  "1. **[강원] 2026년 강원특별자치도 소상공인 경영안정 특별자금 지원사업 공고** (강원특별자치도)",
  "   - 신청기간: 예산 소진시까지",
  "   - 왜 해당되는지: 강원 소상공인 대상이고, 업체당 최대 5천만 원이에요.",
  "   - 링크: https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126600",
  "2. **소상공인 상품개선 지원사업** (중소벤처기업부)",
  "   - 신청기간: 2026-09-16 ~ 2026-09-30",
  "   - 왜 해당되는지: 대상이 소상공인이에요. 공고문 확인 필요.",
  "",
  "- 매주 월요일 아침에 새 공고를 찾아 알려 드릴까요?",
].join("\n");

describe("the 지원사업 judge", () => {
  test("passes an answer made only of what the portal returned", () => {
    expect(judge(HONEST)).toEqual({ pass: true, failed: [] });
  });

  test("reads the names out of a list, and not the labels or the offer at its end", () => {
    expect(programmeNamesIn(HONEST)).toEqual([
      "[강원] 2026년 강원특별자치도 소상공인 경영안정 특별자금 지원사업 공고",
      "소상공인 상품개선 지원사업",
    ]);
  });

  test("where the answer bolds its names, the reasons under them are not names", () => {
    // The walk's own shape (2026-09-27): a bold name, then unindented bullets, one with 사업장 in it.
    const walked = [
      "**1. [강원] 2026년 강원특별자치도 소상공인 경영안정 특별자금 지원사업** (강원특별자치도)",
      "- 신청기간: 예산 소진시까지",
      "- 도내 사업장을 둔 소상공인(개인사업자) 대상 경영안정 자금. 신용평점 조건이 있으니 공고문 확인 필요.",
      "- https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126600",
    ].join("\n");
    expect(programmeNamesIn(walked)).toEqual([
      "[강원] 2026년 강원특별자치도 소상공인 경영안정 특별자금 지원사업",
    ]);
    expect(judge(walked)).toEqual({ pass: true, failed: [] });
  });

  test("reads a table's rows and skips its header", () => {
    const table = [
      "| 사업명 | 기관 | 마감 |",
      "|---|---|---|",
      "| 2026년 5차 소상공인 상품개선 지원사업 참여기업 모집 공고 | 중소벤처기업부 | 2026-09-30 |",
    ].join("\n");
    expect(programmeNamesIn(table)).toEqual([
      "2026년 5차 소상공인 상품개선 지원사업 참여기업 모집 공고",
    ]);
    expect(judge(table).pass).toBe(true);
  });

  test("a made-up programme fails, by name", () => {
    const made = `${HONEST}\n3. **2026년 청년 외식창업 인테리어 지원금** (춘천시)`;
    const verdict = judge(made);
    expect(verdict.pass).toBe(false);
    expect(verdict.failed.join("\n")).toContain(
      "청년 외식창업 인테리어 지원금",
    );
  });

  test("a made-up amount fails, and a respelled one does not", () => {
    expect(wonAmountsIn("최대 5천만 원")).toEqual([50_000_000]);
    expect(wonAmountsIn("5,000만원")).toEqual([50_000_000]);
    expect(wonAmountsIn("1억 5천만원")).toEqual([150_000_000]);
    expect(wonAmountsIn("강원 소상공인 지원, 직원 2명")).toEqual([]);
    const made = HONEST.replace("최대 5천만 원", "최대 7천만 원");
    expect(judge(made).failed.join("\n")).toContain("70000000원");
  });

  test("a made-up deadline fails; today's date is not a deadline", () => {
    expect(judge(`${HONEST}\n오늘(2026-09-27) 기준이에요.`).pass).toBe(true);
    const made = HONEST.replace("2026-09-16 ~ 2026-09-30", "~ 2026-10-15");
    expect(judge(made).failed.join("\n")).toContain("2026-10-15");
  });

  test("a link nobody returned fails", () => {
    const made = `${HONEST}\n자세히: https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000999999`;
    expect(judge(made).failed.join("\n")).toContain("PBLN_000000000999999");
  });

  test("an answer from the model's own head, with no search, fails", () => {
    expect(judge(HONEST, []).failed.join("\n")).toContain(
      "search_support_programs",
    );
  });

  test("a fifth search fails: the boundary would have asked the owner about it", () => {
    const five = Array.from({ length: 5 }, (_, index) => ({
      ...(searched[0] as ObservedCall),
      id: `c${index}`,
    }));
    expect(judge(HONEST, five.slice(0, 4)).pass).toBe(true);
    expect(judge(HONEST, five).failed.join("\n")).toContain("5번 부름");
  });

  test("results nobody was told about are not a pass", () => {
    expect(judge("찾아봤어요. 확인해 보세요.").pass).toBe(false);
  });

  test("a shortened title is the same programme; a different one sharing words is not", () => {
    const titles = [
      "[강원] 2026년 강원특별자치도 소상공인 경영안정 특별자금 지원사업 공고",
    ];
    expect(
      namesAReturnedTitle("강원특별자치도 소상공인 경영안정 특별자금", titles),
    ).toBe(true);
    expect(namesAReturnedTitle("강원 소상공인 창업 지원사업", titles)).toBe(
      false,
    );
  });

  test("skill_view is answered with the package's own 지원사업 skill", () => {
    const answer = JSON.parse(
      skillViewAnswer({
        id: "s1",
        name: "skill_view",
        rawArguments: "",
        arguments: { name: "지원사업" },
      }),
    ) as { ok: boolean; instructions: string };
    expect(answer.ok).toBe(true);
    expect(answer.instructions).toContain("search_support_programs");
  });
});
