import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mount, unmountAll } from "./support/mount";

/**
 * WHAT A PERSON ANSWERED IS IN THE CARD'S 한 일, BESIDE THE STEP IT WAS ABOUT.
 *
 * Package C's approval card folds into one line once answered (UI/UX audit 0.5.3, item 3), and
 * package A made a turn's browsing one card (item 1). The line was only above the card, a stack of
 * them for a turn with several questions; reading 한 일 back, the click that was refused did not say
 * so. It does now, in the approvals' own words.
 */

const realFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // The approval card asks who is signed in; nobody is, and there is no server to ask.
  globalThis.fetch = Object.assign(
    async () => new Response("{}", { status: 401 }),
    { preconnect: () => {} },
  ) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

afterEach(unmountAll);

describe("a browsing card's 한 일", () => {
  test("carries the answer to a step's question, under that step", async () => {
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { BrowsingCard } = await import(
      "../src/components/computer/browsing-card"
    );
    const { decideQuestion } = await import("../src/lib/approvals");
    decideQuestion("call-press", {
      outcome: "declined",
      subject: {
        kind: "browser",
        intent: "activate",
        host: "toss.im",
        element: { role: "button", name: "비즈니스" },
        reason: "guard_floor",
      },
    });

    const view = await mount(
      <QueryClientProvider client={new QueryClient()}>
        <BrowsingCard
          channelId={undefined}
          isNewest={false}
          isOpen={false}
          item={{
            kind: "browse",
            id: "call-open",
            steps: [
              {
                id: "call-open",
                name: "computer_navigate",
                args: JSON.stringify({ url: "https://toss.im" }),
                result: JSON.stringify({ ok: true, url: "https://toss.im/" }),
              },
              {
                id: "call-press",
                name: "computer_click",
                args: JSON.stringify({ ref: "e4" }),
                result: JSON.stringify({
                  ok: false,
                  refused: true,
                  code: "laf:person_declined",
                }),
              },
            ],
            notes: [],
          }}
        />
      </QueryClientProvider>,
    );
    await view.settle(30);
    const toggle = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "What it did",
    );
    if (!toggle) throw new Error("no 한 일 button");
    await view.press(toggle);

    const list = view.host.querySelector(
      `#${CSS.escape(toggle.getAttribute("aria-controls") ?? "")}`,
    );
    const lines = [...(list?.children ?? [])].map(
      (line) => line.textContent ?? "",
    );
    const said = lines.findIndex((line) => line.startsWith("Denied · "));
    expect(said).toBeGreaterThan(-1);
    expect(lines[said]).toContain("toss.im");
    // Right after the click it was about, not somewhere else in the list.
    expect(lines[said - 1]).toContain("Clicked");
  });
});
