/**
 * THE APP, RENDERED IN KOREAN, IN A PROCESS OF ITS OWN.
 *
 * `activeLocale` is decided once, when `lib/i18n.ts` is first evaluated, and `bun test` runs every
 * file in one process with one module cache — so by the time any test asks for Korean, some other
 * file has already loaded the dictionary in English, and no test in that process can ever see a
 * particle chosen. This script chooses Korean before anything imports the dictionary, renders what
 * a person with Bots named `names` would be shown, and prints it as one JSON line for
 * `korean-names.test.ts` to read.
 *
 * Not a test file (no `.test.` in the name), so the runner never collects it on its own.
 *
 *     bun app/tests/support/korean-render.tsx '["닻","나비"]'
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AskSubject } from "../../src/lib/approvals";

const names = JSON.parse(process.argv[2] ?? "[]") as string[];
/*
 * Development builds, as under `bun test`: TanStack Router's provider and its matches disagree about
 * the render acknowledgement outside them, and a notice nobody can mount raises nothing.
 */
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

// The window is behind other apps: the one state a notice that a Bot needs somebody is raised in.
Object.defineProperty(document, "visibilityState", {
  value: "hidden",
  configurable: true,
});

/** The browser's notification centre, as far as a notice's title goes. */
const titles: string[] = [];
class RecordingNotification {
  static permission = "granted";
  onclick: (() => void) | null = null;
  constructor(title: string) {
    titles.push(title);
  }
  close() {}
}
(globalThis as unknown as { Notification: unknown }).Notification =
  RecordingNotification;
(window as unknown as { Notification: unknown }).Notification =
  RecordingNotification;

const bots = names.map((name, index) => ({ id: `bot-${index}`, name }));

/** What every question here is about: opening one page, asked by a rule. */
const OPENING_A_PAGE: AskSubject = {
  kind: "browser",
  intent: "navigate",
  host: "example.com",
  reason: "policy_ask",
};

const { agentFixture, json, mountApp } = await import("./app-router");
const { stubFetch } = await import("./fetch");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createElement } = await import("react");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
  await import("@tanstack/react-router");

const roster = bots.map((bot) => agentFixture({ id: bot.id, name: bot.name }));
const realFetch = globalThis.fetch;
const settle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

// --- the notices -------------------------------------------------------------------------------

let outboxReads = 0;
globalThis.fetch = stubFetch(async (input) => {
  const url = new URL(String(input), "http://localhost:3110/");
  if (url.pathname === "/api/agents") return json({ agents: roster });
  if (url.pathname === "/api/channels") return json({ channels: [] });
  if (url.pathname === "/api/me/notifications") {
    outboxReads += 1;
    // The mount's read seeds the watermark and raises nothing; the read a frame causes finds these.
    return json({
      notifications:
        outboxReads === 1
          ? []
          : bots.map((bot, index) => ({
              id: `n-${index}`,
              kind: "run.needs_you",
              botId: bot.id,
              createdAt: new Date(
                Date.UTC(2026, 8, 13, 0, 0, index),
              ).toISOString(),
            })),
    });
  }
  // The other half of what the mount reads: no question was open when the page opened. Without an
  // answer here the page is never told what was already waiting, and says only the frame.
  if (url.pathname.startsWith("/api/approvals/")) {
    return json({ approvals: [] });
  }
  return json({ error: "laf:not_stubbed" }, 404);
});

const { useBotNotifications } = await import(
  "../../src/lib/notifications/use-bot-notifications"
);
const { NOTIFICATION_FRAME, notificationFrames } = await import(
  "../../src/lib/notifications/outbox"
);
const Listening = () => {
  useBotNotifications();
  return null;
};
const router = createRouter({
  routeTree: createRootRoute({ component: Listening }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
await act(async () => {
  root.render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(RouterProvider, { router }),
    ),
  );
});
await settle(100);
await act(async () => {
  notificationFrames.dispatchEvent(
    new CustomEvent(NOTIFICATION_FRAME, {
      detail: {
        kind: "notification",
        id: "n-frame",
        event: "run.needs_you",
        botId: bots[0]?.id ?? "",
        at: "2026-09-13T00:00:00.000Z",
      },
    }),
  );
});
await settle(200);
await act(async () => {
  root.unmount();
});
host.remove();
// Taken now: the approval page below opens a question, and the shell's own listener announces it.
const notices = [...titles];

// --- the page a notice lands on ----------------------------------------------------------------

globalThis.fetch = realFetch;
const headings: string[] = [];
for (const [index, bot] of bots.entries()) {
  const approvalId = `ap-${index}`;
  const view = await mountApp({
    path: `/approve/${approvalId}`,
    api: ({ pathname }) => {
      if (pathname === "/api/agents") return json({ agents: [roster[index]] });
      if (pathname === `/api/approvals/${bot.id}`) {
        return json({
          approvals: [
            {
              id: approvalId,
              botId: bot.id,
              rule: "browser.host == 'example.com'",
              subject: OPENING_A_PAGE,
              requestedAt: "2026-09-13T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      return undefined;
    },
  });
  await view.waitFor(
    () => (view.host.querySelector("h1")?.textContent ?? "").includes(bot.name),
    `the heading for ${bot.name}`,
  );
  headings.push(view.host.querySelector("h1")?.textContent ?? "");
  await view.unmount();
}

/*
 * (The roster's times were read here until 2026-10-10: three Bots' rows, each with when it last
 * spoke, written the Korean way. The rows went with the column that drew them — an account with
 * several Bots reaches each from the menu now, by name — and nothing draws that time any more.)
 */
console.log(`KOREAN_RENDER ${JSON.stringify({ notices, headings })}`);
process.exit(0);
