/**
 * THE 문의·의견 BOX, RENDERED IN KOREAN, WITH "진단 정보 같이 보내기" TICKED AND SENT.
 *
 * In a process of its own for two reasons measured elsewhere: the locale is decided when the
 * dictionary is first loaded (`korean-render.tsx`), and Base UI's dialog decides once, when it is
 * first evaluated, whether there is a DOM to portal into (`confirm-dialog.test.tsx`). Both are chosen
 * here before any app module is imported.
 *
 * Reads a scenario from the JSON file named by its one argument — the bundles the server hands out,
 * in order, and whether the first send is refused as expired — opens `/help`, presses 문의·의견,
 * ticks the box, reads the preview, writes a message and sends it, and prints one line,
 * `FEEDBACK_RENDER <json>`, with what the screen said and what the browser sent. Not a test file (no
 * `.test.` in the name), so the runner never collects it on its own.
 *
 *     bun app/tests/support/feedback-render.tsx /tmp/scenario.json
 */
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export type FeedbackScenario = {
  bundles: unknown[];
  expireFirstSend: boolean;
  message: string;
};

export type FeedbackShown = {
  /** Diagnostics requests made before the box was ticked. */
  gatheredBeforeTick: number;
  /** The preview's text, the exact bundle folded inside it excluded. */
  preview: string;
  /** The exact bundle, as the fold inside the preview prints it. */
  exact: string;
  /** Every diagnostics request made, in order. */
  gathered: number;
  /** Every body the box posted to the feedback route, in order. */
  posts: unknown[];
  /** The refusal the first send drew, when it was refused. */
  refusal: string | null;
  /** The preview's text after the refusal gathered a new bundle. */
  previewAfterRefusal: string | null;
  /** The receipt line. */
  receipt: string;
};

const scenario = JSON.parse(
  readFileSync(process.argv[2] as string, "utf8"),
) as FeedbackScenario;

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

const { json, mountApp } = await import("./app-router");
const { act } = await import("react");

let handedOut = 0;
let refusedOnce = false;
const posts: unknown[] = [];

const view = await mountApp({
  path: "/help",
  api: ({ method, pathname, body }) => {
    if (pathname === "/api/support/help-opened") {
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && pathname === "/api/support/diagnostics") {
      const bundle =
        scenario.bundles[Math.min(handedOut, scenario.bundles.length - 1)];
      handedOut += 1;
      return json({ id: `preview-${handedOut}`, diagnostics: bundle });
    }
    if (method === "POST" && pathname === "/api/support/feedback") {
      posts.push(body);
      if (scenario.expireFirstSend && !refusedOnce) {
        refusedOnce = true;
        return json(
          {
            error: "laf:diagnostics_expired",
            code: "laf:diagnostics_expired",
          },
          409,
        );
      }
      const sent = body as { diagnostics?: unknown };
      return json(
        {
          id: "feedback-1",
          receivedAt: "2026-09-14T09:00:00.000Z",
          told: ["support-webhook"],
          withDiagnostics: sent.diagnostics !== undefined,
        },
        201,
      );
    }
    return undefined;
  },
});

const body = document.body;
const dialog = () => body.querySelector('[role="dialog"]');
const buttonIn = (root: Element | null, name: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (button) => button.textContent?.trim() === name,
  );
const gatheredSoFar = () =>
  view.requests.filter(
    (request) => request.pathname === "/api/support/diagnostics",
  ).length;
const previewText = () => {
  const preview = body.querySelector('[data-testid="diagnostics-preview"]');
  if (!preview) return null;
  const copy = preview.cloneNode(true) as Element;
  copy.querySelector('[data-testid="diagnostics-exact"]')?.remove();
  return copy.textContent ?? "";
};

const ask = buttonIn(view.host, "문의·의견");
if (!ask) throw new Error("the 문의·의견 button is not on the help page");
await view.click(ask);
await view.waitFor(() => dialog() !== null, "the 문의·의견 dialog");
await view.settle(30);
const gatheredBeforeTick = gatheredSoFar();

const box = [...body.querySelectorAll("label")]
  .find((label) => label.textContent?.includes("진단 정보 같이 보내기"))
  ?.querySelector("input");
if (!box) throw new Error("the diagnostics box is not in the dialog");
await view.click(box);
await view.waitFor(() => previewText() !== null, "the diagnostics preview");

const preview = previewText() ?? "";
const exact =
  body.querySelector('[data-testid="diagnostics-exact"]')?.textContent ?? "";

const textarea = dialog()?.querySelector("textarea");
if (!textarea) throw new Error("the message box is not in the dialog");
await view.type(textarea, scenario.message);

const press = async () => {
  const sendButton = buttonIn(dialog(), "보내기");
  if (!sendButton) throw new Error("보내기 is not in the dialog");
  await view.waitFor(() => !sendButton.disabled, "보내기 to be pressable");
  await view.click(sendButton);
};

let refusal: string | null = null;
let previewAfterRefusal: string | null = null;
await press();
if (scenario.expireFirstSend) {
  await view.waitFor(
    () =>
      [...body.querySelectorAll('[role="alert"]')].some((alert) =>
        alert.textContent?.includes("진단 정보가 바뀌었어요"),
      ),
    "the expired refusal",
  );
  refusal =
    [...body.querySelectorAll('[role="alert"]')]
      .map((alert) => alert.textContent ?? "")
      .find((text) => text.includes("진단 정보가 바뀌었어요")) ?? null;
  await view.waitFor(
    () => gatheredSoFar() === 2 && previewText() !== null,
    "a new bundle to be gathered and shown",
  );
  previewAfterRefusal = previewText();
  await press();
}

await view.waitFor(
  () =>
    [...body.querySelectorAll('[role="status"]')].some((status) =>
      status.textContent?.includes("보냈어요"),
    ),
  "the receipt",
);
const receipt =
  [...body.querySelectorAll('[role="status"]')]
    .map((status) => status.textContent ?? "")
    .find((text) => text.includes("보냈어요")) ?? "";

const shown: FeedbackShown = {
  gatheredBeforeTick,
  preview,
  exact,
  gathered: gatheredSoFar(),
  posts,
  refusal,
  previewAfterRefusal,
  receipt,
};
await act(async () => {});
await view.unmount();
console.log(`FEEDBACK_RENDER ${JSON.stringify(shown)}`);
process.exit(0);
