import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { stubFetch } from "./support/fetch";
import { mount, unmountAll } from "./support/mount";

/**
 * AN ENDED CARD ASKS FOR ITS PICTURE ONLY WHEN THERE IS ONE.
 *
 * Every ended card asked `/api/channels/:id/frames/:call`, and each task that never kept a picture —
 * from before pictures, or ended with a person at the wheel — answered 404 in the console (0.5.4
 * QA). The conversation's list of framed calls is read once; a card not on it draws its quiet mark
 * and asks nothing.
 */

const realFetch = globalThis.fetch;
const asked: string[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3113/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = stubFetch(async (input) => {
    const url = new URL(String(input), "http://localhost:3113/");
    asked.push(url.pathname);
    if (url.pathname === "/api/channels/ch-1/frames") {
      return new Response(JSON.stringify({ toolCallIds: ["call-kept"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 401 });
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

afterEach(unmountAll);

const task = (id: string) => ({
  kind: "browse" as const,
  id,
  steps: [
    {
      id,
      name: "computer_navigate",
      args: JSON.stringify({ url: "https://www.naver.com" }),
      result: JSON.stringify({ ok: true, url: "https://www.naver.com/" }),
    },
  ],
  notes: [],
});

describe("an ended browsing card's picture", () => {
  test("is drawn where the conversation kept one, and not asked for where it did not", async () => {
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { BrowsingCard } = await import(
      "../src/components/computer/browsing-card"
    );
    const view = await mount(
      <QueryClientProvider client={new QueryClient()}>
        <BrowsingCard
          channelId="ch-1"
          isNewest={false}
          isOpen={false}
          item={task("call-kept")}
        />
        <BrowsingCard
          channelId="ch-1"
          isNewest={false}
          isOpen={false}
          item={task("call-without")}
        />
      </QueryClientProvider>,
    );
    await view.settle(50);

    const pictures = [...view.host.querySelectorAll("img")].map(
      (image) => image.getAttribute("src") ?? "",
    );
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toContain("/api/channels/ch-1/frames/call-kept");
    // One read of the list for both cards, and no request for the picture that does not exist.
    expect(
      asked.filter((path) => path === "/api/channels/ch-1/frames"),
    ).toEqual(["/api/channels/ch-1/frames"]);
    expect(asked.some((path) => path.endsWith("/frames/call-without"))).toBe(
      false,
    );
  });
});
