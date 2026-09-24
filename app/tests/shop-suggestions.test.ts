import { describe, expect, test } from "bun:test";
import type { ShopProfile } from "@shared/shop/catalogue";
import {
  type FirstTask,
  NO_CONNECTION_TASKS,
  pickFirstTasks,
} from "../src/lib/agents/first-tasks";
import {
  KIND_PATTERNS,
  shopPatternOrder,
  WORK_PATTERNS,
  type WorkPatternId,
} from "../src/lib/agents/work-patterns";
import type {
  ConnectionsOverview,
  OauthAccount,
  OverviewSite,
} from "../src/lib/connections/queries";
import { BUSINESS_KINDS } from "../src/lib/shop/catalogue";
import { BUSINESS_SITES } from "../src/lib/sites/catalogue";

/**
 * THE SUGGESTIONS, ORDERED BY WHAT THE PERSON SAID ABOUT THE SHOP — AND NEVER FILTERED TO NOTHING.
 *
 * The first things to ask on a Bot's empty conversation (`pickFirstTasks`) used to be the same for a
 * restaurant and a law office. With an answer they lead with that trade's work and the places the
 * owner picked; the row is still the same size and still spread across kinds of work, because a
 * guess must not become the only thing a Bot is ever offered. (A second row — kinds of work to make
 * the Bot into — went with the new Bot's card on 2026-09-24.)
 */

const shop = (
  kind: ShopProfile["kind"],
  places: string[] = [],
): ShopProfile => ({ kind, places });

describe("the kinds of work a trade leads with", () => {
  test("name only kinds of work that exist, each once, and 그 밖에 names none", () => {
    const known = new Set<WorkPatternId>(WORK_PATTERNS.map((p) => p.id));
    for (const kind of BUSINESS_KINDS) {
      const patterns = KIND_PATTERNS[kind.id];
      expect(patterns.filter((pattern) => !known.has(pattern))).toEqual([]);
      expect(new Set(patterns).size).toBe(patterns.length);
    }
    expect(KIND_PATTERNS.other).toEqual([]);
  });

  test("give every other trade at least five kinds of work to lead with", () => {
    // The first-task row deals four; a trade whose list covered fewer would fall back to the
    // general order for the rest of the row before the places had had their say.
    for (const kind of BUSINESS_KINDS.filter((entry) => entry.id !== "other")) {
      expect([kind.id, KIND_PATTERNS[kind.id].length >= 5]).toEqual([
        kind.id,
        true,
      ]);
    }
  });

  test("put the places picked ahead of the trade, in the order they were picked", () => {
    const order = shopPatternOrder(
      shop("food", ["naver-smartplace", "baemin-ceo"]),
    );
    // 스마트플레이스 is reviews, 배민 is settlement; then the restaurant's own list.
    expect(order.slice(0, 2)).toEqual(["reputation", "settlement"]);
    expect(order).toContain("stock");
    expect(new Set(order).size).toBe(order.length);
  });

  test("say nothing for an answer with nothing in it", () => {
    expect(shopPatternOrder(shop(null))).toEqual([]);
    expect(shopPatternOrder(shop("other"))).toEqual([]);
  });
});

const site = (
  id: string,
  status: OverviewSite["status"] = "connected",
): OverviewSite => ({
  id,
  status,
  botId: status === "not_connected" ? null : "bot-1",
  lastSeenAt: null,
  connectedAt: status === "connected" ? "2026-09-18T00:00:00.000Z" : null,
});

const account = (
  id: string,
  status: OauthAccount["status"] = "connected",
): OauthAccount => ({
  kind: "oauth",
  id,
  serverId: null,
  title: id,
  vendor: id,
  status,
  connectedAt: null,
  account: null,
  needsInstanceName: false,
  health: {
    status: status === "needs_reconnect" ? "needs_reconnect" : "ok",
    lastOkAt: null,
    lastFailureAt: null,
    failureCode: null,
  },
});

const overview = (
  sites: OverviewSite[] = [],
  accounts: ConnectionsOverview["accounts"] = [],
): Pick<ConnectionsOverview, "sites" | "accounts"> => ({ sites, accounts });

const generic = (pattern: WorkPatternId): string => {
  const found = NO_CONNECTION_TASKS.find((task) => task.pattern === pattern);
  if (!found) throw new Error(`no connection-free sentence for ${pattern}`);
  return found.sentence;
};

const firstPrompt = (id: string): string =>
  BUSINESS_SITES.find((known) => known.id === id)?.prompts[0] ?? "";

const labels = (tasks: readonly FirstTask[]) =>
  tasks.map((task) =>
    task.kind === "ask"
      ? task.sentence
      : task.place
        ? `connect:${task.place}`
        : "connect",
  );

describe("the first things to ask", () => {
  test("a picked place that is not connected yet is offered to connect, first", () => {
    const tasks = pickFirstTasks(
      overview([site("baemin-ceo", "not_connected")]),
      { shop: shop("food", ["baemin-ceo"]) },
    );
    expect(labels(tasks)).toEqual([
      "connect:baemin-ceo",
      // 배민's kind of work first, then the restaurant's own order.
      generic("settlement"),
      generic("reputation"),
      generic("stock"),
      generic("schedule"),
    ]);
  });

  test("the first picked place that is not connected is the one offered", () => {
    const tasks = pickFirstTasks(
      overview([
        site("naver-smartplace", "connected"),
        site("baemin-ceo", "needs_login"),
      ]),
      { shop: shop("food", ["naver-smartplace", "baemin-ceo"]) },
    );
    expect(labels(tasks)[0]).toBe("connect:baemin-ceo");
    expect(labels(tasks)).toContain(firstPrompt("naver-smartplace"));
    expect(tasks.filter((task) => task.kind === "connect")).toHaveLength(1);
  });

  test("an account picked and not connected is offered too", () => {
    const tasks = pickFirstTasks(
      overview([], [account("gmail", "not_connected")]),
      { shop: shop("office", ["gmail"]) },
    );
    expect(labels(tasks)[0]).toBe("connect:gmail");
  });

  test("a place this deployment cannot touch is never offered to connect", () => {
    // No browser behind it: 배민 is not in the overview at all.
    const tasks = pickFirstTasks(overview(), {
      shop: shop("food", ["baemin-ceo"]),
    });
    expect(labels(tasks)).not.toContain("connect:baemin-ceo");
    // And the way to connect something is still there, as it was before any answer.
    expect(labels(tasks).at(-1)).toBe("connect");
  });

  test("everything picked is connected: no connect chip, and the picked place speaks first", () => {
    const tasks = pickFirstTasks(
      overview([site("tosspayments"), site("baemin-ceo")]),
      { shop: shop("food", ["baemin-ceo"]) },
    );
    // Both are settlement; the one the owner picked leads.
    expect(labels(tasks)[0]).toBe(firstPrompt("baemin-ceo"));
    expect(tasks.some((task) => task.kind === "connect")).toBe(false);
  });

  test("an answer never shortens the row", () => {
    for (const kind of BUSINESS_KINDS) {
      const tasks = pickFirstTasks(overview([site("hometax")]), {
        shop: shop(kind.id, ["hometax", "gmail"]),
      });
      expect(tasks.filter((task) => task.kind === "ask")).toHaveLength(4);
    }
  });

  test("without an answer, the row is what it always was", () => {
    const state = overview([site("naver-smartplace"), site("hometax")]);
    expect(pickFirstTasks(state, { shop: shop(null) })).toEqual(
      pickFirstTasks(state),
    );
  });
});
