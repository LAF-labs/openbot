import { describe, expect, test } from "bun:test";
import { PERSONAS } from "@shared/persona";
import { ConnectionCardProps } from "@/components/gallery/connect";
import { suggestedConnections } from "@/lib/connections/suggested";
import { CATALOGUE_COPY } from "@/lib/plugins/catalogue-copy";
import { BUSINESS_SITES } from "@/lib/sites/catalogue";

/**
 * The first run's 연결 step and the Bot's connection card offer rows 연결 already has, and the
 * persona only orders them (CLAUDE.md: a hint, never a gate).
 */
const known = (id: string) =>
  id in CATALOGUE_COPY || BUSINESS_SITES.some((site) => site.id === id);
const NO_SHOP = { kind: null, places: [] };

describe("what the first run offers to connect", () => {
  test("every id offered to any persona is a row 연결 has", () => {
    for (const persona of PERSONAS) {
      for (const id of suggestedConnections(persona, NO_SHOP)) {
        expect(known(id)).toBe(true);
      }
    }
  });

  test("a student and an office worker lead with different accounts", () => {
    expect(suggestedConnections("student", NO_SHOP)[0]).toBe("google-calendar");
    expect(suggestedConnections("worker", NO_SHOP)[0]).toBe("gmail");
  });

  test("a 사장님 of a food shop leads with sites of that kind of shop", () => {
    const first = suggestedConnections("owner", { kind: "food", places: [] });
    expect(BUSINESS_SITES.some((site) => site.id === first[0])).toBe(true);
    // And with nothing said about the shop, the accounts everybody has.
    expect(suggestedConnections("owner", NO_SHOP)[0]).toBe("canva");
  });
});

describe("the Bot's connection card", () => {
  test("offers accounts and sites, never the partner registration or the public-data key", () => {
    const parse = (services: string[]) =>
      ConnectionCardProps.safeParse({ services }).success;
    expect(parse(["canva", "naver-smartstore"])).toBe(true);
    expect(parse(["kakao-alimtalk"])).toBe(false);
    expect(parse(["public-data"])).toBe(false);
    expect(parse(["made-up"])).toBe(false);
    expect(parse([])).toBe(false);
  });
});
