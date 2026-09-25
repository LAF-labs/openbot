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
import { json, mount, unmountAll } from "./support/mount";

/**
 * A turn waits until the Bot's tools are decided, so every turn of a conversation offers the same
 * ones.
 *
 * MEASURED 2026-09-25, request bodies through a logging proxy: the first message sent from the
 * compose screen carried 18 surface tools and the next 31. The conversation had just opened, its
 * Bot's card grants were still on their way, and the cards were offered only once they arrived —
 * one turn late. `ChannelChat` now holds every turn until `useToolsSettled` says yes.
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

/** A server whose grant answers are released by hand, to see the moment in between. */
function heldServer() {
  const waiting: Array<() => void> = [];
  const asked: string[] = [];
  globalThis.fetch = stubFetch(async (input) => {
    const url = String(input);
    asked.push(url);
    await new Promise<void>((resolve) => waiting.push(resolve));
    if (url === "/api/components/for-agent/bot-1") {
      return json({
        components: [{ name: "showBarChart", description: "막대" }],
      });
    }
    if (url === "/api/sandboxed/published") return json({ components: [] });
    if (url.includes("bot-1")) return json({ tools: [], skills: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  return {
    asked,
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

async function probe(options: { declare: boolean }) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ActiveBotProvider, useActiveBot } = await import(
    "../src/lib/copilot/active-bot"
  );
  const { useToolsSettled } = await import("../src/lib/copilot/tools-settled");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const seen: boolean[] = [];
  function Conversation() {
    useActiveBot(options.declare ? "bot-1" : undefined);
    seen.push(useToolsSettled("bot-1"));
    return null;
  }
  const view = await mount(
    <QueryClientProvider client={client}>
      <ActiveBotProvider>
        <Conversation />
      </ActiveBotProvider>
    </QueryClientProvider>,
  );
  return { view, seen };
}

describe("useToolsSettled", () => {
  test("not while the Bot's grants are on their way; yes once all three have answered", async () => {
    const server = heldServer();
    const { view, seen } = await probe({ declare: true });
    await view.settle(30);
    expect(seen.at(-1)).toBe(false);
    expect(server.asked).toContain("/api/components/for-agent/bot-1");
    expect(server.asked).toContain("/api/sandboxed/published");

    server.release();
    await view.settle(60);
    expect(seen.at(-1)).toBe(true);
  });

  test("not until the conversation has named its Bot, which is what the tools read", async () => {
    const server = heldServer();
    const { view, seen } = await probe({ declare: false });
    server.release();
    await view.settle(60);
    server.release();
    await view.settle(60);
    expect(seen.at(-1)).toBe(false);
  });

  test("a grant that failed has decided too: a turn is not held by a broken endpoint", async () => {
    globalThis.fetch = stubFetch(async () => json({ error: "down" }, 500));
    const { view, seen } = await probe({ declare: true });
    await view.settle(80);
    expect(seen.at(-1)).toBe(true);
  });
});

describe("ChannelChat waits for it", () => {
  test("every way a turn goes out passes the gate", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dir, "../src/components/channels/channel-chat.tsx"),
      "utf8",
    );
    const untilReady = source.slice(source.indexOf("const untilReady"));
    expect(untilReady.slice(0, 400)).toContain("toolsGatePromise");
    // `deliver`, `retry` and `resend` are every turn this screen sends, and each waits here first.
    expect(source.match(/await untilReady\(\);/g)?.length).toBe(3);
  });
});
