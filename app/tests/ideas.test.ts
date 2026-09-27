import { describe, expect, test } from "bun:test";
import { IDEAS, orderIdeas } from "@shared/ideas/catalogue";
import {
  CATEGORIES,
  CATEGORY_LEAD,
  categoryOrder,
  PERSONAS,
} from "@shared/persona";
import { BUSINESS_SITES } from "@shared/sites/catalogue";
import { CATALOGUE } from "../../server/src/plugins/catalogue";
import { ko } from "../src/lib/i18n-ko";
import { ideaReason, type OfferedIdea } from "../src/lib/ideas/queries";

/**
 * 아이디어'S TABLE, WALKED (muse-shape plan §3.3, phase 5).
 *
 * Every card's three sentences are read through `t(variable)` — invisible to
 * `i18n-coverage.test.ts` — so each is walked here for its Korean, the way `first-tasks.test.ts`
 * walks the chips. And the two promises the page makes: the same set for everybody, and a card
 * that names a connection names one that exists.
 */

describe("the catalogue", () => {
  test("every card says all three things in Korean", () => {
    const missing = IDEAS.flatMap((idea) =>
      [idea.title, idea.makes, idea.sentence]
        .filter((key) => !ko[key])
        .map((key) => `${idea.key}: ${key}`),
    );
    expect(missing).toEqual([]);
  });

  test("keys are unique, and every card is filed under one of the seven and leads for real personas", () => {
    const keys = IDEAS.map((idea) => idea.key);
    expect(new Set(keys).size).toBe(keys.length);
    const categories = new Set<string>(CATEGORIES.map((one) => one.id));
    for (const idea of IDEAS) {
      expect(categories.has(idea.category)).toBe(true);
      for (const persona of idea.lead) {
        expect(PERSONAS).toContain(persona);
      }
    }
  });

  test("every persona leads with cards of its own", () => {
    for (const persona of PERSONAS) {
      expect(
        IDEAS.filter((idea) => idea.lead.includes(persona)).length,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test("a connection a card names is one the 연결 screen can show", () => {
    const sites = new Set(BUSINESS_SITES.map((site) => site.id));
    const accounts = new Set(CATALOGUE.map((entry) => entry.key));
    const unknown = IDEAS.flatMap((idea) =>
      idea.needs
        .filter((need) =>
          need.kind === "site" ? !sites.has(need.id) : !accounts.has(need.id),
        )
        .map((need) => `${idea.key}: ${need.kind}:${need.id}`),
    );
    expect(unknown).toEqual([]);
  });

  /*
   * A ROUTINE'S SENTENCE SAYS WHEN. `manage_routine` makes a routine only when a time is said; a
   * sentence without one is answered once and the card promised a routine.
   */
  test("a routine card's sentence carries a time", () => {
    const timeless = IDEAS.filter(
      (idea) =>
        idea.kind === "routine" &&
        !/\d+시|\d+:\d+/.test(ko[idea.sentence] ?? ""),
    ).map((idea) => idea.key);
    expect(timeless).toEqual([]);
  });

  test("the seven categories are said in Korean, and each persona's two lead", () => {
    for (const category of CATEGORIES) expect(ko[category.name]).toBeTruthy();
    expect(CATEGORIES.map((one) => ko[one.name])).toEqual([
      "일·가게",
      "공부·성장",
      "돈·세금",
      "건강",
      "관계",
      "생활",
      "기타",
    ]);
    for (const persona of PERSONAS) {
      const order = categoryOrder(persona);
      expect(order.slice(0, 2)).toEqual([...CATEGORY_LEAD[persona]]);
      expect([...order].sort()).toEqual(CATEGORIES.map((one) => one.id).sort());
    }
    expect(categoryOrder(null)).toEqual(CATEGORIES.map((one) => one.id));
  });
});

describe("the order", () => {
  const cards = IDEAS.map((idea) => ({ key: idea.key, ready: true }));

  test("every persona, and nobody yet, gets exactly the same cards back", () => {
    const expected = IDEAS.map((idea) => idea.key).sort();
    for (const persona of [...PERSONAS, null]) {
      expect(
        orderIdeas(cards, persona)
          .map((card) => card.key)
          .sort(),
      ).toEqual(expected);
    }
  });

  test("each persona reads its own cards first, and the orders differ", () => {
    const firsts = PERSONAS.map((persona) => {
      const [first] = orderIdeas(cards, persona);
      const idea = IDEAS.find((one) => one.key === first?.key);
      expect(idea?.lead).toContain(persona);
      return first?.key;
    });
    expect(new Set(firsts).size).toBe(PERSONAS.length);
  });

  test("a card that waits on a connection comes after the ones that can be asked now, among equals", () => {
    const [first, second] = IDEAS.filter((idea) => idea.lead.includes("owner"));
    if (!first || !second) throw new Error("the owner leads with two cards");
    const ordered = orderIdeas(
      [
        { key: first.key, ready: false },
        { key: second.key, ready: true },
      ],
      "owner",
    ).map((card) => card.key);
    expect(ordered).toEqual([second.key, first.key]);
  });
});

describe("why a card is here", () => {
  const card = (over: Partial<OfferedIdea>): OfferedIdea => ({
    key: "study-plan",
    state: "ready",
    via: [],
    needs: [],
    ...over,
  });

  test("a connection it works through, one it waits on, or the persona it leads for — never a guess", () => {
    expect(
      ideaReason(
        card({
          key: "orders-today",
          via: [{ kind: "site", id: "naver-smartstore" }],
        }),
        null,
      )?.kind,
    ).toBe("via");
    expect(
      ideaReason(
        card({
          key: "orders-today",
          state: "connect",
          needs: [{ kind: "site", id: "naver-smartstore" }],
        }),
        "owner",
      )?.kind,
    ).toBe("connect");
    expect(ideaReason(card({}), "student")?.kind).toBe("persona");
    // A card that does not lead for this persona says nothing about why: it is simply there.
    expect(ideaReason(card({}), "owner")).toBeNull();
    expect(ideaReason(card({}), null)).toBeNull();
  });

  test("its words are in the dictionary", () => {
    for (const key of [
      "Can do this once one is connected: {connections}",
      "Because {connection} is connected",
      "Useful for anyone",
      "Suits a {persona}",
      "{names} and {count} more",
    ]) {
      expect(ko[key]).toBeTruthy();
    }
  });
});

describe("the press", () => {
  /*
   * A card pressed before the Bot was ever spoken to has no conversation to open: the compose
   * screen takes `draft` too, for its own composer or for the conversation it hands over to.
   */
  test("the compose screen takes the sentence from the address", async () => {
    const { Route } = await import("../src/routes/_authed/_app/channel/new");
    const validate = Route.options.validateSearch as (
      search: Record<string, unknown>,
    ) => { agent?: string; draft?: string };
    expect(validate({ agent: "bot-1", draft: "시험 계획표" })).toEqual({
      agent: "bot-1",
      draft: "시험 계획표",
    });
    expect(validate({ draft: 3 })).toEqual({});
  });
});
