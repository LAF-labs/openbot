import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { stubFetch } from "./support/fetch";
import { json, mount, routerAt, unmountAll } from "./support/mount";

/**
 * 오늘's "기억함 · …" row lands on that line of 수첩: the line is reached by the id the row goes to
 * (`memoryLineId`), shown once it is drawn, marked a moment and handed the keyboard
 * (`revealWhenDrawn`). A line forgotten since the day was read has no element, and nothing is
 * marked — the page opens as it always does, with no error and no dead highlight.
 *
 * Mounted, because the reveal waits for the list: pressed from 홈 the page's lines are still
 * arriving when the navigation resolves (measured from 오늘 for a routine's card, `lib/channels/jump.ts`).
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3111/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});

const LINE = {
  id: "m-1",
  content: "월요일은 쉰다",
  source: "bot",
  confirmed: false,
  slot: null,
  carried: true,
  createdAt: "2026-09-25T02:00:00.000Z",
};

async function notebook() {
  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    if (url === "/api/agents/bot-1/memories") {
      return json({ memories: [LINE], used: 10, cap: 2200, guidance: [] });
    }
    if (url === "/api/me") {
      return json({ user: { id: "u1", email: "kim@example.com", name: "김" } });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { RouterProvider } = await import("@tanstack/react-router");
  const { Notebook } = await import("../src/components/notebook/notebook");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = await routerAt("/notebook", ["/notebook"], () => (
    <QueryClientProvider client={client}>
      <Notebook agentId="bot-1" />
    </QueryClientProvider>
  ));
  return mount(<RouterProvider router={router} />);
}

describe("오늘's remembered row lands on its line", () => {
  test("the line is reached by its id once drawn, marked a moment, and given the keyboard", async () => {
    const { memoryLineId } = await import(
      "../src/components/notebook/notebook"
    );
    const { revealWhenDrawn } = await import("../src/lib/channels/jump");
    // Asked for before the page has its lines, as a press from 홈 does.
    revealWhenDrawn(memoryLineId("m-1"));
    const view = await notebook();
    await view.settle(60);
    const line = view.host.querySelector(`#${memoryLineId("m-1")}`);
    expect(line?.tagName).toBe("LI");
    expect(line?.textContent).toContain("월요일은 쉰다");
    expect(line?.getAttribute("data-jumped")).toBe("true");
    expect(document.activeElement).toBe(line);
  });

  test("a line forgotten since marks nothing and takes nothing", async () => {
    const { memoryLineId } = await import(
      "../src/components/notebook/notebook"
    );
    const { revealWhenDrawn } = await import("../src/lib/channels/jump");
    revealWhenDrawn(memoryLineId("m-gone"), 40);
    const view = await notebook();
    await view.settle(80);
    expect(view.host.querySelector("[data-jumped]")).toBeNull();
    expect(document.activeElement?.tagName).not.toBe("LI");
  });
});
