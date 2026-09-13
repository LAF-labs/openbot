import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { selectedWhenPressed } from "../src/components/ui/focus";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * A ROW OF BUTTONS WHERE THE FILL IS THE STATE SAYS NOTHING TO A SCREEN READER.
 *
 * Five of them shipped: the audit trail's filters, the plugin page's three tabs, the per-Bot grants
 * on a tool and on a skill, and the per-Bot grants on a component with the data functions under
 * them. Each drew the chosen one darker and announced, to anybody not looking at it, a list of
 * identical buttons — five Bot names with no indication which of them held the component.
 *
 * The fix is one attribute, and the reason this test exists is that it is one attribute: nothing
 * about a missing `aria-pressed` shows up in a typecheck, a screenshot or a click-through, so the
 * next group added will be built by copying one of these and will copy whatever is there.
 *
 * WHY NOT `role="tab"`. Two of these choose which panel is shown, which is what a tablist is for.
 * That role also promises arrow-key navigation and a roving tabindex; announcing "tab 2 of 3" in
 * front of controls that only answer to Tab and Enter is a worse lie than no role. They are toggle
 * buttons, and they say so.
 *
 * RENDERED, EACH SCREEN. The earlier file split the source at `bots.map((bot) => {` and looked for
 * the attribute inside the slice — a test that would have passed on `aria-pressed={false}` written
 * as a constant, and that broke on a formatter moving a brace. Here each group is a set of buttons
 * on a screen the router drew, the chosen one is the one the server said, and pressing another
 * one moves the state — through the server for a grant, which is the only place a grant lives.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const bots = [
  agentFixture({ id: "bot-1", name: "초롱" }),
  agentFixture({ id: "bot-2", name: "조약돌" }),
];

/** The buttons of one group, as `name → aria-pressed`. */
function stateOf(buttons: Iterable<Element>): Record<string, string | null> {
  return Object.fromEntries(
    [...buttons].map((button) => [
      button.textContent?.trim() ?? "",
      button.getAttribute("aria-pressed"),
    ]),
  );
}

/** The nearest ancestor of `anchor` that holds a toggle group. */
function groupAround(anchor: Element): HTMLButtonElement[] {
  let scope: Element | null = anchor;
  while (scope) {
    const buttons = [
      ...scope.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    ];
    if (buttons.length > 0) return buttons;
    scope = scope.parentElement;
  }
  throw new Error("no toggle group around that element");
}

function pressed(
  view: { main: () => Element | null },
  name: string,
): HTMLButtonElement {
  const found = [
    ...(view
      .main()
      ?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? []),
  ].find((button) => button.textContent?.trim() === name);
  if (!found) throw new Error(`no toggle named ${name}`);
  return found;
}

describe("the audit trail's filters", () => {
  test("say which is chosen, and a press moves it and asks for that slice", async () => {
    const view = await mountApp({ path: "/admin/audit", role: "admin" });
    const filters = groupAround(pressed(view, "Everything"));
    expect(stateOf(filters)).toEqual({
      Everything: "true",
      "Computer actions": "false",
      Blocked: "false",
      "Did not happen": "false",
      "Asked a person": "false",
      "Going in circles": "false",
    });

    await view.click(pressed(view, "Blocked"));
    expect(stateOf(groupAround(pressed(view, "Everything")))).toMatchObject({
      Everything: "false",
      Blocked: "true",
    });
    const refusals = view.requests.find(
      (request) =>
        request.pathname === "/api/admin/audit-events" &&
        request.url.searchParams
          .get("eventType")
          ?.startsWith("computer.action_refused"),
    );
    expect(refusals).toBeDefined();
    await view.unmount();
  });
});

/**
 * A Plugins page whose grants are real state: a press changes what the next read returns, which
 * is the only way a grant toggle can be seen to move — the page refetches after every write.
 */
