/**
 * THE APPROVAL CARDS, RENDERED IN KOREAN, WITH THE SEND THEY ARE ABOUT ON THEM.
 *
 * In a process of its own for the reason `korean-render.tsx` gives: `activeLocale` is decided once,
 * when the dictionary is first loaded, and in the shared `bun test` process that has already
 * happened in English. This chooses Korean first, renders the page a notice opens (`/approve/:id`,
 * which draws the line-level card) and a room's cards, and prints what a person would read as one
 * JSON line for `approval-preview.test.ts`.
 *
 * Not a test file (no `.test.` in the name), so the runner never collects it on its own.
 *
 *     bun app/tests/support/preview-render.tsx
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AskSubject } from "../../src/lib/approvals";

// Development builds, as under `bun test`; see `korean-render.tsx`.
process.env.NODE_ENV = "test";

GlobalRegistrator.register({ url: "http://localhost:3110/" });
// Chosen before a single app module is imported: this is what `storedLocale()` reads.
window.localStorage.setItem("laf.locale", "ko");
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A socket that never connects. The shell opens one and would reach for a real server. */
class NoSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NoSocket;
(window as unknown as { WebSocket: unknown }).WebSocket = NoSocket;

const toolSubject = (server: string, name: string): AskSubject => ({
  kind: "tool",
  intent: "call_tool",
  tool: { server, name, guard: "external" },
  reason: "guard_floor",
});

/** What a person reads on one card: the question, and the preview under it as label/value pairs. */
type Card = { question: string; lines: [string, string][] };

/** Every card in `root` that carries a preview, read the way a person reads it. */
function cardsIn(root: ParentNode): Card[] {
  return [...root.querySelectorAll("dl[aria-label]")].map((list) => ({
    // The preview sits directly under the sentence it belongs to, on both cards.
    question: list.previousElementSibling?.textContent ?? "",
    lines: [...list.querySelectorAll("dt")].map((term): [string, string] => [
      term.textContent ?? "",
      term.nextElementSibling?.textContent ?? "",
    ]),
  }));
}

const { agentFixture, json, mountApp } = await import("./app-router");

// --- the page a notice lands on, which draws the line-level card ---------------------------------

const everybody = Array.from({ length: 12 }, (_, at) => `guest${at}@shop.kr`);
const page = await mountApp({
  path: "/approve/ap-mail",
  api: ({ pathname }) => {
    if (pathname === "/api/agents") {
      return json({ agents: [agentFixture({ id: "bot-1", name: "초롱" })] });
    }
    if (pathname === "/api/approvals/bot-1") {
      return json({
        approvals: [
          {
            id: "ap-mail",
            botId: "bot-1",
            rule: "laf:external",
            subject: toolSubject("gmail", "send_message"),
            preview: [
              {
                field: "recipients",
                values: everybody.slice(0, 10),
                total: everybody.length,
              },
              { field: "subject", values: ["9월 정산 안내"] },
              {
                field: "text",
                values: ["안녕하세요.\n9월 정산서를 보내 드려요."],
                cut: true,
              },
            ],
            scope: { kind: "tool", value: "gmail/send_message" },
            requestedAt: "2026-09-16T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        ],
      });
    }
    return undefined;
  },
});
await page.waitFor(
  () => page.host.querySelector("dl[aria-label]") !== null,
  "the preview on the approval page",
);
const pageCards = cardsIn(page.host);
await page.unmount();

console.log(`PREVIEW_RENDER ${JSON.stringify({ page: pageCards })}`);
process.exit(0);
