import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ShopProfile } from "@shared/shop/catalogue";
import { createElement } from "react";
import { type WorkPatternId, workPattern } from "../src/lib/agents/presets";
import { agentFixture, CURRENT_USER } from "./support/app-router";
import { stubFetch } from "./support/fetch";
import { mount, unmountAll } from "./support/mount";

/**
 * THE INTRO CARD'S KINDS OF WORK, DEALT FOR THIS SHOP.
 *
 * The card on a new Bot's empty conversation offers five kinds of work to press. It reads the shop
 * answers off the current user — already in the cache before any screen draws — so the hand is
 * dealt once, in order, on the first frame. `shop-suggestions.test.ts` proves the order; this
 * proves the card is the one reading it.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function dealtFor(shop: ShopProfile) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { BotIntroCard } = await import(
    "../src/components/agents/bot-intro-card"
  );
  const { authKeys } = await import("../src/lib/auth/queries");
  const { t } = await import("../src/lib/i18n");

  globalThis.fetch = stubFetch(async () => new Response(null, { status: 404 }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // What `_authed` leaves in the cache before this screen can draw.
  client.setQueryData(authKeys.currentUser(), {
    ...CURRENT_USER,
    role: "user" as const,
    onboarded: true,
    consentRequired: false,
    shop,
    deployment: { effort: true, autoReview: true, seats: 5 },
  });

  const view = await mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(BotIntroCard, {
        agent: agentFixture({ id: "bot-1", name: "초롱" }),
      }),
    ),
  );
  await view.settle();
  const names = (patterns: WorkPatternId[]) =>
    patterns.map((pattern) => t(workPattern(pattern).name));
  const chips = [...view.host.querySelectorAll("button")]
    .map((button) => button.textContent ?? "")
    .filter((label) =>
      names([
        "night-watch",
        "approval",
        "settlement",
        "enquiries",
        "schedule",
        "stock",
        "reputation",
        "paperwork",
      ]).includes(label),
    );
  return { chips, names };
}

describe("the intro card, for a shop", () => {
  test("a restaurant is offered a restaurant's work first", async () => {
    const { chips, names } = await dealtFor({ kind: "food", places: [] });
    expect(chips).toEqual(
      names(["reputation", "settlement", "stock", "schedule", "enquiries"]),
    );
  });

  test("the places picked lead, and the hand is still five kinds of work", async () => {
    const { chips, names } = await dealtFor({
      kind: "office",
      places: ["hometax"],
    });
    expect(chips[0]).toBe(names(["paperwork"])[0]);
    expect(chips).toHaveLength(5);
    expect(new Set(chips).size).toBe(5);
  });
});
