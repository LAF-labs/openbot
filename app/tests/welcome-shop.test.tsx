import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { ConnectionsOverview } from "../src/lib/connections/queries";
import {
  type ApiRequest,
  APP_DOM_TIMEOUT_MS,
  CURRENT_USER,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE FIRST RUN'S TWO QUESTIONS, PRESSED THROUGH.
 *
 * Between the agreement and the first Bot the welcome flow asks what kind of business this is and
 * which places the owner uses every day — each one skippable, each one a press rather than typing.
 * The real route tree on a memory history, the server stubbed: what matters is what reaches
 * `PUT /api/me/shop` (and that a skip sends nothing), which places are offered on a deployment that
 * can only touch some of them, and that the flow still ends at the first Bot.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const site = (id: string): ConnectionsOverview["sites"][number] => ({
  id,
  status: "not_connected",
  botId: null,
  lastSeenAt: null,
  connectedAt: null,
});

const gmail: ConnectionsOverview["accounts"][number] = {
  kind: "oauth",
  id: "gmail",
  serverId: null,
  title: "Gmail",
  vendor: "Google",
  status: "not_connected",
  connectedAt: null,
  account: null,
  needsInstanceName: false,
  health: {
    status: "ok",
    lastOkAt: null,
    lastFailureAt: null,
    failureCode: null,
  },
};

/** A deployment with a browser and every site on it, and Gmail as the one account it can finish. */
const EVERYTHING: ConnectionsOverview = {
  generatedAt: "2026-09-18T00:00:00.000Z",
  accounts: [gmail],
  sites: [
    "naver-smartstore",
    "naver-smartplace",
    "naver-booking-talk",
    "coupang-wing",
    "baemin-ceo",
    "coupangeats-store",
    "yogiyo-ceo",
    "hometax",
    "daangn-business",
    "catchtable-ceo",
    "tosspayments",
    "naver-searchad",
    "instagram",
    "kakao-channel",
    "cafe24-admin",
  ].map(site),
  bots: [],
};

function server(options: {
  overview?: ConnectionsOverview | "broken";
  shop?: unknown;
  refuseShop?: boolean;
}) {
  const puts: unknown[] = [];
  let held: unknown = options.shop ?? { kind: null, places: [] };
  const api = (request: ApiRequest) => {
    const { pathname, method } = request;
    if (pathname === "/api/me") {
      return json({
        user: { ...CURRENT_USER, role: "user", onboarded: false, shop: held },
        deployment: { effort: true, autoReview: true, seats: 5 },
      });
    }
    if (pathname === "/api/me/consent" && method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (pathname === "/api/me/shop" && method === "PUT") {
      puts.push(request.body);
      if (options.refuseShop) {
        return json({ error: "laf:internal", code: "laf:internal" }, 500);
      }
      held = request.body;
      return json({ shop: request.body });
    }
    if (pathname === "/api/connections/overview") {
      return options.overview === "broken"
        ? json({ error: "laf:internal", code: "laf:internal" }, 500)
        : json(options.overview ?? EVERYTHING);
    }
    return undefined;
  };
  return { api, puts };
}

type View = Awaited<ReturnType<typeof mountApp>>;

const text = (view: View) => view.host.textContent ?? "";

async function press(view: View, name: string) {
  await view.waitFor(
    () => view.buttonNamed(name) !== undefined,
    `a button called ${name}`,
  );
  const button = view.buttonNamed(name);
  if (!button) throw new Error(`no button called ${name}`);
  await view.click(button);
}

/** The chips of the places question, in the order they are drawn. */
const placeChips = (view: View) =>
  [
    ...view.host.querySelectorAll<HTMLButtonElement>(
      '[data-slot="daily-places"] button[aria-pressed]',
    ),
  ].map((chip) => chip.textContent?.trim() ?? "");

async function toKindQuestion(view: View) {
  await press(view, "Next");
  await view.waitFor(
    () => text(view).includes("What kind of work do you do?"),
    "the first question",
  );
}

describe("the first run's two questions", () => {
  test("answered: both reach the server, whole, and the flow ends at the first Bot", async () => {
    const { api, puts } = server({});
    const view = await mountApp({ path: "/welcome", api });

    await toKindQuestion(view);
    // Nothing chosen yet, so the way on is a skip.
    expect(view.buttonNamed("Skip")).toBeDefined();
    await press(view, "Restaurant or café");
    expect(
      view.buttonNamed("Restaurant or café")?.getAttribute("aria-pressed"),
    ).toBe("true");
    await press(view, "Next");

    await view.waitFor(
      () => text(view).includes("Pick the places you use every day"),
      "the second question",
    );
    expect(puts).toEqual([{ kind: "food", places: [] }]);
    // A restaurant's likeliest places lead: the delivery apps, before anybody's mail.
    expect(placeChips(view).slice(0, 3)).toEqual([
      "Baemin",
      "Coupang Eats",
      "Yogiyo",
    ]);

    await press(view, "Naver Smart Place");
    await press(view, "Baemin");
    await press(view, "Next");

    await view.waitFor(
      () => text(view).includes("Make your first Bot"),
      "the first Bot",
    );
    // In the order they were pressed: the first is the one a person reached for first.
    expect(puts.at(-1)).toEqual({
      kind: "food",
      places: ["naver-smartplace", "baemin-ceo"],
    });
  });

  test("skipped: nothing is sent, and the flow still ends at the first Bot", async () => {
    const { api, puts } = server({});
    const view = await mountApp({ path: "/welcome", api });

    await toKindQuestion(view);
    await press(view, "Skip");
    await view.waitFor(
      () => text(view).includes("Pick the places you use every day"),
      "the second question",
    );
    await press(view, "Skip");
    await view.waitFor(
      () => text(view).includes("Make your first Bot"),
      "the first Bot",
    );
    expect(puts).toEqual([]);
  });

  test("offers only the places this deployment can touch", async () => {
    // No browser behind this deployment, and Gmail the one account it can finish a consent for.
    const { api } = server({
      overview: { ...EVERYTHING, sites: [], accounts: [gmail] },
    });
    const view = await mountApp({ path: "/welcome", api });

    await toKindQuestion(view);
    await press(view, "Skip");
    await view.waitFor(
      () => placeChips(view).length > 0,
      "the places to be drawn",
    );
    expect(placeChips(view)).toEqual(["Gmail"]);
    expect(view.buttonNamed("Show more")).toBeUndefined();
  });

  test("says so when the places cannot be read, and the way on still works", async () => {
    const { api, puts } = server({ overview: "broken" });
    const view = await mountApp({ path: "/welcome", api });

    await toKindQuestion(view);
    await press(view, "Skip");
    await view.waitFor(
      () =>
        text(view).includes(
          "The places could not be loaded. You can pick them later in Settings.",
        ),
      "the failure to be said",
    );
    expect(placeChips(view)).toEqual([]);
    await press(view, "Skip");
    await view.waitFor(
      () => text(view).includes("Make your first Bot"),
      "the first Bot",
    );
    expect(puts).toEqual([]);
  });

  test("goes straight to the first Bot when there is no place to offer", async () => {
    const { api } = server({
      overview: { ...EVERYTHING, sites: [], accounts: [] },
    });
    const view = await mountApp({ path: "/welcome", api });

    await toKindQuestion(view);
    await press(view, "Skip");
    await view.waitFor(
      () => text(view).includes("Make your first Bot"),
      "the first Bot",
    );
    expect(text(view)).not.toContain("Pick the places you use every day");
  });

  test("shows a short list first, and the rest on request", async () => {
    const { api } = server({});
    const view = await mountApp({ path: "/welcome", api });

    await toKindQuestion(view);
    await press(view, "Skip");
    await view.waitFor(() => placeChips(view).length > 0, "the places");
    expect(placeChips(view)).toHaveLength(8);
    await press(view, "Show more");
    // Fifteen places reached through a site on this deployment's browser — Cafe24 by its admin
    // site, since this machine cannot finish a Cafe24 consent — and Gmail, its one account. The
    // other five accounts are not offered, because nothing here could connect them.
    expect(placeChips(view)).toHaveLength(16);
    expect(placeChips(view)).toContain("Cafe24");
    expect(placeChips(view)).not.toContain("Notion");
  });

  test("keeps the answer on the way back, and a failed save keeps the screen", async () => {
    const { api, puts } = server({ refuseShop: true });
    const view = await mountApp({ path: "/welcome", api });

    await toKindQuestion(view);
    await press(view, "Hair and beauty");
    await press(view, "Next");
    await view.waitFor(
      () => text(view).includes("That was not saved. Try again."),
      "the failure to be said",
    );
    expect(puts).toHaveLength(1);
    expect(text(view)).toContain("What kind of work do you do?");
    expect(
      view.buttonNamed("Hair and beauty")?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("comes back to what was answered before", async () => {
    // Somebody who closed the laptop between the questions and the first Bot.
    const { api } = server({
      shop: { kind: "online", places: ["naver-smartstore"] },
    });
    const view = await mountApp({ path: "/welcome", api });

    await toKindQuestion(view);
    expect(
      view.buttonNamed("Selling online")?.getAttribute("aria-pressed"),
    ).toBe("true");
    await press(view, "Next");
    await view.waitFor(() => placeChips(view).length > 0, "the places");
    expect(
      view.buttonNamed("Naver Smart Store")?.getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
