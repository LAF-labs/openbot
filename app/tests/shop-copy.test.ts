import { describe, expect, test } from "bun:test";
import { BUSINESS_KIND_KO, PLACE_KO } from "@shared/prompt/shop.ko";
import { BUSINESS_KINDS, DAILY_PLACES } from "@shared/shop/catalogue";
import { ko } from "../src/lib/i18n-ko";

/**
 * The first run's two questions are drawn through `t(kind.name)` and `t(place.name)` — variable
 * calls, which `i18n-coverage.test.ts` cannot see — so the tables are walked here, the way
 * `site-catalogue.test.ts` walks the sites.
 *
 * AND THE BOT MUST CALL A PLACE WHAT THE PERSON CALLED IT. The context line every Bot reads
 * (`shared/prompt/shop.ko.ts`) is Korean written in `shared/`, which cannot import this dictionary.
 * Two copies of one name drift; this is what says they have not — an owner who pressed "배달의민족"
 * must not hear their Bot talk about somewhere with another name.
 */

describe("the shop questions in Korean", () => {
  test("every kind and every place has an entry that is not its own key", () => {
    const missing: string[] = [];
    for (const { name } of [...BUSINESS_KINDS, ...DAILY_PLACES]) {
      if (!ko[name] || ko[name] === name) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  test("the Bot's word for each kind is the person's", () => {
    const differ = BUSINESS_KINDS.filter(
      (kind) => BUSINESS_KIND_KO[kind.id] !== ko[kind.name],
    ).map(
      (kind) => `${kind.id}: ${BUSINESS_KIND_KO[kind.id]} ≠ ${ko[kind.name]}`,
    );
    expect(differ).toEqual([]);
  });

  test("the Bot's word for each place is the person's", () => {
    const differ = DAILY_PLACES.filter(
      (place) => PLACE_KO[place.id] !== ko[place.name],
    ).map((place) => `${place.id}: ${PLACE_KO[place.id]} ≠ ${ko[place.name]}`);
    expect(differ).toEqual([]);
  });
});
