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
 * one turn late. The conversation now holds every hand-over until `useToolsSettled` says yes.
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

describe("the conversation waits for it", () => {
  test("every way a turn goes out passes the gate", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        import.meta.dir,
        "../src/components/channels/server-channel-chat.tsx",
      ),
      "utf8",
    );
    // What the turn is told this window offers is read only once the grants are in, or the
    // backstop has run out.
    const declaredTools = source.slice(source.indexOf("const declaredTools"));
    expect(declaredTools.slice(0, 400)).toContain("!settled.current");
    // A send, a retry and a send of what was kept all hand over through one function, which asks
    // for the tools before it sends — and nothing else in the file reaches the door.
    expect(source.match(/await declaredTools\(\)/g)?.length).toBe(1);
    expect(source.match(/\bsendTurn\(/g)?.length).toBe(1);
    const handOver = source.slice(source.indexOf("const handOver"));
    expect(handOver.indexOf("await declaredTools()")).toBeLessThan(
      handOver.indexOf("sendTurn("),
    );
  });
});

/*
 * THE SAME ORDER OF THINGS, SEEN FROM A CARD. A conversation names its Bot in an effect, and what
 * is drawn beneath it has run its own effects by then. `ActivityReportCard` read the Bot it is
 * drawn for from `useActiveBotId`, which answers the sentinel `default` until one is named, and
 * asked for it. Measured 2026-10-05 with this render, before the card read the declared Bot: two
 * requests, the first with `agentId: "default"` — which the server answers 404 `laf:bot_not_found`
 * — and the second for the real one. Pull request 78 fixed it and kept no test; this is that render.
 */
describe("a card drawn as the conversation mounts", () => {
  test("reads for the Bot the conversation names, and for nobody before it has named one", async () => {
    const asked: { url: string; agentId: unknown }[] = [];
    globalThis.fetch = stubFetch(async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        agentId?: unknown;
      };
      asked.push({ url: String(input), agentId: body.agentId });
      return json({ allowed: true, data: { days: 7, rows: [] } });
    });
    const { ActiveBotProvider, useActiveBot } = await import(
      "../src/lib/copilot/active-bot"
    );
    const { ActivityReportCard } = await import(
      "../src/components/gallery/activity"
    );
    function Conversation() {
      useActiveBot("bot-1");
      return <ActivityReportCard report="activity" />;
    }
    const view = await mount(
      <ActiveBotProvider>
        <Conversation />
      </ActiveBotProvider>,
    );
    await view.settle(60);
    expect(asked).toEqual([
      { url: "/api/components/showActivityReport/call", agentId: "bot-1" },
    ]);
    // And it drew what it read, rather than standing at "Reading…".
    expect(view.host.textContent).toContain(
      "No Bot has done anything in the last 7 days.",
    );
  });
});
