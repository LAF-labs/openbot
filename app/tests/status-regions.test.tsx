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
 * A STATUS LINE IS THERE BEFORE IT SPEAKS (docs/laf/dialogs.md, `LiveRegion`).
 *
 * A screen reader announces a change inside a live region it already knows. Each line here used to
 * be drawn only once it had something to say, so it arrived together with its region and was not
 * read out. What is pinned is the promise itself: the same element, present and silent before,
 * holds the words after.
 */

let realFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  realFetch = globalThis.fetch;
  // The help card watches the computer's wheel; nobody holds it here.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ holder: "bot" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

afterEach(unmountAll);

const statusRegions = (host: Element) => [
  ...host.querySelectorAll('[role="status"][aria-live="polite"]'),
];

describe("the Bot asking for help", () => {
  test("is heard when the Bot starts waiting, from a region that was there before", async () => {
    const { HelpCard } = await import("../src/components/computer/help-card");
    const card = (status: "inProgress" | "executing") => (
      <HelpCard
        botId="agent-1"
        kind="help"
        result={undefined}
        said="로그인 화면에서 막혔어요"
        status={status}
        toolCallId="call-1"
      />
    );
    const view = await mount(card("inProgress"));
    await view.settle(30);
    const before = statusRegions(view.host);
    expect(before.length).toBeGreaterThan(0);
    expect(before.map((region) => region.textContent)).toEqual(
      before.map(() => ""),
    );

    await view.render(card("executing"));
    await view.settle(30);
    const heard = before.find((region) =>
      region.textContent?.includes("The Bot needs your help"),
    );
    // The same element as before, not a new one drawn with its words.
    expect(heard?.isConnected).toBe(true);
    expect(heard?.textContent).toBe(
      "The Bot needs your help: 로그인 화면에서 막혔어요",
    );
  });
});

describe("the way back from a consent screen", () => {
  test("says what was connected from a region mounted before the outcome was read", async () => {
    const { ConnectOutcome } = await import(
      "../src/components/plugins/connections"
    );
    let cleared = 0;
    const outcome = (connected: string | undefined) => (
      <ConnectOutcome
        connected={connected}
        onClear={() => {
          cleared += 1;
        }}
        titleFor={(id) => (id === "notion" ? "Notion" : id)}
      />
    );
    const view = await mount(outcome(undefined));
    await view.settle(30);
    const [region] = statusRegions(view.host);
    expect(region?.textContent).toBe("");

    await view.render(outcome("notion"));
    await view.settle(30);
    expect(cleared).toBe(1);
    expect(region?.isConnected).toBe(true);
    expect(region?.textContent).toBe("Connected to Notion.");
  });
});
