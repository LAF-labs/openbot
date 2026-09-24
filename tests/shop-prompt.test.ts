import { describe, expect, test } from "bun:test";
import { composePrompt, type PromptMode } from "../shared/prompt";
import {
  BUSINESS_KIND_KO,
  PLACE_KO,
  SHOP_PLACES_SHOWN,
  shopText,
} from "../shared/prompt/shop.ko";
import { estimateTokens } from "../shared/prompt/skill-index";
import {
  BUSINESS_KINDS,
  DAILY_PLACES,
  EMPTY_SHOP,
  type ShopProfile,
} from "../shared/shop/catalogue";

/**
 * The line every Bot is told about the business it works for.
 *
 * Every token of it rides in front of every turn of every Bot, so the properties worth pinning are
 * that it says nothing when there is nothing to say, that it stays short when there is a lot, and
 * that it says only facts and where to start — never anything about asking or not asking, which is
 * the boundary's to decide and never a prompt's.
 */

const shop = (kind: ShopProfile["kind"], places: string[] = []) => ({
  kind,
  places,
});

describe("the shop line", () => {
  test("says nothing when nothing was answered", () => {
    expect(shopText(undefined)).toBe("");
    expect(shopText(EMPTY_SHOP)).toBe("");
  });

  test("says nothing for 그 밖에 alone, which is an answer with nothing in it", () => {
    expect(shopText(shop("other"))).toBe("");
  });

  test("is one short line for a kind alone", () => {
    expect(shopText(shop("food"))).toBe("이 사람이 하는 일: 음식점·카페.");
  });

  test("names the places in the order they were picked, with where each site is", () => {
    const text = shopText(shop("food", ["baemin-ceo", "naver-smartplace"]));
    const [facts, use, ...rest] = text.split("\n");
    expect(rest).toEqual([]);
    expect(facts).toBe(
      "이 사람이 하는 일: 음식점·카페. 매일 쓰는 곳: 배달의민족(ceo.baemin.com), 네이버 스마트플레이스(new.smartplace.naver.com).",
    );
    // Where to start and what to do about a place that is not connected — and nothing else.
    expect(use).toContain("이 곳들을 먼저 떠올리고");
    expect(use).toContain("연결부터 권한다");
  });

  test("gives an account no address: a Bot reaches it through its tools, not a page", () => {
    const text = shopText(shop(null, ["gmail", "cafe24"]));
    expect(text.split("\n")[0]).toBe("매일 쓰는 곳: 지메일, 카페24.");
  });

  test("skips a place the catalogue no longer has", () => {
    expect(shopText(shop(null, ["retired-place", "hometax"]))).toContain(
      "매일 쓰는 곳: 홈택스(hometax.go.kr).",
    );
    expect(shopText(shop(null, ["retired-place"]))).toBe("");
  });

  test("names the first few and counts the rest, however many were picked", () => {
    const every = DAILY_PLACES.map((place) => place.id);
    const text = shopText(shop("online", every));
    const facts = text.split("\n")[0] ?? "";
    expect(facts).toContain(`외 ${every.length - SHOP_PLACES_SHOWN}곳`);
    const named = DAILY_PLACES.filter((place) =>
      facts.includes(PLACE_KO[place.id] ?? "(no Korean name)"),
    );
    expect(named).toHaveLength(SHOP_PLACES_SHOWN);
  });

  test("stays small on the worst day, because it rides on every turn", () => {
    const worst = shopText(
      shop(
        "office",
        DAILY_PLACES.map((place) => place.id),
      ),
    );
    // Counted the way the skill index counts: one token per Korean letter, four ASCII to one. Every
    // one of the twenty-two places picked measured 177 on 2026-09-18; a typical three, 113.
    expect(estimateTokens(worst)).toBeLessThanOrEqual(200);
    expect(worst.split("\n")).toHaveLength(2);
  });

  /**
   * NOT A WORD ABOUT ASKING. Whether an action stops for a person is the boundary's decision, made
   * in code that never reads this line (`server/tests/shop-boundary.test.ts`). A sentence here that
   * said "these are the owner's own sites" in the wrong way would be a prompt talking a Bot out of a
   * question the boundary means it to ask.
   */
  test("says nothing about approving, allowing or not asking", () => {
    const every = shopText(
      shop(
        "health",
        DAILY_PLACES.map((place) => place.id),
      ),
    );
    for (const word of [
      "승인",
      "허락",
      "허용",
      "묻지",
      "묻지 않",
      "물어보지",
      "확인 없이",
      "바로 해",
      "마음대로",
    ]) {
      expect(every).not.toContain(word);
    }
  });

  test("has Korean for every kind and every place", () => {
    expect(
      BUSINESS_KINDS.filter((kind) => !BUSINESS_KIND_KO[kind.id]).map(
        (kind) => kind.id,
      ),
    ).toEqual([]);
    expect(
      DAILY_PLACES.filter((place) => !PLACE_KO[place.id]).map(
        (place) => place.id,
      ),
    ).toEqual([]);
  });
});

describe("where the shop line sits in the prompt", () => {
  const at = new Date("2026-09-18T01:00:00Z");
  const compose = (options: {
    mode?: PromptMode;
    shop?: ShopProfile;
    memories?: string[];
  }) =>
    composePrompt({
      mode: options.mode ?? "chat",
      now: at,
      timeZone: "Asia/Seoul",
      bot: { id: "bot-1", name: "초롱" },
      standingRole: "새 리뷰에 답글 초안을 쓴다.",
      memories: options.memories ?? ["일요일은 쉰다."],
      skills: [{ slug: "재고정리", summary: "재고를 센다" }],
      ...(options.shop ? { shop: options.shop } : {}),
    });

  const food = shop("food", ["baemin-ceo"]);

  test("after the job the person gave, before what the Bot remembers", () => {
    const content = compose({ shop: food });
    const index = (text: string) => content.indexOf(text);
    expect(index("새 리뷰에 답글 초안을 쓴다.")).toBeLessThan(
      index("이 사람이 하는 일"),
    );
    expect(index("이 사람이 하는 일")).toBeLessThan(index("일요일은 쉰다."));
    expect(index("이 사람이 하는 일")).toBeLessThan(index("/재고정리"));
  });

  /*
   * The shop is the person's, and it rides in the context layer an epoch freezes — never in the
   * static layer every conversation shares, which ends before the Bot's own name.
   */
  test("sits in the context layer, after the static layer and the Bot's name", () => {
    const content = compose({ shop: food });
    expect(content.indexOf("너는 초롱이다.")).toBeLessThan(
      content.indexOf("이 사람이 하는 일"),
    );
    expect(content.indexOf("now 툴로 본다")).toBeLessThan(
      content.indexOf("너는 초롱이다."),
    );
  });

  test("is one paragraph, and the prompt without it is the prompt with nothing answered", () => {
    const withShop = compose({ shop: food });
    const without = compose({});
    expect(compose({ shop: EMPTY_SHOP })).toBe(without);
    // Take the paragraph out and nothing else moved: it changes no other word a Bot is told.
    expect(withShop.replace(`${shopText(food)}\n\n`, "")).toBe(without);
  });

  test.each(["chat", "routine"] as const)("reaches a %s run too", (mode) => {
    expect(compose({ mode, shop: food })).toContain(shopText(food));
  });
});
