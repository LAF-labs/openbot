import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { agentKeys } from "../src/lib/agents/queries";
import { routineKeys } from "../src/lib/routines/queries";
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
 * THE MAIN SCREENS, DRAWN IN THE STATES `readingOf` NAMES — THROUGH THE REAL ROUTE TREE.
 *
 * Each state is produced the way it happens: the stub server answers the read with a 500, with the
 * server's own `laf:not_found`, with an empty list, or answers once and then fails the refresh. What
 * is asserted is what a person would read and what they could press — the failure shapes this work
 * exists for were all green in the gate and wrong on screen (measured 2026-09-18 on a built app:
 * the roster saying 아직 봇이 없습니다 over a 500, a Bot's memories saying 아직 없습니다 over a
 * `laf:not_found`, a profile replaced whole by a red line when a refresh failed).
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const BOT = agentFixture({ id: "agent-1", name: "Sprout" });

const refused = (code: string, status: number) =>
  json({ error: code, code }, status);

/** The roster answered — the visible list only; the hidden one keeps the shell's empty answer. */
const roster =
  (answer: () => Response): ApiAnswer =>
  (request) =>
    request.pathname === "/api/agents" && request.url.search === ""
      ? answer()
      : undefined;

/**
 * The one press a failed read offers, inside `within`.
 *
 * Asserted on as a boolean, never as the element: a failing `expect(element)` has bun print the
 * element with the whole window behind it, which took two and a half minutes to fail one test.
 */
