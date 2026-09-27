import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * TWO THINGS THE SHOP ANSWERS MUST NEVER DO, held by reading the code that could do them.
 *
 * 1. CHANGE WHETHER A BOT GETS ASKED. The answers name the places the owner works in, and the
 *    tempting next step is obvious: "a navigation to one of the owner's own daily places need not
 *    stop". That would be a boundary moved by a sentence in Settings, with nobody deciding it where
 *    boundaries are decided. So the modules that decide whether an action stops — the policy, the
 *    settle step, auto-review, standing allowances, the gateway and the plugin call path — must not
 *    read them at all. The prompt line says nothing about asking (`tests/shop-prompt.test.ts`);
 *    this says the boundary never hears it either.
 *
 * 2. BE WRITTEN BY A BOT. Only the person answers, on the first run or in Settings. A Bot's own
 *    tools run in the person's browser, with the person's session, so "the route needs a session"
 *    is not enough on its own: no tool handler may reach the route. And on the server nothing but
 *    the shop store may touch the two columns — the export reads them, and that is all.
 *
 * Both hold for the persona too (2026-09-27): 학생·직장인·사장님·기타 orders suggestions and sets how
 * the Bot addresses the person, and it is written by the same store through the same kind of door.
 */

const root = join(import.meta.dir, "../..");

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules") continue;
      found.push(...sources(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const read = (path: string) => readFileSync(path, "utf8");
const at = (path: string) => relative(root, path);

/** Where the answers could be read, spelled every way the code spells them. */
const SHOP_READS = [
  "account/shop",
  "shop-context",
  "shop/catalogue",
  "shop.ko",
  "businessKind",
  "dailyPlaces",
  "business_kind",
  "daily_places",
  "profile.shop",
  // Who the person is (`shared/persona.ts`): a hint that orders, which no boundary may read.
  // Spelled out rather than the bare word, which "personal data" contains.
  "shared/persona",
  "effectivePersona",
  "profile.persona",
  "users.persona",
  "readPerson",
  "savePersona",
];

describe("the boundary", () => {
  const deciding = [
    ...sources(join(root, "server/src/computer")),
    join(root, "server/src/plugins/call.ts"),
    join(root, "server/src/plugins/call-preview.ts"),
    join(root, "server/src/plugins/laf-contract.ts"),
    join(root, "server/src/server-model-calls.ts"),
  ];

  test("covers the files that decide whether an action stops", () => {
    // A walk that silently found nothing would pass for the wrong reason.
    const names = deciding.map(at);
    for (const expected of [
      "server/src/computer/settle.ts",
      "server/src/computer/policy.ts",
      "server/src/computer/auto-review.ts",
      "server/src/computer/standing-approvals.ts",
      "server/src/computer/gateway.ts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("never reads the shop answers", () => {
    const readers = deciding.flatMap((path) => {
      const text = read(path);
      return SHOP_READS.filter((word) => text.includes(word)).map(
        (word) => `${at(path)}: ${word}`,
      );
    });
    expect(readers).toEqual([]);
  });
});

describe("who writes the answers", () => {
  test("no tool handler a Bot can call reaches the route", () => {
    const handlers = [
      ...sources(join(root, "app/src/lib/copilot")),
      ...sources(join(root, "shared/tools")),
      ...sources(join(root, "agent-bot/src")),
      ...sources(join(root, "server/src/runner")),
      ...sources(join(root, "server/src/routines")),
      ...sources(join(root, "server/src/agents")).filter(
        (path) => !path.endsWith("shop-context.ts"),
      ),
    ];
    expect(handlers.length).toBeGreaterThan(40);
    const reaching = handlers
      .filter((path) => {
        const text = read(path);
        return (
          text.includes("/me/shop") ||
          text.includes("saveShop") ||
          text.includes("createShopStore") ||
          text.includes("/me/persona") ||
          text.includes("savePersona")
        );
      })
      .map(at);
    expect(reaching).toEqual([]);
  });

  /*
   * The one tool path that ends in a persona write: askChoice `saves: "persona"`. It is a person's
   * press arriving on their own session, carried to the waiting turn — so the write must come
   * AFTER the wait for the person, in the one turn file that waits, and from nothing the Bot sent.
   * `chat-tools.test.ts` holds the behaviour; this holds the shape, so a second caller shows up.
   */
  test("the turn writes the persona only after a person answered, and only there", () => {
    const turns = sources(join(root, "server/src/turns"));
    const writing = turns
      .filter((path) => read(path).includes("savePersona"))
      .map(at);
    expect(writing).toEqual(["server/src/turns/chat-tools.ts"]);
    const text = read(join(root, "server/src/turns/chat-tools.ts"));
    const waited = text.indexOf("deps.people.wait(");
    const saved = text.indexOf(".savePersona(owner.id, chosen)");
    expect(waited).toBeGreaterThan(0);
    expect(saved).toBeGreaterThan(waited);
    expect(text.split(".savePersona(").length - 1).toBe(1);
  });

  test("on the server, only the store and the export touch the columns", () => {
    const touching = sources(join(root, "server/src"))
      .filter((path) => {
        const text = read(path);
        return (
          text.includes("businessKind") ||
          text.includes("dailyPlaces") ||
          text.includes("users.persona")
        );
      })
      .map(at)
      .toSorted();
    expect(touching).toEqual([
      "server/src/account/export.ts",
      "server/src/account/shop.ts",
      "server/src/db/schema/core.ts",
    ]);
  });

  test("the route is mounted from one place, behind a session", () => {
    const mounting = sources(join(root, "server/src"))
      .filter((path) => read(path).includes("createShopRoutes("))
      .map(at)
      .toSorted();
    expect(mounting).toEqual([
      "server/src/account/shop.ts",
      "server/src/app.ts",
    ]);
    expect(read(join(root, "server/src/account/shop.ts"))).toContain(
      'routes.put("/me/shop", requireUser,',
    );
    expect(read(join(root, "server/src/account/shop.ts"))).toContain(
      'routes.put("/me/persona", requireUser,',
    );
  });
});
