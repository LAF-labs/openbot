import { describe, expect, test } from "bun:test";
import type { ShopProfile } from "@shared/shop/catalogue";
import {
  type FirstTask,
  NO_CONNECTION_TASKS,
  pickFirstTasks,
} from "../src/lib/agents/first-tasks";
import {
  AGENT_PRESETS,
  KIND_PRESETS,
  pickSuggestions,
  shopWorkOrder,
  type WorkPatternId,
} from "../src/lib/agents/presets";
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
 * Two rows on a new Bot's empty conversation: the intro card's kinds of work (`pickSuggestions`) and
 * the first things to ask (`pickFirstTasks`). Both used to be the same for a restaurant and a law
 * office. With an answer they lead with that trade's work and the places the owner picked; the hand
 * is still the same size and still spread across kinds of work, because a guess made on the first
 * run must not become the only thing a Bot is ever offered.
 */

const shop = (
  kind: ShopProfile["kind"],
  places: string[] = [],
): ShopProfile => ({ kind, places });

/** A source of randomness that is the same every time, so a hand can be compared. */
const fixed =
  (value = 0.42) =>
  () =>
    value;

const presetPattern = (id: string): WorkPatternId => {
  const found = AGENT_PRESETS.find((preset) => preset.id === id);
  if (!found) throw new Error(`no preset ${id}`);
  return found.pattern;
};

describe("the kinds of work a trade leads with", () => {
  test("name only presets that exist, each once, and 그 밖에 names none", () => {
    for (const kind of BUSINESS_KINDS) {
      const ids = KIND_PRESETS[kind.id];
      expect(
        ids.filter((id) => !AGENT_PRESETS.some((p) => p.id === id)),
      ).toEqual([]);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(KIND_PRESETS.other).toEqual([]);
  });

  test("give every other trade at least five kinds of work to lead with", () => {
    // The intro card deals five. A trade whose list covered fewer kinds would lead with its own and
    // then fall back to chance for the rest of the hand.
    for (const kind of BUSINESS_KINDS.filter((entry) => entry.id !== "other")) {
      const patterns = new Set(KIND_PRESETS[kind.id].map(presetPattern));
      expect([kind.id, patterns.size >= 5]).toEqual([kind.id, true]);
    }
  });

  test("put the places picked ahead of the trade, in the order they were picked", () => {
    const order = shopWorkOrder(
      shop("food", ["naver-smartplace", "baemin-ceo"]),
    );
    // 스마트플레이스 is reviews, 배민 is settlement; then the restaurant's own list.
    expect(order.patterns.slice(0, 2)).toEqual(["reputation", "settlement"]);
    expect(order.patterns).toContain("stock");
    expect(new Set(order.patterns).size).toBe(order.patterns.length);
  });

  test("say nothing for an answer with nothing in it", () => {
    expect(shopWorkOrder(shop(null))).toEqual({ patterns: [], presets: [] });
    expect(shopWorkOrder(shop("other"))).toEqual({ patterns: [], presets: [] });
  });
});

describe("the intro card's hand", () => {
  test("leads with the trade's own presets, one kind of work each", () => {
    const hand = pickSuggestions(5, fixed(), shopWorkOrder(shop("food")));
    expect(hand.map((preset) => preset.id)).toEqual([
      "review-replies",
      "payouts",
      "stock",
      "bookings",
      "support-replies",
    ]);
  });

  test("leads with the kinds of work of the places picked", () => {
    const hand = pickSuggestions(
      5,
      fixed(),
      shopWorkOrder(shop("food", ["baemin-ceo"])),
    );
    // 배민 is settlement, and the restaurant's settlement preset is the platform payouts.
    expect(hand[0]?.id).toBe("payouts");
    expect(hand.map((preset) => preset.id)).toContain("review-replies");
  });

  test("is still five, still five kinds of work, whatever the answer", () => {
    for (const kind of BUSINESS_KINDS) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const hand = pickSuggestions(
          5,
          Math.random,
          shopWorkOrder(shop(kind.id, ["gmail", "hometax"])),
        );
        expect(hand).toHaveLength(5);
        expect(new Set(hand.map((preset) => preset.pattern)).size).toBe(5);
      }
    }
  });

  test("without an answer, deals exactly as before", () => {
    const sequence = () => {
      let index = 0;
      const values = [0.1, 0.9, 0.4, 0.7, 0.2, 0.55, 0.33, 0.8, 0.05, 0.6];
      return () => values[index++ % values.length] as number;
    };
    expect(
      pickSuggestions(5, sequence(), shopWorkOrder(shop(null))).map(
        (preset) => preset.id,
      ),
    ).toEqual(pickSuggestions(5, sequence()).map((preset) => preset.id));
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

  test("the Bot's own card still leads the kinds of work", () => {
    const tasks = pickFirstTasks(overview(), {
      hint: "paperwork",
      shop: shop("food"),
    });
    expect(labels(tasks).slice(0, 2)).toEqual([
      generic("paperwork"),
      generic("reputation"),
    ]);
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