const tryAgainIn = (within: Element | null) =>
  [...(within?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.trim() === "Try again",
  );

async function startRefetch(
  view: Awaited<ReturnType<typeof mountApp>>,
  queryKey: readonly unknown[],
) {
  const { act } = await import("react");
  // Started inside `act`, waited for outside it — see `navigate` in `support/app-router.tsx`.
  await act(async () => {
    void view.queryClient.refetchQueries({ queryKey });
  });
}

describe("the roster", () => {
  test("a Bots list that could not be read says so and offers to ask again — never that there are none", async () => {
    let failing = true;
    const view = await mountApp({
      path: "/skills",
      api: roster(() =>
        failing ? refused("laf:internal", 500) : json({ agents: [BOT] }),
      ),
    });
    const nav = () => view.host.querySelector('nav[aria-label="Your Bot"]');
    await view.waitFor(
      () =>
        (nav()?.textContent ?? "").includes("Your Bot could not be loaded."),
      "the roster's failure line",
    );
    expect(nav()?.textContent).not.toContain("No Bots yet.");

    failing = false;
    const again = tryAgainIn(nav());
    if (!again) throw new Error("the roster offered no way to ask again");
    await view.click(again);
    await view.waitFor(
      () => (nav()?.textContent ?? "").includes("Sprout"),
      "the Bot to arrive",
    );
    expect(nav()?.querySelector("[data-roster-notice]")).toBeNull();
    // And the roster's notice has fallen quiet again — still mounted, saying nothing.
    expect(nav()?.querySelector("[data-read-state]")).toBeNull();
    expect(
      [...(nav()?.querySelectorAll('[role="alert"]') ?? [])].map(
        (alert) => alert.textContent,
      ),
    ).toEqual([""]);
  });

  /*
   * NO "아직 봇이 없습니다" AND NO 새 봇 (2026-09-24). A person has one Bot, and somebody with none
   * is sent to the first run to make it; the sidebar has nothing to offer about making another.
   */
  test("with no Bot, the sidebar draws no row and no way to make one", async () => {
    const view = await mountApp({ path: "/skills" });
    const nav = view.host.querySelector('nav[aria-label="Your Bot"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelectorAll("ul a")).toHaveLength(0);
    expect(nav?.textContent).not.toContain("New Bot");
    expect(nav?.querySelector("[data-roster-notice]")).toBeNull();
  });
});

describe("a Bot's profile", () => {
  /** The profile at `/agents?agent=agent-1`, its memories answered by `memories`. */
  const profile = (memories: () => Response, detail?: () => Response) =>
    mountApp({
      path: "/agents?agent=agent-1",
      api: (request) => {
        if (request.pathname === "/api/agents" && request.url.search === "") {
          return json({ agents: [BOT] });
        }
        if (request.pathname === "/api/agents/agent-1") {
          return detail ? detail() : json({ agent: BOT });
        }
        if (request.pathname === "/api/agents/agent-1/memories") {
          return memories();
        }
        return undefined;
      },
    });

  const card = (host: Element) =>
    [...host.querySelectorAll("section")].find(
      (section) =>
        section.querySelector("h2")?.textContent === "What it remembers",
    );

  test("a deployment with no memory store says so — not 'nothing yet', and nothing to press", async () => {
    const view = await profile(() => refused("laf:not_found", 404));
    await view.waitFor(
      // `?? null`: with no card on screen yet, `undefined !== null` would read as settled.
      () =>
        (card(view.host)?.querySelector("[data-read-state]") ?? null) !== null,
      "the memories card to settle",
    );
    const memories = card(view.host);
    expect(memories?.textContent).toContain(
      "Bots here do not keep what they learn between conversations",
    );
    expect(memories?.textContent).not.toContain("Nothing yet.");
    expect(tryAgainIn(memories ?? null) === undefined).toBe(true);
  });

  test("memories that could not be read say so, with 다시 시도 — not 'nothing yet'", async () => {
    const view = await profile(() => refused("laf:internal", 500));
    await view.waitFor(
      () =>
        (card(view.host)?.querySelector('[data-read-state="failed"]') ??
          null) !== null,
      "the memories card's failure line",
    );
    const memories = card(view.host);
    expect(memories?.textContent).toContain(
      "What it remembers could not be loaded.",
    );
    expect(memories?.textContent).not.toContain("Nothing yet.");
    expect(tryAgainIn(memories ?? null) !== undefined).toBe(true);
  });

  test("nothing learned yet is said only once the answer is in", async () => {
    const view = await profile(() => json({ memories: [] }));
    await view.waitFor(
      () => (card(view.host)?.textContent ?? "").includes("Nothing yet."),
      "the empty memories line",
    );
  });

  test("a refresh that fails keeps the profile on screen, under a quiet line", async () => {
    let failing = false;
    const view = await profile(
      () => json({ memories: [] }),
      () => (failing ? refused("laf:internal", 500) : json({ agent: BOT })),
    );
    // The name is a field you can change now (2026-09-24), not a heading.
    const profileName = () =>
      [...view.host.querySelectorAll("main input")].some(
        (field) => (field as HTMLInputElement).value === "Sprout",
      );
    await view.waitFor(profileName, "the profile");

    failing = true;
    await startRefetch(view, agentKeys.detail("agent-1"));
    await view.waitFor(
      () => view.host.querySelector('[data-read-state="stale"]') !== null,
      "the stale line",
    );
    // The Bot is still there — its name, its cards — and the line says the rest.
    expect(profileName()).toBe(true);
    expect(view.host.textContent).not.toContain("Could not load this Bot.");
  });

  test("a Bot that is no longer there says so, and offers nothing to press", async () => {
    const view = await profile(
      () => json({ memories: [] }),
      () => refused("laf:agent_not_found", 404),
    );
    await view.waitFor(
      () =>
        (view.host.textContent ?? "").includes("This Bot is no longer here."),
      "the unavailable line",
    );
    expect(view.host.querySelector('[data-read-state="failed"]')).toBeNull();
  });
});

describe("routines", () => {
  const ROUTINE = {
    id: "routine-1",
    agentId: "agent-1",
    name: "Morning check",
    instruction: "Tell me today's date",
    scheduleKind: "daily",
    intervalMinutes: null,
    dailyLocal: "09:00",
    dailyTimeZone: "Asia/Seoul",
    dailyDays: [],
    enabled: true,
    lastRunAt: null,
    nextRunAt: "2026-09-19T00:00:00.000Z",
  };

  test("a refresh that fails keeps the rows, and says so without an alert", async () => {
    let failing = false;
    const view = await mountApp({
      path: "/routines",
      api: (request) =>
        request.pathname === "/api/routines"
          ? failing
            ? refused("laf:internal", 500)
            : json({ routines: [ROUTINE] })
          : request.pathname === "/api/routines/suggestions"
            ? json({ suggestions: [] })
            : undefined,
    });
    const main = () => view.main();
    await view.waitFor(
      () => (main()?.textContent ?? "").includes("Morning check"),
      "the routine row",
    );

    failing = true;
    await startRefetch(view, routineKeys.all);
    await view.waitFor(
      () => main()?.querySelector('[data-read-state="stale"]') !== null,
      "the stale line",
    );
    expect(main()?.textContent).toContain("Morning check");
    // Nothing alarming is SAID: the alert region is there, mounted before it speaks, and empty.
    expect(
      [...(main()?.querySelectorAll('[role="alert"]') ?? [])].some((alert) =>
        alert.textContent?.trim(),
      ),
    ).toBe(false);
  });

  test("routines this place does not offer say so, and offer nothing to press", async () => {
    const view = await mountApp({
      path: "/routines",
      api: (request) =>
        request.pathname === "/api/routines"
          ? refused("laf:not_found", 404)
          : request.pathname === "/api/routines/suggestions"
            ? refused("laf:not_found", 404)
            : undefined,
    });
    await view.waitFor(
      () =>
        (view.main()?.textContent ?? "").includes(
          "Routines are not offered here.",
        ),
      "the unavailable line",
    );
    expect(tryAgainIn(view.main()) === undefined).toBe(true);
    expect(view.main()?.textContent).not.toContain("No routines yet.");
  });
});

describe("Settings", () => {
  test("연결 with nothing to connect says so, instead of a title over nothing", async () => {
    const view = await mountApp({ path: "/settings/connected-accounts" });
    expect(view.main()?.textContent).toContain(
      "There is nothing this deployment can connect yet.",
    );
  });

  test("연결 on a deployment without it says so, with nothing to press", async () => {
    const view = await mountApp({
      path: "/settings/connected-accounts",
      api: (request) =>
        request.pathname === "/api/connections/overview"
          ? refused("laf:not_found", 404)
          : undefined,
    });
    await view.waitFor(
      () =>
        (view.main()?.textContent ?? "").includes(
          "Connections are not offered here.",
        ),
      "the unavailable line",
    );
    expect(tryAgainIn(view.main()) === undefined).toBe(true);
  });

  test("내 가게's places that could not be read offer 다시 시도, and a press brings them", async () => {
    let failing = true;
    const view = await mountApp({
      path: "/settings/shop",
      api: (request) =>
        request.pathname === "/api/connections/overview" && failing
          ? refused("laf:internal", 500)
          : undefined,
    });
    await view.waitFor(
      () =>
        (view.main()?.textContent ?? "").includes(
          "The places could not be loaded.",
        ),
      "the places' failure line",
    );
    // No refresh to press in an installed app: the way to ask again is on the screen.
    expect(view.main()?.textContent).not.toContain("Refresh");

    failing = false;
    const again = tryAgainIn(view.main());
    if (!again) throw new Error("the places offered no way to ask again");
    await view.click(again);
    await view.waitFor(
      () =>
        !(view.main()?.textContent ?? "").includes(
          "The places could not be loaded.",
        ),
      "the failure line to clear",
    );
  });
});
