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
/** A Bot the container still lists and the viewer may not drive: deleted (audit R3-09), or not theirs. */
const GONE = "agent_9d0e7b6a-1c2f-4e3d-8a5b-6c7d8e9f0a1b";
const NOT_FOUND = { error: "laf:bot_not_found", code: "laf:bot_not_found" };

/**
 * The server, as it answers an administrator whose Bot is `BOT`. `refuseStop` is the ownership
 * guard's answer to a stop, which is what a Bot deleted between the list and the press meets.
 */
const serverWith =
  (options: { refuseStop?: boolean } = {}): ApiAnswer =>
  ({ method, pathname }) => {
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
            mayDrive: true,
          },
          {
            botId: GONE,
            running: false,
            startedAt: null,
            egress: null,
            mayDrive: false,
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
      return options.refuseStop
        ? json(NOT_FOUND, 404)
        : json({ stopped: true, wasRunning: true });
    }
    return undefined;
  };
const server = serverWith();

/** One row of the list, by the title it drew. */
function rowTitled(main: Element | null, title: string): Element {
  const found = [
    ...(main?.querySelectorAll('[data-slot="item-title"]') ?? []),
  ].find((candidate) => candidate.textContent === title);
  // The title sits in the row's content, whose parent is the row with its actions beside it.
  const row = found?.closest('[data-slot="item-content"]')?.parentElement;
  if (!row) throw new Error(`no row titled ${title}`);
  return row;
}

const buttonsIn = (row: Element) =>
  [...row.querySelectorAll("button")].map((button) =>
    button.textContent?.trim(),
  );

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
    expect(titles).toEqual(["초롱", GONE]);
    expect(buttonsIn(rowTitled(main, "초롱"))).toEqual([
      "Close its tabs",
      "Reset",
    ]);
    expect(view.buttonNamed("Reset")?.disabled).toBe(false);
    expect(view.buttonNamed("Close its tabs")?.disabled).toBe(false);
    // And no load error, and no retry that could never work.
    expect(main?.querySelector('[role="alert"]')).toBeNull();
    expect(main?.textContent).not.toContain("The list could not be loaded.");
    expect(main?.textContent).toContain("Every Bot is sharing one computer.");
    await view.unmount();
  });

  /*
   * MEASURED 2026-09-16 IN THE REAL PAGE, against a real server and a real computer: a row for a Bot
   * the administrator could not drive drew both buttons, and Reset on it was refused 404. That row is
   * still listed — the computer holds it — but it no longer offers two presses that can only fail.
   */
  test("a row whose Bot the viewer cannot drive is listed without controls that could only be refused", async () => {
    const view = await mountApp({
      path: "/admin/computers",
      role: "admin",
      api: server,
    });
    await view.waitFor(
      () => view.buttonNamed("Reset") !== undefined,
      "the rows",
    );

    const gone = rowTitled(view.main(), GONE);
    expect(buttonsIn(gone)).toEqual([]);
    expect(gone.textContent).toContain(
      "This is not one of your Bots, or it was deleted, so it cannot be stopped or reset from here.",
    );
    // One Reset on the page: the row whose Bot is the viewer's.
    expect(
      [...(view.main()?.querySelectorAll("button") ?? [])].filter(
        (button) => button.textContent?.trim() === "Reset",
      ),
    ).toHaveLength(1);
    await view.unmount();
  });

  /*
   * AND A PRESS THAT WAS REFUSED SAYS SO. The page set its error and then read the list again, and a
   * list that loaded cleared the error it had just set: measured, Reset refused with 404 closed its
   * dialog and left the page exactly as it was, with nothing on it saying nothing had happened.
   */
  test("a refused press is said on the page, and reading the list afterwards does not wipe it away", async () => {
    const view = await mountApp({
      path: "/admin/computers",
      role: "admin",
      api: serverWith({ refuseStop: true }),
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
    await view.settle(30);

    expect(view.main()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The browser could not be stopped.",
    );
    // The list itself still loaded: the error is the press's, not the page's.
    expect(view.main()?.textContent).not.toContain(
      "The list could not be loaded.",
    );
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
    expect(shown.rows).toEqual(["초롱", GONE]);
    // Two controls, both on the viewer's own row; the other row says why it has none, in Korean.
    expect(shown.buttons).toEqual(["이 봇의 탭 닫기", "초기화"]);
    expect(shown.rowTexts[1]).toContain(
      "내 봇이 아니거나 삭제된 봇이라 여기서 탭을 닫거나 초기화할 수 없어요.",
    );

    // The confirmation names what goes — every Bot's logins, not the row's — before anything is sent.
    expect(shown.resetsBeforeConfirm).toBe(0);
    expect(shown.title).toBe("봇들이 함께 쓰는 컴퓨터를 초기화할까요?");
    expect(shown.description).toContain("봇 전부가");
    expect(shown.description).toContain("로그아웃");
    expect(shown.description).toContain("되돌릴 수 없어요");

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
    ["bun", join(import.meta.dir, "support/computers-render.tsx"), BOT, GONE],
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
