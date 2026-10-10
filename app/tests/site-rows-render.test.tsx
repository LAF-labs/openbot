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
import { json, mount, routerAt, unmountAll } from "./support/mount";

/**
 * 사이트 연결 WITH NOBODY AT THE WHEEL (owner, 2026-10-09), AND A LOGIN SAVED INSTEAD (2026-10-10).
 *
 * A site was connected by putting the Bot's browser in front of the person to log in on. Nobody
 * drives the Bot's browser now: a site is signed in to when the Bot gets there, with a login the
 * person saved in 계정 or, with none, the masked card in the conversation. So a row that is not
 * connected draws NO switch — one that could only fail would be a control that does nothing
 * (CLAUDE.md) — and offers the one thing that can be done from here: saving the site's login. A
 * row already connected keeps its switch, which only turns it off, and asks first.
 *
 * Rendered rather than read: the source-walking tests in `connections-screen.test.ts` cannot say
 * how many switches a person sees, where a button leads, or what a press sends.
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

const SAVED = "Login saved · your Bot signs in when it gets there";
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

async function rows(
  sites: OverviewSite[],
  /** The sites a login is saved under, as the 계정 list would answer. */
  savedFor: string[] = [],
  /** Logins saved under no site of ours, by the addresses each was saved for. */
  savedAt: string[][] = [],
) {
  const asked: string[] = [];
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = new URL(String(input), "http://app.test");
    asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/me") return json({ error: "nobody" }, 401);
    if (url.pathname === "/api/logins") {
      return json({
        logins: savedFor
          .map((siteId, index) => ({
            id: `login-${index}`,
            label: siteId,
            site: siteId,
            origins: ["https://example.com"],
            createdAt: "2026-10-10T00:00:00.000Z",
            updatedAt: "2026-10-10T00:00:00.000Z",
            lastUsedAt: null,
          }))
          .concat(
            savedAt.map((origins, index) => ({
              id: `login-at-${index}`,
              label: "직접 적은 로그인",
              site: null as unknown as string,
              origins,
              createdAt: "2026-10-10T00:00:00.000Z",
              updatedAt: "2026-10-10T00:00:00.000Z",
              lastUsedAt: null,
            })),
          ),
        max: 100,
      });
    }
    return json({ forgotten: true });
  });
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { createElement } = await import("react");
  const { RouterProvider } = await import("@tanstack/react-router");
  const { SiteRows } = await import("../src/components/connections/site-rows");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A row's button is a link, and a link is drawn only inside a router.
  const router = await routerAt("/", ["/", "/settings/logins"], () =>
    createElement(SiteRows, {
      sites,
      bots: [{ id: "bot-1", name: "수달" }],
      only: sites.map((one) => one.id),
    }),
  );
  const view = await mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RouterProvider, { router }),
    ),
  );
  await view.settle();
  const row = (name: string) =>
    [...view.host.querySelectorAll("[data-slot='item']")].find((item) =>
      item.textContent?.includes(name),
    ) as HTMLElement | undefined;
  return { view, asked, row };
}

/** What a press sent: not the two things the rows read to draw themselves. */
const sent = (line: string) =>
  !line.endsWith("/api/me") && line !== "GET /api/logins";

describe("the site rows, signed in to with a saved login", () => {
  test("a site not signed in to draws no switch, and offers the one thing to do from here: saving its login", async () => {
    const { view, row } = await rows([
      site("naver-smartstore"),
      site("baemin-ceo", "connected"),
    ]);
    const waiting = row("Naver Smart Store Seller Centre");
    expect(waiting?.querySelectorAll("[role='switch']").length).toBe(0);
    // Its name, what the Bot does there, and the button: no sentence restating the button.
    expect(waiting?.querySelectorAll("p").length).toBe(1);
    // Where the switch would be: a link to 계정, for this site.
    const save = waiting?.querySelector("a");
    expect(save?.textContent).toBe("Save login");
    expect(save?.getAttribute("href")).toBe(
      "/settings/logins?site=naver-smartstore",
    );
    // The one connected row keeps its switch, on, and is offered nothing else.
    const switches = view.host.querySelectorAll("[role='switch']");
    expect(switches.length).toBe(1);
    expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
    expect(row("Baemin for Owners")?.querySelectorAll("a").length).toBe(0);
    expect(ko["Save login"]).toBeTruthy();
  });

  test("a site a login is already saved for says so, and offers nothing more to do", async () => {
    const { row } = await rows(
      [site("naver-smartstore"), site("coupang-wing")],
      ["naver-smartstore"],
    );
    const saved = row("Naver Smart Store Seller Centre");
    expect(saved?.textContent).toContain(SAVED);
    expect(saved?.querySelectorAll("a").length).toBe(0);
    expect(saved?.querySelectorAll("[role='switch']").length).toBe(0);
    // The site beside it, with none saved, is still offered one.
    expect(row("Coupang Wing")?.querySelector("a")?.getAttribute("href")).toBe(
      "/settings/logins?site=coupang-wing",
    );
    expect(ko[SAVED]).toBeTruthy();
  });

  /*
   * A login is used wherever its address is, whichever site it was saved from. One for
   * `nid.naver.com` signs the Bot in to every 네이버 service; a row that offered to save another
   * would be asking for a login the Bot already has.
   */
  test("a login saved for the address a site signs in at covers that site, whichever site it was saved under", async () => {
    const { row } = await rows(
      [site("naver-smartstore"), site("naver-smartplace"), site("baemin-ceo")],
      [],
      [["https://nid.naver.com"]],
    );
    for (const name of [
      "Naver Smart Store Seller Centre",
      "Naver Smart Place",
    ]) {
      expect(row(name)?.textContent).toContain(SAVED);
      expect(row(name)?.querySelectorAll("a").length).toBe(0);
    }
    // 배민 signs in somewhere else, and nothing is saved for there.
    expect(
      row("Baemin for Owners")?.querySelector("a")?.getAttribute("href"),
    ).toBe("/settings/logins?site=baemin-ceo");
  });

  test("a site behind a certificate says the Bot cannot sign in there, and offers no login to save", async () => {
    const { row } = await rows([site("hometax")]);
    const hometax = row("Hometax");
    expect(hometax?.textContent).toContain(CERTIFICATE);
    expect(hometax?.querySelectorAll("a").length).toBe(0);
    expect(hometax?.querySelectorAll("[role='switch']").length).toBe(0);
    expect(ko[CERTIFICATE]).toBeTruthy();
  });

  test("a connected site's switch turns it off, after asking, and opens nothing", async () => {
    const { view, asked } = await rows([site("baemin-ceo", "connected")]);
    const toggle = view.host.querySelector("[role='switch']");
    expect(toggle).not.toBeNull();
    if (toggle) await view.press(toggle);
    // Asked first: nothing is sent until 연결 끊기.
    expect(asked.filter(sent)).toEqual([]);
    const disconnect = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Disconnect",
    );
    expect(disconnect).toBeDefined();
    if (disconnect) await view.press(disconnect);
    expect(asked.filter(sent)).toEqual([
      "DELETE /api/sites/baemin-ceo/connection",
    ]);
  });
});
