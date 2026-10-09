import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { siteById } from "@shared/sites/catalogue";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE TRAIL'S PAGE, DRAWING THE ROWS A SAVED LOGIN LEAVES (`server/src/logins/store.ts`).
 *
 * The rows hold which login — by where it may go — and, for one that was refused, which fact. The
 * page had words for the four events and nothing else: every one of them drew `-` for what it
 * was about, and a refusal gave no reason, so the facts the server had gone to the trouble of
 * recording could not be read by the one person the page is for (Codex's second read of the
 * change that added them). The page itself, mounted in the app's own router.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const LOGIN = "login_d06856d6-fe20-4499-ba6d-943d04c22646";
const OTHER_LOGIN = "login_cd0a32a8-5f93-4fae-b5da-7cda8098e048";
const where = {
  site: "naver-smartstore",
  origins: ["https://nid.naver.com", "https://sell.smartstore.naver.com"],
};
const row = (
  id: string,
  second: number,
  eventType: string,
  targetId: string,
  payload: Record<string, unknown>,
) => ({
  id,
  actorUserId: "user-1",
  eventType,
  targetType: "saved_login",
  targetId,
  createdAt: `2026-10-10T03:00:0${second}.000Z`,
  payload,
});

/** Newest first, as the API returns them. */
const EVENTS = [
  row("row-5", 5, "account.login_refused", LOGIN, {
    code: "laf:login_seal_unreadable",
  }),
  row("row-4", 4, "account.login_refused", "unsaved", {
    code: "laf:login_origin_refused",
    field: "origins",
  }),
  row("row-3", 3, "account.login_removed", LOGIN, where),
  row("row-2", 2, "account.login_replaced", LOGIN, {
    ...where,
    values: "replaced",
  }),
  // Another login, for a site this deployment does not know by name: only where it may go.
  row("row-1", 1, "account.login_saved", OTHER_LOGIN, {
    origins: ["https://shop.example:8443"],
  }),
  row("row-0", 0, "account.login_saved", LOGIN, where),
];

async function drawn() {
  const view = await mountApp({
    path: "/admin/audit",
    role: "admin",
    api: (request) =>
      request.pathname === "/api/admin/audit-events"
        ? json({ events: EVENTS })
        : undefined,
  });
  await view.waitFor(
    () => (view.main()?.querySelectorAll("tbody tr").length ?? 0) > 1,
    "the trail's rows",
  );
  const rows = [...(view.main()?.querySelectorAll("tbody tr") ?? [])].filter(
    (one) => one.querySelectorAll("td").length === 5,
  );
  const cells = (index: number) =>
    [...(rows[index]?.querySelectorAll("td") ?? [])].map((cell) =>
      (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
  return { view, rows, cells };
}

describe("the trail's page and a saved login", () => {
  test("a login that was saved, changed or deleted is named by its site and the hosts it may go to — and by nothing a person typed", async () => {
    const { view, rows, cells } = await drawn();
    expect(rows).toHaveLength(EVENTS.length);
    const site = siteById("naver-smartstore")?.name ?? "";
    expect(site).not.toBe("");
    const hosts = "nid.naver.com, sell.smartstore.naver.com";

    const [, what, target, , verdict] = cells(5);
    expect(what).toBe("A saved login");
    expect(target).toBe(`${site}${hosts}`);
    expect(verdict).toBe("A person saved a login for their Bot");
    // A site nobody here knows by name is its host, with its port.
    expect(cells(4)[2]).toBe("shop.example:8443");
    expect(cells(3)[4]).toBe("A person changed a saved login");
    expect(cells(2)[4]).toBe("A person deleted a saved login");
    // Ordinary rows: not the colour of a refusal.
    for (const index of [2, 3, 4, 5]) {
      expect(rows[index]?.querySelector(".text-destructive")).toBeNull();
    }
    // The login's own id is not a name worth drawing, and no row says a value or a label.
    expect(view.main()?.textContent).not.toContain(LOGIN);
    await view.unmount();
  });

  test("one that was refused says so in the refusal's colour, and says why in words — never as a code", async () => {
    const { view, rows, cells } = await drawn();
    // A save that never became a login: nothing to name it by, and the reason beside it.
    const [, what, target, , verdict] = cells(1);
    expect(what).toBe("A saved login");
    expect(target).toBe("-");
    expect(verdict).toBe(
      "Saving or changing a login was refused" +
        "An address was not an HTTPS site",
    );
    expect(rows[1]?.querySelector(".text-destructive")?.textContent).toBe(
      "Saving or changing a login was refused",
    );
    // A change of a login this deployment's key no longer opens.
    expect(cells(0)[4]).toBe(
      "Saving or changing a login was refused" +
        "The saved values could not be opened with this deployment's key",
    );
    expect(view.main()?.textContent).not.toContain("laf:");
    await view.unmount();
  });
});