function pluginsServer() {
  const toolGrants = new Set(["bot-1"]);
  const skillGrants = new Set(["bot-2"]);
  const page = () => ({
    catalogue: [],
    servers: [
      {
        id: "sheets",
        title: "Google Sheets",
        vendor: "Google",
        url: "https://mcp.example.com/sheets",
        summary: "",
        docsUrl: "https://example.com/docs",
        provenance: "first-party",
        hasCredential: true,
        toolsRefreshedAt: new Date().toISOString(),
        lastError: null,
        addedBy: null,
        authKind: "none",
        dynamicClient: false,
        withdrawn: [],
        tools: [
          {
            serverId: "sheets",
            name: "read_sheet",
            description: "Reads a sheet",
            inputSchema: {},
            ref: "sheets/read_sheet",
            effect: "read",
            grantedTo: [...toolGrants],
            needsReview: false,
            reviewReason: null,
            guard: null,
          },
        ],
      },
    ],
    skills: [
      {
        id: "skill-standup",
        slug: "standup",
        ownerUserId: null,
        title: "Standup notes",
        summary: "",
        instructions: "",
        origin: "admin",
        installedBy: null,
        grantedTo: [...skillGrants],
      },
    ],
  });
  const api: ApiAnswer = ({ method, pathname, url, body }) => {
    if (pathname === "/api/agents") return json({ agents: bots });
    if (pathname === "/api/plugins") return json(page());
    if (pathname === "/api/plugins/grants" && method === "POST") {
      const grant = body as { kind: string; agentId: string };
      (grant.kind === "mcp" ? toolGrants : skillGrants).add(grant.agentId);
      return json({ ok: true });
    }
    if (pathname === "/api/plugins/grants" && method === "DELETE") {
      const kind = url.searchParams.get("kind");
      const agentId = url.searchParams.get("agentId") ?? "";
      (kind === "mcp" ? toolGrants : skillGrants).delete(agentId);
      return json({ ok: true });
    }
    return undefined;
  };
  return api;
}

describe("the Plugins page", () => {
  test("its three tabs say which panel is open, and a press moves it", async () => {
    const view = await mountApp({
      path: "/admin/plugins",
      role: "admin",
      api: pluginsServer(),
    });
    expect(stateOf(groupAround(pressed(view, "Catalogue")))).toEqual({
      Catalogue: "true",
      Yours: "false",
      Skills: "false",
    });

    await view.click(pressed(view, "Yours"));
    expect(stateOf(groupAround(pressed(view, "Catalogue")))).toEqual({
      Catalogue: "false",
      Yours: "true",
      Skills: "false",
    });
    await view.unmount();
  });

  test("a tool's grants say which Bots hold it, and a press grants through the server", async () => {
    const view = await mountApp({
      path: "/admin/plugins",
      role: "admin",
      api: pluginsServer(),
    });
    await view.click(pressed(view, "Yours"));
    const tool = [...(view.main()?.querySelectorAll("span") ?? [])].find(
      (span) => span.textContent === "read_sheet",
    );
    if (!tool) throw new Error("the tool row is not on screen");
    expect(stateOf(groupAround(tool))).toEqual({
      초롱: "true",
      조약돌: "false",
    });

    await view.click(pressed(view, "조약돌"));
    await view.waitFor(
      () => pressed(view, "조약돌").getAttribute("aria-pressed") === "true",
      "the grant to come back from the server",
    );
    expect(
      view.requests.find(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/api/plugins/grants",
      )?.body,
    ).toEqual({ kind: "mcp", ref: "sheets/read_sheet", agentId: "bot-2" });
    expect(stateOf(groupAround(tool))).toEqual({
      초롱: "true",
      조약돌: "true",
    });
    await view.unmount();
  });

  test("a skill's grants do the same, and a press on a held one revokes", async () => {
    const view = await mountApp({
      path: "/admin/plugins",
      role: "admin",
      api: pluginsServer(),
    });
    await view.click(pressed(view, "Skills"));
    const row = [...(view.main()?.querySelectorAll("code") ?? [])].find(
      (code) => code.textContent === "/standup",
    );
    if (!row) throw new Error("the skill row is not on screen");
    expect(stateOf(groupAround(row))).toEqual({
      초롱: "false",
      조약돌: "true",
    });

    await view.click(pressed(view, "조약돌"));
    await view.waitFor(
      () => pressed(view, "조약돌").getAttribute("aria-pressed") === "false",
      "the revocation to come back from the server",
    );
    const revoked = view.requests.find(
      (request) =>
        request.method === "DELETE" &&
        request.pathname === "/api/plugins/grants",
    );
    expect(revoked?.url.searchParams.get("kind")).toBe("skill");
    expect(revoked?.url.searchParams.get("ref")).toBe("standup");
    expect(revoked?.url.searchParams.get("agentId")).toBe("bot-2");
    await view.unmount();
  });
});

