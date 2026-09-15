/**
 * THE SIGN-IN SCREEN OPENED THE WAY THE FRONT DOOR OPENS IT: `/sign?via=<provider>`.
 *
 * In a process of its own, for the reason `sign-in-render.tsx` gives: the auth client keeps the
 * `fetch` it was first built with, so it is built here over a `fetch` that asks whichever stub is
 * current. And because every scenario must share ONE tab — "once per tab" is the property, and
 * `sessionStorage` is the tab — they run in order in one window.
 *
 * Prints one line, `SIGN_VIA_RENDER <json>`: how many sign-ins each opening started, and what the
 * first one asked the broker for. Not a test file, so the runner never collects it on its own.
 *
 *     bun app/tests/support/sign-via-render.tsx
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { stubFetch } from "./fetch";

export type ViaOpening = {
  path: string;
  /** Whether the tab's memory was wiped first, as a new tab's is. */
  freshTab: boolean;
};
export type ViaShown = {
  path: string;
  /** Sign-ins this opening started. */
  started: number;
  /** What the start asked for, when it asked. */
  body: Record<string, unknown> | null;
};

export const OPENINGS: ViaOpening[] = [
  { path: "/sign?via=google", freshTab: true },
  // The same tab, arriving again the same way — the refused start sent it back here.
  { path: "/sign?via=google", freshTab: false },
  { path: "/sign?via=kakao&error=access_denied", freshTab: true },
  { path: "/sign?via=github", freshTab: true },
  { path: "/sign", freshTab: true },
];

if (import.meta.main) {
  process.env.NODE_ENV = "test";
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
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

  const current: typeof fetch = stubFetch(async (input, init) =>
    globalThis.fetch === current
      ? new Response("{}", { status: 404 })
      : globalThis.fetch(input, init),
  );
  globalThis.fetch = current;
  await import("../../src/lib/auth/client");

  const { json, mountApp } = await import("./app-router");

  const shown: ViaShown[] = [];
  for (const opening of OPENINGS) {
    if (opening.freshTab) window.sessionStorage.clear();
    const starts: Record<string, unknown>[] = [];
    const view = await mountApp({
      path: opening.path,
      api: ({ method, pathname, body }) => {
        if (pathname === "/api/me") return json({ error: "unauthorized" }, 401);
        if (pathname === "/api/auth/providers") {
          return json({ providers: ["laf"] });
        }
        if (
          method === "POST" &&
          (pathname === "/api/auth/sign-in/oauth2" ||
            pathname === "/api/auth/sign-in/social")
        ) {
          starts.push(body as Record<string, unknown>);
          // Refused, so the screen stays where it is and a second start would have to come from it.
          return json({ code: "internal_server_error" }, 500);
        }
        return undefined;
      },
    });
    // Long enough for an effect's start to have gone out and come back refused.
    await view.settle(400);
    shown.push({
      path: opening.path,
      started: starts.length,
      body: starts[0] ?? null,
    });
    await view.unmount();
  }

  console.log(`SIGN_VIA_RENDER ${JSON.stringify(shown)}`);
  process.exit(0);
}
