/**
 * THE COMPUTERS PAGE, RENDERED IN KOREAN, WITH ITS RESET ASKED AND CONFIRMED.
 *
 * In a process of its own for the two reasons `feedback-render.tsx` gives: the locale is decided when
 * the dictionary is first loaded, and Base UI's dialog decides once, when it is first evaluated,
 * whether there is a DOM to portal into (`confirm-dialog.test.tsx`). Both are settled here before
 * any app module is imported, so the confirmation is the real popup and its button is really pressed.
 *
 * The server is stubbed the way the real one answers since `397213f`: the address the page used to
 * ask, `/api/computers/shared/computers`, is the ownership guard's 404, and the list is at
 * `/api/computers`. Its one argument is the Bot on the row. Prints one line,
 * `COMPUTERS_RENDER <json>`. Not a test file (no `.test.` in the name), so the runner never collects
 * it on its own — and nothing may import a value from it, which would run it: types only.
 *
 *     bun app/tests/support/computers-render.tsx agent_…
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export type ComputersShown = {
  /** Every request the page made, as `METHOD path`, in order. */
  requests: string[];
  /** The row titles, as the list drew them. */
  rows: string[];
  /** Every button under the page's own pane before anything was pressed. */
  buttons: string[];
  /** Anything the page raised as an alert before anything was pressed. */
  alerts: string[];
  /** The confirmation's title and description, as the popup drew them. */
  title: string;
  description: string;
  /** Reset requests made before the confirmation was answered. */
  resetsBeforeConfirm: number;
  /** Reset requests made once it was, in order. */
  resets: string[];
};

/** A Bot this account made, with a tab open on the deployment's one browser. */
const RENDERED_BOT = process.argv[2] ?? "";
if (!RENDERED_BOT) throw new Error("name the row's Bot as the one argument");

process.env.NODE_ENV = "test";
GlobalRegistrator.register({ url: "http://localhost:3110/" });
window.localStorage.setItem("laf.locale", "ko");
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NoSocket;
(window as unknown as { WebSocket: unknown }).WebSocket = NoSocket;

const { agentFixture, json, mountApp } = await import("./app-router");

const NOT_FOUND = { error: "laf:bot_not_found", code: "laf:bot_not_found" };

const view = await mountApp({
  path: "/admin/computers",
  role: "admin",
  api: ({ method, pathname }) => {
    if (pathname === "/api/agents") {
      return json({
        agents: [agentFixture({ id: RENDERED_BOT, name: "초롱" })],
      });
    }
    if (method === "GET" && pathname === "/api/computers") {
      return json({
        isolation: "shared",
        computers: [
          {
            botId: RENDERED_BOT,
            running: true,
            startedAt: "2026-09-16T09:00:00.000Z",
            egress: null,
          },
        ],
      });
    }
    // What the real guard answers the old address: `shared` is no Bot anybody has.
    if (pathname.startsWith("/api/computers/shared/")) {
      return json(NOT_FOUND, 404);
    }
    if (
      method === "POST" &&
      pathname === `/api/computers/${RENDERED_BOT}/computers/reset`
    ) {
      return json({ reset: true, botId: RENDERED_BOT, scope: "deployment" });
    }
    return undefined;
  },
});

const body = document.body;
const main = () => view.main();
const dialog = () => body.querySelector('[role="dialog"]');
const buttonsIn = (root: Element | null | undefined) => [
  ...(root?.querySelectorAll<HTMLButtonElement>("button") ?? []),
];
const named = (root: Element | null | undefined, name: string) =>
  buttonsIn(root).find((button) => button.textContent?.trim() === name);
const resets = () =>
  view.requests
    .filter(
      (request) =>
        request.method === "POST" && request.pathname.endsWith("/reset"),
    )
    .map((request) => request.pathname);

// A row is drawn, or the page gave up: either way the wait ends, and the line says which.
await view.waitFor(
  () =>
    named(main(), "초기화") !== undefined ||
    (main()?.textContent ?? "").includes("목록을 불러오지 못했습니다"),
  "a row with its Reset button, or the page's load error",
);
await view.settle(30);

const rows = [...(main()?.querySelectorAll('[data-slot="item-title"]') ?? [])]
  .map((title) => title.textContent?.trim() ?? "")
  .filter(Boolean);
const buttons = buttonsIn(main()).map(
  (button) => button.textContent?.trim() ?? "",
);
const alerts = [...(main()?.querySelectorAll('[role="alert"]') ?? [])].map(
  (alert) => alert.textContent?.trim() ?? "",
);

const reset = named(main(), "초기화");
if (!reset) {
  throw new Error(
    `no Reset button on the page: rows=${JSON.stringify(rows)} alerts=${JSON.stringify(alerts)} requests=${JSON.stringify(view.requests.map((request) => `${request.method} ${request.path}`))}`,
  );
}
await view.click(reset);
await view.waitFor(() => dialog() !== null, "the reset confirmation");
await view.settle(30);

const title =
  dialog()?.querySelector('[data-slot="dialog-title"]')?.textContent ?? "";
const description =
  dialog()?.querySelector('[data-slot="dialog-description"]')?.textContent ??
  "";
const resetsBeforeConfirm = resets().length;

// The popup's own button: in Korean, the row's and the confirmation's are the same word.
const confirm = named(dialog(), "초기화");
if (!confirm) throw new Error("the confirmation has no 초기화 button");
await view.click(confirm);
await view.waitFor(() => resets().length > 0, "the reset request");
await view.settle(30);

const shown: ComputersShown = {
  requests: view.requests.map((request) => `${request.method} ${request.path}`),
  rows,
  buttons,
  alerts,
  title,
  description,
  resetsBeforeConfirm,
  resets: resets(),
};
await view.unmount();
console.log(`COMPUTERS_RENDER ${JSON.stringify(shown)}`);
process.exit(0);
