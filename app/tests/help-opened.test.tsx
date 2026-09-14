import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiRequest,
  installAppDom,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * `/help`, OPENED: ONE REQUEST PER VISIT, AND THE SECTION THE ADDRESS NAMED.
 *
 * Rendered through the real route tree, because "once" is a property of effects and mounts — React
 * runs an effect again for reasons that have nothing to do with a person arriving, and a count that
 * doubled on a re-render would say twice as many people read the guide as did. So the page is
 * opened, pressed (the 문의·의견 box re-renders it), and the requests the shell made are counted.
 * The server's half — what the row may hold — is `server/tests/help-opened-route.test.ts`.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(removeAppDom);

const opened = (requests: readonly ApiRequest[]) =>
  requests.filter(
    (request) =>
      request.method === "POST" &&
      request.pathname === "/api/support/help-opened",
  );

describe("opening the help page", () => {
  test("is said once, with no section, however the page moves under the same visit", async () => {
    const app = await mountApp({ path: "/help" });
    await app.settle(50);
    expect(opened(app.requests).map((request) => request.body)).toEqual([
      { section: null },
    ]);
    const heading = app.host.querySelector("#routines");
    expect(heading).not.toBeNull();

    /*
     * The fragment changes under the open page — a link to a section of it — which re-runs the
     * effect with a new section and is still the same visit. The heading is the same element
     * afterwards: the page was not mounted again, so a second request here could only be the
     * effect counting twice.
     */
    const { act } = await import("react");
    let arrived = false;
    await act(async () => {
      void app.router.navigate({ to: "/help", hash: "routines" }).then(() => {
        arrived = true;
      });
    });
    await app.waitFor(() => arrived, "the fragment to change");
    await app.settle(50);
    expect(app.router.state.location.hash).toBe("routines");
    expect(app.host.querySelector("#routines")).toBe(heading);
    expect(opened(app.requests)).toHaveLength(1);

    // Pressing a control on the page re-renders it too; still the same visit.
    const { t } = await import("../src/lib/i18n");
    const ask = app.buttonNamed(t("Questions and feedback"));
    if (!ask) throw new Error("the 문의·의견 button is not on the page");
    await app.click(ask);
    await app.settle(50);
    expect(opened(app.requests)).toHaveLength(1);
  });

  test("names the section the address asked for, and that section has somewhere to land", async () => {
    const app = await mountApp({ path: "/help#routines" });
    await app.settle(50);
    expect(opened(app.requests).map((request) => request.body)).toEqual([
      { section: "routines" },
    ]);

    // The five headings are anchored at their keys, each once.
    const anchored = [...app.host.querySelectorAll("h2[id]")].map((heading) => [
      heading.id,
      heading.textContent,
    ]);
    expect(anchored).toEqual([
      ["bots", "봇 만들기"],
      ["connections", "연결"],
      ["approvals", "승인"],
      ["routines", "루틴"],
      ["trouble", "문제가 생기면"],
    ]);
    // Still drawn as the guide's headings were before they had ids.
    const routines = app.host.querySelector("#routines");
    expect(routines?.className).toContain("text-2xl");
    expect(routines?.getAttribute("data-streamdown")).toBe("heading-2");
  });

  test("an address naming no section of this guide is a visit with none", async () => {
    const app = await mountApp({ path: "/help#nowhere" });
    await app.settle(50);
    expect(opened(app.requests).map((request) => request.body)).toEqual([
      { section: null },
    ]);
  });
});