/** A Components page with one card, whose grants and functions are state the writes change. */
function componentsServer() {
  const withheld = new Set(["bot-2"]);
  const held = new Set(["botActivity"]);
  const card = () => ({
    name: "activity-report",
    title: "Activity report",
    kind: "card",
    draftDescription: "",
    publishedDescription: "How busy each Bot has been.",
    published: true,
    publishedAt: new Date().toISOString(),
    updatedBy: "the build",
    updatedAt: new Date().toISOString(),
    hasUnpublishedChanges: false,
    withheldFrom: [...withheld],
    functions: [...held],
  });
  const api: ApiAnswer = ({ method, pathname, body }) => {
    if (pathname === "/api/agents") return json({ agents: bots });
    if (pathname === "/api/components") return json({ components: [card()] });
    if (pathname === "/api/components/functions") {
      return json({
        functions: [
          { name: "botActivity", description: "", reads: "the audit trail" },
          { name: "recentRefusals", description: "", reads: "the audit trail" },
        ],
      });
    }
    const grants = pathname.match(
      /^\/api\/components\/activity-report\/grants(?:\/(.+))?$/,
    );
    if (grants && method === "POST") {
      withheld.delete((body as { agentId: string }).agentId);
      return json({ ok: true });
    }
    if (grants?.[1] && method === "DELETE") {
      withheld.add(decodeURIComponent(grants[1]));
      return json({ ok: true });
    }
    const functions = pathname.match(
      /^\/api\/components\/activity-report\/functions(?:\/(.+))?$/,
    );
    if (functions && method === "POST") {
      held.add((body as { function: string }).function);
      return json({ ok: true });
    }
    if (functions?.[1] && method === "DELETE") {
      held.delete(decodeURIComponent(functions[1]));
      return json({ ok: true });
    }
    return undefined;
  };
  return api;
}

describe("the Components page", () => {
  test("a card's Bot grants say who holds it, and a press moves through the server", async () => {
    const view = await mountApp({
      path: "/admin/components",
      role: "admin",
      api: componentsServer(),
    });
    const grant = (botId: string) => {
      const button = view
        .main()
        ?.querySelector<HTMLButtonElement>(
          `[data-testid="grant-activity-report-${botId}"]`,
        );
      if (!button) throw new Error(`no grant button for ${botId}`);
      return button;
    };
    expect(grant("bot-1").getAttribute("aria-pressed")).toBe("true");
    expect(grant("bot-2").getAttribute("aria-pressed")).toBe("false");

    await view.click(grant("bot-2"));
    await view.waitFor(
      () => grant("bot-2").getAttribute("aria-pressed") === "true",
      "the grant to come back from the server",
    );
    await view.click(grant("bot-1"));
    await view.waitFor(
      () => grant("bot-1").getAttribute("aria-pressed") === "false",
      "the withholding to come back from the server",
    );
    expect(
      view.requests
        .filter((request) => request.pathname.includes("/grants"))
        .map((request) => `${request.method} ${request.pathname}`),
    ).toEqual([
      "POST /api/components/activity-report/grants",
      "DELETE /api/components/activity-report/grants/bot-1",
    ]);
    await view.unmount();
  });

  test("the data functions under it say which may be read, and a press moves too", async () => {
    const view = await mountApp({
      path: "/admin/components",
      role: "admin",
      api: componentsServer(),
    });
    const fn = (name: string) => {
      const button = view
        .main()
        ?.querySelector<HTMLButtonElement>(
          `[data-testid="function-activity-report-${name}"]`,
        );
      if (!button) throw new Error(`no function button for ${name}`);
      return button;
    };
    expect(fn("botActivity").getAttribute("aria-pressed")).toBe("true");
    expect(fn("recentRefusals").getAttribute("aria-pressed")).toBe("false");

    await view.click(fn("recentRefusals"));
    await view.waitFor(
      () => fn("recentRefusals").getAttribute("aria-pressed") === "true",
      "the function grant to come back from the server",
    );
    expect(
      view.requests.find(
        (request) =>
          request.method === "POST" &&
          request.pathname === "/api/components/activity-report/functions",
      )?.body,
    ).toEqual({ function: "recentRefusals" });
    await view.unmount();
  });
});

describe("how a chosen toggle is drawn", () => {
  test("comes from the attribute, not from a swapped variant", async () => {
    /*
     * `variant={chosen ? "default" : "outline"}` was how all of these said it, and `default` is the
     * PRIMARY fill — the same treatment as the one button on a page you are meant to press. So a
     * strip of five grants read as five calls to action, and a chosen-and-focused one said chosen
     * twice in two different greys. `Button` draws it from `aria-pressed` now
     * (`components/ui/focus.ts`), so a chosen and an unchosen button in one group carry the SAME
     * classes: the attribute is the only difference between them.
     */
    for (const [path, api, anchor] of [
      ["/admin/audit", undefined, "Everything"],
      ["/admin/plugins", pluginsServer(), "Catalogue"],
    ] as const) {
      const view = await mountApp({ path, role: "admin", api });
      const group = groupAround(pressed(view, anchor));
      const chosen = group.find(
        (button) => button.getAttribute("aria-pressed") === "true",
      );
      const other = group.find(
        (button) => button.getAttribute("aria-pressed") === "false",
      );
      expect(chosen?.className).toBe(other?.className ?? "");
      expect(chosen?.className).toContain(selectedWhenPressed);
      await view.unmount();
    }
  });
});
