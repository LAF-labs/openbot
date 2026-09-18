import { describe, expect, test } from "bun:test";
import {
  BUSINESS_KINDS,
  type BusinessKindId,
  DAILY_PLACES,
  parseShopAnswer,
  SHOP_INVALID,
  shopFrom,
} from "../../shared/shop/catalogue";
import { BUSINESS_SITES, siteById } from "../../shared/sites/catalogue";
import { CATALOGUE } from "../src/plugins/catalogue";

/**
 * The first run's two questions, as a table: which kinds of business, which daily places, and what
 * an answer to them may say.
 *
 * THE PROPERTY THAT MATTERS: every place maps to something a Bot can actually sign into or connect.
 * A chip for a place nothing in the product can touch is a promise the first screen makes and no
 * screen keeps — the Bot is told the owner lives there, and cannot go.
 */

/**
 * `satisfies Record<BusinessKindId, true>` is the tether: a kind added to the type and not here is
 * a typecheck error rather than a kind this file quietly stops checking.
 */
const KIND_IDS = Object.keys({
  food: true,
  online: true,
  store: true,
  beauty: true,
  education: true,
  health: true,
  office: true,
  other: true,
} satisfies Record<BusinessKindId, true>) as BusinessKindId[];

describe("the kinds of business", () => {
  test("are exactly the eight the type names, each once", () => {
    expect(BUSINESS_KINDS.map((kind) => kind.id).toSorted()).toEqual(
      KIND_IDS.toSorted(),
    );
  });

  test("lead only with places that exist, each once", () => {
    const known = new Set(DAILY_PLACES.map((place) => place.id));
    for (const kind of BUSINESS_KINDS) {
      expect(kind.places.filter((id) => !known.has(id))).toEqual([]);
      expect(new Set(kind.places).size).toBe(kind.places.length);
    }
  });

  test("give every kind but 그 밖에 somewhere to start", () => {
    // A kind with no leading places would show its owner the catalogue's own order, which is the
    // answer the question was asked to improve on.
    const empty = BUSINESS_KINDS.filter(
      (kind) => kind.id !== "other" && kind.places.length === 0,
    ).map((kind) => kind.id);
    expect(empty).toEqual([]);
  });
});

describe("the daily places", () => {
  test("ids are unique", () => {
    const ids = DAILY_PLACES.map((place) => place.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every door names a site or an account the product actually has", () => {
    const accounts = new Set(CATALOGUE.map((entry) => entry.key));
    const nowhere: string[] = [];
    for (const place of DAILY_PLACES) {
      expect(place.connections.length).toBeGreaterThan(0);
      for (const door of place.connections) {
        const exists =
          door.kind === "site"
            ? siteById(door.id) !== null
            : accounts.has(door.id);
        if (!exists) nowhere.push(`${place.id} → ${door.kind}:${door.id}`);
      }
    }
    expect(nowhere).toEqual([]);
  });

  test("no account door is one nobody connects", () => {
    // The public-data entry is the fleet's key, offered to every Bot at boot: there is nothing for
    // a person to connect, so it is not a place they could be sent to connect first.
    const connectless = CATALOGUE.filter(
      (entry) => entry.auth.kind === "deployment-key",
    ).map((entry) => entry.key);
    const offered = DAILY_PLACES.flatMap((place) =>
      place.connections
        .filter((door) => door.kind === "account")
        .map((door) => door.id),
    );
    expect(offered.filter((id) => connectless.includes(id))).toEqual([]);
  });

  test("a site's place is the kind of work the site catalogue says it is", () => {
    const disagree: string[] = [];
    for (const place of DAILY_PLACES) {
      const first = place.connections[0];
      if (first?.kind !== "site") continue;
      const site = siteById(first.id);
      if (site && site.category !== place.pattern) {
        disagree.push(`${place.id}: ${place.pattern} ≠ ${site.category}`);
      }
    }
    expect(disagree).toEqual([]);
  });

  test("every site in the catalogue is reachable from some place", () => {
    // The other direction: a site added to the catalogue and forgotten here is a place the owner
    // uses that the first run can never offer.
    const reached = new Set(
      DAILY_PLACES.flatMap((place) =>
        place.connections
          .filter((door) => door.kind === "site")
          .map((door) => door.id),
      ),
    );
    expect(
      BUSINESS_SITES.filter((site) => !reached.has(site.id)).map(
        (site) => site.id,
      ),
    ).toEqual([]);
  });
});

describe("an answer, as the person sends it", () => {
  test("takes a kind and places from the tables, in the order they were picked", () => {
    expect(
      parseShopAnswer({ kind: "food", places: ["hometax", "baemin-ceo"] }),
    ).toEqual({
      ok: true,
      value: { kind: "food", places: ["hometax", "baemin-ceo"] },
    });
  });

  test("takes an answer that says nothing, which is what a skip leaves", () => {
    expect(parseShopAnswer({ kind: null, places: [] })).toEqual({
      ok: true,
      value: { kind: null, places: [] },
    });
  });

  test("keeps a place named twice once", () => {
    expect(
      parseShopAnswer({ kind: null, places: ["gmail", "gmail", "notion"] }),
    ).toEqual({ ok: true, value: { kind: null, places: ["gmail", "notion"] } });
  });

  test.each([
    ["no body", null],
    ["a list", []],
    ["no kind", { places: [] }],
    ["no places", { kind: null }],
    ["a kind that is not in the table", { kind: "casino", places: [] }],
    ["a place that is not in the table", { kind: null, places: ["myspace"] }],
    ["places that are not a list", { kind: null, places: "gmail" }],
    ["a place that is not a string", { kind: null, places: [7] }],
    // A site the catalogue has that is not offered as a place of its own: the admin door behind
    // Cafe24. The id space is the places', not the sites'.
    ["a door rather than a place", { kind: null, places: ["cafe24-admin"] }],
  ])("refuses %s", (_name, body) => {
    expect(parseShopAnswer(body)).toEqual({ ok: false, code: SHOP_INVALID });
  });
});

describe("an answer, as a row holds it", () => {
  test("drops what the catalogue no longer has rather than failing the read", () => {
    // Every run of every Bot reads this. A place retired from the table must not take the Bot down.
    expect(shopFrom("food", ["retired-place", "baemin-ceo"])).toEqual({
      kind: "food",
      places: ["baemin-ceo"],
    });
    expect(shopFrom("casino", "not a list")).toEqual({
      kind: null,
      places: [],
    });
    expect(shopFrom(null, null)).toEqual({ kind: null, places: [] });
  });
});
