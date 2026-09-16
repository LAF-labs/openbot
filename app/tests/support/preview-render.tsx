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
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");

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
                values: ["안녕하세요.\n9월 정산서를 보내 드립니다."],
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

// --- a room's cards ----------------------------------------------------------------------------

const { RoomApprovals } = await import(
  "../../src/components/channels/room-approvals"
);
// The room card reads whether its Bot may be driven through a query, so it needs a client of its
// own here, the same way `korean-render.tsx` mounts it.
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const roomHost = document.createElement("div");
document.body.append(roomHost);
const roomRoot = createRoot(roomHost);
const member = { memberId: "bot-1", memberName: "초롱", expiresAt: "" };
await act(async () => {
  roomRoot.render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(RoomApprovals, {
        approvals: [
          {
            ...member,
            approvalId: "room-alimtalk",
            rule: "laf:external",
            subject: toolSubject("kakao-alimtalk", "alimtalk_send"),
            preview: [
              { field: "recipients", values: ["01011112222"] },
              { field: "template", values: ["laf_reservation"] },
              {
                field: "text",
                values: ["[미소상회]\n예약이 확정되었습니다."],
              },
            ],
          },
          {
            ...member,
            approvalId: "room-event",
            rule: "laf:external",
            subject: toolSubject("google-calendar", "create_event"),
            preview: [
              { field: "title", values: ["상견례"] },
              { field: "starts", values: ["2026-09-20T12:00:00+09:00"] },
              { field: "attendees", values: ["stranger@evil.example"] },
            ],
          },
          {
            ...member,
            approvalId: "room-order",
            rule: "laf:external",
            subject: toolSubject("cafe24", "update_order_status"),
            preview: [
              { field: "order", values: ["20260916-0000012"] },
              { field: "status", values: ["N30"] },
            ],
          },
          {
            ...member,
            approvalId: "room-reply",
            rule: "laf:external",
            subject: toolSubject("google-business-profile", "reply_to_review"),
            preview: [
              {
                field: "review",
                values: ["accounts/1/locations/2/reviews/abc"],
              },
              { field: "text", values: ["방문해 주셔서 감사합니다!"] },
            ],
          },
        ],
        onAnswered: () => {},
      }),
    ),
  );
});
const roomCards = cardsIn(roomHost);
await act(async () => {
  roomRoot.unmount();
});
roomHost.remove();

console.log(
  `PREVIEW_RENDER ${JSON.stringify({ page: pageCards, room: roomCards })}`,
);
process.exit(0);
