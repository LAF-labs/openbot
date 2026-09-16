import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { join } from "node:path";
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
// A type only: a value imported from the render script would run it, in this process.
import type { ComputersShown } from "./support/computers-render";

/**
 * THE COMPUTERS PAGE, LOADED AGAINST A SERVER THAT ANSWERS THE WAY THE REAL ONE DOES.
 *
 * MEASURED 2026-09-16 (audit R3-04, R5-02): the page asked for its list at
 * `/api/computers/shared/computers`. `shared` is no Bot anybody has, and once `397213f` took the
 * administrator exception out of the ownership guard, the real guard chain answered that address
 * 404 `laf:bot_not_found` — to the administrator too. The page drew "컴퓨터 목록을 불러오지
 * 못했습니다" with a retry that could never work, and no rows, so its Reset button was never drawn:
 * one of the only two doors that empty the browser profile every Bot signs in through
 * (docs/laf/deployment-model.md). No test loaded this page, so the gate stayed green.
 *
 * So the stub below is the server as it is: the old address is the guard's 404, the list lives at
 * `/api/computers`, and a row's own Bot is what stop and reset are addressed through.
 *
 * The confirmation is Base UI's portal, which this suite cannot render reliably
 * (`confirm-dialog.test.tsx` says why), so the press through it is made in a process of its own, in
 * Korean — which is also the language the sentence has to say "every Bot" in.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const BOT = "agent_2f1c9a3e-7d24-4a6b-9b1e-0c8f5d2a7b41";
const NOT_FOUND = { error: "laf:bot_not_found", code: "laf:bot_not_found" };

/** The server, as it answers an administrator whose Bot is `BOT`. */
const server: ApiAnswer = ({ method, pathname }) => {
  if (pathname === "/api/agents") {
    return json({ agents: [agentFixture({ id: BOT, name: "초롱" })] });
  }
  if (method === "GET" && pathname === "/api/computers") {
    return json({
      isolation: "shared",
      computers: [
        {
          botId: BOT,
          running: true,
          startedAt: "2026-09-16T09:00:00.000Z",
          egress: null,
        },
      ],
    });
  }
  // The ownership guard's answer to an id no `agents` row has (audit R3-04, measured).
  if (pathname.startsWith("/api/computers/shared/")) {
    return json(NOT_FOUND, 404);
  }
  if (
    method === "POST" &&
    pathname === `/api/computers/${BOT}/computers/stop`
  ) {
    return json({ stopped: true, wasRunning: true });
  }
  return undefined;
};

describe("the Computers page", () => {
  test("lists what the one browser holds from the address that names no Bot, a row per Bot with its Reset button", async () => {
    const view = await mountApp({
      path: "/admin/computers",
      role: "admin",
      api: server,
    });
    await view.waitFor(
      () => view.buttonNamed("Reset") !== undefined,
      "the row's Reset button",
    );

    const main = view.main();
    expect(
      view.requests
        .filter((request) => request.pathname.startsWith("/api/computers"))
        .map((request) => `${request.method} ${request.path}`),
    ).toEqual(["GET /api/computers"]);
    // The row names the Bot, and carries both of its controls.
    const titles = [
      ...(main?.querySelectorAll('[data-slot="item-title"]') ?? []),
    ].map((title) => title.textContent);
    expect(titles).toEqual(["초롱"]);
    expect(view.buttonNamed("Reset")?.disabled).toBe(false);
    expect(view.buttonNamed("Close its tabs")?.disabled).toBe(false);
    // And no load error, and no retry that could never work.
    expect(main?.querySelector('[role="alert"]')).toBeNull();
    expect(main?.textContent).not.toContain("The list could not be loaded.");
    expect(main?.textContent).toContain("Every Bot is sharing one computer.");
    await view.unmount();
  });

  test("a row's Close its tabs stops that Bot's tabs and reads the list again", async () => {
    const view = await mountApp({
      path: "/admin/computers",
      role: "admin",
      api: server,
    });
    await view.waitFor(
      () => view.buttonNamed("Close its tabs") !== undefined,
      "the row's Close its tabs button",
    );
    const close = view.buttonNamed("Close its tabs");
    if (!close) throw new Error("no Close its tabs button");

    await view.click(close);
    await view.waitFor(
      () =>
        view.requests.filter((request) => request.pathname === "/api/computers")
          .length === 2,
      "the list to be read again",
    );

    expect(
      view.requests
        .filter((request) => request.pathname.startsWith("/api/computers"))
        .map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "GET /api/computers",
      `POST /api/computers/${BOT}/computers/stop`,
      "GET /api/computers",
    ]);
    expect(view.main()?.querySelector('[role="alert"]')).toBeNull();
    await view.unmount();
  });

  test("Reset asks first, says every Bot is signed out, and resets through the row's Bot once confirmed", async () => {
    const shown = await renderedInKorean();

    // The page reached its list without ever asking the address that is somebody's 404.
    expect(
      shown.requests.filter((request) => request.includes("/shared/")),
    ).toEqual([]);
    expect(shown.requests).toContain("GET /api/computers");
    expect(shown.alerts).toEqual([]);
    expect(shown.rows).toEqual(["초롱"]);
    expect(shown.buttons).toEqual(
      expect.arrayContaining(["이 봇의 탭 닫기", "초기화"]),
    );

    // The confirmation names what goes — every Bot's logins, not the row's — before anything is sent.
    expect(shown.resetsBeforeConfirm).toBe(0);
    expect(shown.title).toBe("봇들이 함께 쓰는 컴퓨터를 초기화할까요?");
    expect(shown.description).toContain("봇 전부가");
    expect(shown.description).toContain("로그아웃");
    expect(shown.description).toContain("되돌릴 수 없습니다");

    // And once it is answered, exactly one reset, through the row's own Bot.
    expect(shown.resets).toEqual([`/api/computers/${BOT}/computers/reset`]);
  }, 120_000);
});

let rendering: Promise<ComputersShown> | undefined;

/** One Korean process for the file: the route tree is expensive to load. */
function renderedInKorean(): Promise<ComputersShown> {
  rendering ??= render();
  return rendering;
}

async function render(): Promise<ComputersShown> {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/computers-render.tsx"), BOT],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("COMPUTERS_RENDER "));
  if (status !== 0 || !line) {
    throw new Error(
      `the Korean render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("COMPUTERS_RENDER ".length)) as ComputersShown;
}
