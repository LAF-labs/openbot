/**
 * WHAT A BROWSING CARD AND THE BANNER ARE CALLED.
 *
 * MEASURED 2026-09-24 (UI/UX audit, item 13), and again the same day on a local stack with
 * "네이버에서 서울, 부산, 제주 오늘 날씨": the cards were titled `search.naver.com` and said
 * "완료 · 3단계" — a host a person never typed and a count nobody asked for. The title is now the
 * site as people call it and what they asked for there.
 *
 * `t()` reads the site names through a variable, which `i18n-coverage.test.ts` cannot see, so this
 * walks the table the way `agent-refusals.test.ts` walks its own.
 */
import { describe, expect, test } from "bun:test";
import {
  EVERYDAY_SITES,
  plainLine,
  siteNameOf,
  siteNamesOf,
  taskOf,
  taskTitle,
} from "../src/components/computer/task-title";
import { ko } from "../src/lib/i18n-ko";

describe("the site's name", () => {
  test("every everyday site has its Korean name", () => {
    for (const site of EVERYDAY_SITES) {
      expect(ko[site.name]).toBeString();
      expect(ko[site.name]?.length).toBeGreaterThan(0);
    }
  });

  test("the most specific name wins, and a subdomain counts", () => {
    expect(siteNameOf("search.shopping.naver.com")).toBe("Naver Shopping");
    expect(siteNameOf("search.naver.com")).toBe("Naver");
    expect(siteNameOf("m.weather.naver.com")).toBe("Naver Weather");
    expect(siteNameOf("www.yes24.com")).toBe("YES24");
  });

  test("a business site is named as the 연결 screen names it", () => {
    expect(siteNameOf("ceo.baemin.com")).toBe("Baemin for Owners");
    expect(siteNameOf("sell.smartstore.naver.com")).toBe(
      "Naver Smart Store Seller Centre",
    );
  });

  test("a host nobody named is the host, without www", () => {
    expect(siteNameOf("www.example.org")).toBe("example.org");
  });

  test("two hosts of one site are one name", () => {
    expect(siteNamesOf(["naver.com", "search.naver.com", "yes24.com"])).toEqual(
      ["Naver", "YES24"],
    );
  });
});

describe("what was asked, as half a title", () => {
  test("the request without its 'please'", () => {
    expect(taskOf("원두 1kg 가격 비교해 줘", null)).toBe("원두 1kg 가격 비교");
    expect(taskOf("오늘 날씨 알려줘.", null)).toBe("오늘 날씨");
    expect(taskOf("우리 동네 날씨", null)).toBe("우리 동네 날씨");
  });

  test("without the '…에서' the site half already says", () => {
    expect(
      taskOf("네이버 쇼핑에서 원두 1kg 가격 비교해 줘", "네이버 쇼핑"),
    ).toBe("원두 1kg 가격 비교");
    expect(taskOf("예스24 홈페이지에서 소년이 온다 찾아줘", "예스24")).toBe(
      "소년이 온다",
    );
    // A part of the site named more exactly is still the site the other half names.
    expect(
      taskOf("네이버 쇼핑에서 크라프트 봉투 찾아서 알려줘", "네이버"),
    ).toBe("크라프트 봉투 찾아서");
    // A different place is part of the request and stays.
    expect(taskOf("쿠팡에서 원두 찾아줘", "네이버 쇼핑")).toBe("쿠팡에서 원두");
  });

  test("the first sentence says what the task is; the rest says how", () => {
    expect(
      taskOf(
        "서울, 부산 오늘 날씨 확인해 줘. 도시 하나 열기 전에 한 줄씩 말해 줘.",
        null,
      ),
    ).toBe("서울, 부산 오늘 날씨 확인");
  });

  test("the first line only, and a skill chip is not the task", () => {
    expect(taskOf("/weekly-report 이번 주 매출\n자세히", null)).toBe(
      "이번 주 매출",
    );
  });

  test("nothing left is no half at all", () => {
    expect(taskOf("해 줘", null)).toBeNull();
    expect(taskOf(undefined, "네이버")).toBeNull();
  });
});

describe("the whole title", () => {
  test("site · task, named for where the task ended up", () => {
    // Tests read the English keys; on a Korean screen this is "네이버 쇼핑 · 원두 1kg 가격 비교".
    expect(
      taskTitle(
        ["naver.com", "search.shopping.naver.com"],
        "원두 1kg 가격 비교해 줘",
      ),
    ).toBe("Naver Shopping · 원두 1kg 가격 비교");
  });

  test("the person's own, more exact name for the site, said once", () => {
    /*
     * Measured on MiMo: the price comparison lives on search.naver.com, and the card read
     * "네이버 · 네이버 쇼핑에서 빵 포장용 크라프트 봉투 …". Tests read the English keys, so the person
     * says the English name here; on a Korean screen both halves are Korean and match the same way.
     */
    expect(
      taskTitle(
        ["search.naver.com"],
        "Naver Shopping에서 크라프트 봉투 가격 비교해 줘",
      ),
    ).toBe("Naver Shopping · 크라프트 봉투 가격 비교");
    // A different place is not the site named more exactly.
    expect(taskTitle(["search.naver.com"], "쿠팡에서 원두 찾아줘")).toBe(
      "Naver · 쿠팡에서 원두",
    );
  });

  test("either half alone, and nothing for neither", () => {
    expect(taskTitle([], "소년이 온다 가격 알려줘")).toBe("소년이 온다 가격");
    expect(taskTitle(["yes24.com"], undefined)).toBe("YES24");
    expect(taskTitle([], undefined)).toBeNull();
  });
});

test("one line of what the Bot said, without the marks a bubble would draw", () => {
  expect(plainLine("## 가게 마감\n1. 불 끄기")).toBe("가게 마감");
  expect(plainLine("**서울** 확인했어요")).toBe("서울 확인했어요");
});
