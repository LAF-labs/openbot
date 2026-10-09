import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { OverviewSite } from "../src/lib/connections/queries";
import { ko } from "../src/lib/i18n-ko";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * 사이트 연결 WITH NOBODY AT THE WHEEL (owner, 2026-10-09).
 *
 * A site was connected by putting the Bot's browser in front of the person to log in on. Nobody
 * drives the Bot's browser now, and the way back is the password card, which has not landed. Until
 * it does, a row that is not connected draws NO switch — one that could only fail would be a control
 * that does nothing (CLAUDE.md) — and says when it comes back; a row already connected keeps its
 * switch, which only turns it off, and asks first.
 *
 * Rendered rather than read: the source-walking tests in `connections-screen.test.ts` cannot say
 * how many switches a person sees, or what a press sends.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://app.test/" });
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

const COMING_BACK = "Connecting comes back soon, through the password card.";
const CERTIFICATE =
  "The Bot cannot sign in here: it needs a certificate on your device.";

const site = (
  id: string,
  status: OverviewSite["status"] = "not_connected",
): OverviewSite => ({
  id,
  status,
  botId: status === "not_connected" ? null : "bot-1",
  lastSeenAt: status === "not_connected" ? null : "2026-10-08T09:00:00Z",
  connectedAt: status === "not_connected" ? null : "2026-10-01T09:00:00Z",
});

async function rows(sites: OverviewSite[]) {
  const asked: string[] = [];
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = new URL(String(input), "http://app.test");
    asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/me") return json({ error: "nobody" }, 401);
    return json({ forgotten: true });
  });
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createElement } = await import("react");
  const { SiteRows } = await import("../src/components/connections/site-rows");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = await mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(SiteRows, {
        sites,
        bots: [{ id: "bot-1", name: "수달" }],
        only: sites.map((one) => one.id),
      }),
    ),
  );
  await view.settle();
  const row = (name: string) =>
    [...view.host.querySelectorAll("[data-slot='item']")].find((item) =>
      item.textContent?.includes(name),
    ) as HTMLElement | undefined;
  return { view, asked, row };
}

describe("the site rows, until the password card lands", () => {
  test("a site not connected draws no switch, and says when connecting comes back", async () => {
    const { view, row } = await rows([
      site("naver-smartstore"),
      site("baemin-ceo", "connected"),
    ]);
    const waiting = row("Naver Smart Store Seller Centre");
    expect(waiting?.textContent).toContain(COMING_BACK);
    expect(waiting?.querySelector("[role='switch']")).toBeNull();
    // The one connected row keeps its switch, on.
    const switches = view.host.querySelectorAll("[role='switch']");
    expect(switches.length).toBe(1);
    expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
    expect(ko[COMING_BACK]).toBeTruthy();
  });

  test("a site behind a certificate says the Bot cannot sign in there, not that it is coming", async () => {
    const { row } = await rows([site("hometax")]);
    const hometax = row("Hometax");
    expect(hometax?.textContent).toContain(CERTIFICATE);
    expect(hometax?.textContent).not.toContain(COMING_BACK);
    expect(hometax?.querySelector("[role='switch']")).toBeNull();
    expect(ko[CERTIFICATE]).toBeTruthy();
  });

  test("a connected site's switch turns it off, after asking, and opens nothing", async () => {
    const { view, asked } = await rows([site("baemin-ceo", "connected")]);
    const toggle = view.host.querySelector("[role='switch']");
    expect(toggle).not.toBeNull();
    if (toggle) await view.press(toggle);
    // Asked first: nothing is sent until 연결 끊기.
    expect(asked.filter((line) => !line.endsWith("/api/me"))).toEqual([]);
    const disconnect = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Disconnect",
    );
    expect(disconnect).toBeDefined();
    if (disconnect) await view.press(disconnect);
    expect(asked.filter((line) => !line.endsWith("/api/me"))).toEqual([
      "DELETE /api/sites/baemin-ceo/connection",
    ]);
  });
});
