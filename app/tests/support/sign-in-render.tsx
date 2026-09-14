/**
 * THE SIGN-IN SCREEN, RENDERED IN KOREAN, ONCE FOR EVERY WAY A SIGN-IN COMES BACK REFUSED.
 *
 * In a process of its own for the reason `korean-render.tsx` gives: the locale is decided when the
 * dictionary is first loaded, and in the shared `bun test` process some other file has always loaded
 * it in English first. Korean is chosen here before any app module is imported.
 *
 * Reads a JSON list of scenarios from the file named by its one argument and prints one line,
 * `SIGN_IN_RENDER <json>`, with what each scenario put on the screen. Not a test file (no `.test.`
 * in the name), so the runner never collects it on its own.
 *
 *     bun app/tests/support/sign-in-render.tsx /tmp/scenarios.json
 */
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { stubFetch } from "./fetch";

/** Open `path` and read what the screen says. */
type Arrival = { kind: "arrive"; path: string };
/** Open `path`, press a sign-in button, and answer the start with `status` and `body` — or throw. */
type Press = {
  kind: "press";
  path: string;
  status?: number;
  body?: unknown;
  throws?: boolean;
};
export type Scenario = Arrival | Press;
export type Shown = {
  /** The refusal line under the buttons, or null when there is none. */
  alert: string | null;
  /** What the press posted to the start route, when it posted anything. */
  started: Record<string, unknown> | null;
};

const scenarios = JSON.parse(
  readFileSync(process.argv[2] as string, "utf8"),
) as Scenario[];

// Development builds, as under `bun test` (see korean-render.tsx).
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

/*
 * THE AUTH CLIENT KEEPS THE `fetch` IT WAS BUILT WITH. better-auth's client config passes
 * `customFetchImpl: fetch`, read once, when `lib/auth/client.ts` is first evaluated — so a stub that
 * `mountApp` installs for the second screen would never reach it, and every press after the first
 * would be answered by the first screen's server. It is built here, over a `fetch` that asks
 * whichever stub is current at the time of the call.
 */
const current: typeof fetch = stubFetch(async (input, init) =>
  globalThis.fetch === current
    ? new Response("{}", { status: 404 })
    : globalThis.fetch(input, init),
);
globalThis.fetch = current;
await import("../../src/lib/auth/client");

const { json, mountApp } = await import("./app-router");

const shown: Shown[] = [];
for (const scenario of scenarios) {
  let started: Record<string, unknown> | null = null;
  const view = await mountApp({
    path: scenario.path,
    api: ({ method, pathname, body }) => {
      // Nobody is signed in: that is the only way this screen is drawn at all.
      if (pathname === "/api/me") return json({ error: "unauthorized" }, 401);
      if (pathname === "/api/auth/providers") {
        return json({ providers: ["laf"] });
      }
      if (
        method === "POST" &&
        (pathname === "/api/auth/sign-in/oauth2" ||
          pathname === "/api/auth/sign-in/social")
      ) {
        started = body as Record<string, unknown>;
        if (scenario.kind !== "press") return json({}, 500);
        if (scenario.throws) throw new TypeError("Failed to fetch");
        return new Response(
          scenario.body === undefined ? "" : JSON.stringify(scenario.body),
          {
            status: scenario.status ?? 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return undefined;
    },
  });
  const alertText = () =>
    view.host.querySelector('[role="alert"]')?.textContent ?? null;

  if (scenario.kind === "press") {
    await view.waitFor(
      () => view.buttonNamed("카카오로 계속하기") !== undefined,
      "the Kakao button",
    );
    await view.click(view.buttonNamed("카카오로 계속하기") as Element);
    await view.waitFor(
      () => alertText() !== null,
      `a refusal for ${JSON.stringify(scenario)}`,
    );
  }
  shown.push({ alert: alertText(), started });
  await view.unmount();
}

console.log(`SIGN_IN_RENDER ${JSON.stringify(shown)}`);
process.exit(0);
