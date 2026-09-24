import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { ReactElement } from "react";
import type { ScreenErrorReport } from "../../shared/screen-errors";
import type { BrowsingStep } from "../src/lib/computer/browsing";
import { mount, unmountAll } from "./support/mount";

/**
 * A BROWSING CARD THAT THROWS TAKES ITSELF, NOT THE CONVERSATION.
 *
 * The card and the banner arrived (2026-09-24) after the seams were laid, inside the transcript's
 * seam with none of their own, so one card that threw on what a browser call came back with took
 * every message above and below it. Each card now fails alone, as the Bot's screen, and is
 * reported as that — and the card beside it goes on drawing.
 */

const PASSWORD = "hunter2-canary";

let consoleError: ReturnType<typeof spyOn> | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(async () => {
  await unmountAll();
  consoleError?.mockRestore();
  consoleError = undefined;
  const { configureScreenErrorReports } = await import(
    "../src/lib/support/screen-errors"
  );
  configureScreenErrorReports(null);
});

const step = (id: string, url: string): BrowsingStep => ({
  id,
  name: "computer_navigate",
  args: JSON.stringify({ url }),
  result: JSON.stringify({ ok: true, url }),
});

/** A step whose name cannot be read: what a card is handed when a call's shape is not the one it knows. */
const brokenStep = (id: string): BrowsingStep =>
  Object.defineProperty({ id, args: "{}" }, "name", {
    enumerable: true,
    get() {
      throw new TypeError(`step ${id} is not a step: ${PASSWORD}`);
    },
  }) as BrowsingStep;

async function drawn(element: ReactElement) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = await mount(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
  await view.settle(30);
  return view;
}

describe("a browsing card", () => {
  test("that throws is replaced by the section's line, and the card beside it still draws", async () => {
    consoleError = spyOn(console, "error").mockImplementation(() => {});
    const { BrowsingCard } = await import(
      "../src/components/computer/browsing-card"
    );
    const { configureScreenErrorReports } = await import(
      "../src/lib/support/screen-errors"
    );
    const reports: ScreenErrorReport[] = [];
    configureScreenErrorReports({
      route: () => "/channel/$channelId",
      build: async () => null,
      surface: () => "shell",
      isSignedIn: () => true,
      send: async (report) => {
        reports.push(report);
      },
    });

    const view = await drawn(
      <div>
        <BrowsingCard
          channelId={undefined}
          isNewest={false}
          isOpen={false}
          item={{
            kind: "browse",
            id: "task-fine",
            steps: [step("call-1", "https://weather.naver.com/")],
          }}
        />
        <BrowsingCard
          channelId={undefined}
          isNewest={true}
          isOpen={false}
          item={{
            kind: "browse",
            id: "task-broken",
            steps: [brokenStep("call-2")],
          }}
        />
      </div>,
    );

    const failed = view.host.querySelectorAll(
      '[data-failed-section="computer"]',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.querySelector('[role="alert"]')?.textContent).toBe(
      "This part of the screen ran into an unexpected problem.",
    );
    // The card beside it is still there, site and all.
    expect(view.host.textContent).toContain("weather.naver.com");
    expect(view.host.textContent).not.toContain(PASSWORD);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      section: "computer",
      route: "/channel/$channelId",
      kind: "TypeError",
    });
    expect(JSON.stringify(reports)).not.toContain(PASSWORD);
  });
});
