import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { join } from "node:path";
import { auditFactCodes } from "../../server/src/audit";
import { loginOriginOf } from "../../shared/login-origin";
import {
  addressesIn,
  addressesOf,
  hostOf,
  LOGIN_SITES,
} from "../src/lib/logins/addresses";
import { LOGIN_REFUSALS } from "../src/lib/logins/refusals";
import { BUSINESS_SITES } from "../src/lib/sites/catalogue";
import type { LoginsShown } from "./support/logins-render";
import {
  type ApiRequest,
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * 계정 — THE LOGINS A PERSON SAVED FOR THEIR BOT'S BROWSER (2026-10-10, record §6, piece 2-5).
 *
 * The screen lists what each login is called and where it may go, and is the one place a value is
 * typed: on the way in. Pinned here: what is sent for a new login and for a changed one (a value
 * left empty is a value kept, and is not sent), that nothing drawn or sent back holds a value, and
 * that a refusal is said in the person's words beside the box it is about.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const NAVER = {
  id: "login-1",
  label: "네이버 (가게)",
  site: "naver-smartstore",
  origins: ["https://nid.naver.com", "https://sell.smartstore.naver.com"],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  lastUsedAt: null,
};

function server(
  options: {
    logins?: (typeof NAVER)[];
    max?: number;
    refuse?: { status: number; body: unknown };
  } = {},
) {
  let held = [...(options.logins ?? [])];
  const writes: { method: string; path: string; body: unknown }[] = [];
  const api = (request: ApiRequest) => {
    const { pathname, method } = request;
    if (!pathname.startsWith("/api/logins")) return undefined;
    if (method === "GET") {
      return json({ logins: held, max: options.max ?? 100 });
    }
    writes.push({ method, path: pathname, body: request.body });
    if (options.refuse) return json(options.refuse.body, options.refuse.status);
    if (method === "DELETE") {
      held = held.filter((login) => !pathname.endsWith(login.id));
      return new Response(null, { status: 204 });
    }
    const body = request.body as { label: string; origins: string[] };
    const saved = {
      ...NAVER,
      id: method === "POST" ? "login-new" : NAVER.id,
      label: body.label,
      site: null as unknown as string,
      origins: body.origins.map((origin) => `https://${origin}`),
    };
    held =
      method === "POST"
        ? [...held, saved]
        : held.map((login) => (login.id === saved.id ? saved : login));
    return json(saved, method === "POST" ? 201 : 200);
  };
  return { api, writes };
}

let rendering: Promise<LoginsShown> | undefined;

/** One process for the file: the route tree is expensive to load. */
function rendered(): Promise<LoginsShown> {
  rendering ??= render();
  return rendering;
}

async function render(): Promise<LoginsShown> {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/logins-render.tsx")],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("LOGINS_RENDER "));
  if (status !== 0 || !line) {
    throw new Error(
      `the dialogs' render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("LOGINS_RENDER ".length)) as LoginsShown;
}

describe("Settings → 계정", () => {
  test("lists what each login is called and where it may go, and nothing of what it holds", async () => {
    const { api } = server({ logins: [NAVER] });
    const view = await mountApp({ path: "/settings/logins", api });
    await view.waitFor(
      () => view.host.textContent?.includes(NAVER.label) === true,
      "the saved login",
    );
    expect(view.host.textContent).toContain("Accounts");
    // The hosts, as a person reads them.
    expect(view.host.textContent).toContain(
      "nid.naver.com, sell.smartstore.naver.com",
    );
    expect(view.host.textContent).not.toContain("https://");
    // Each row can be changed and deleted, by name.
    expect(
      view.host.querySelector(`button[aria-label="Change ${NAVER.label}"]`),
    ).not.toBeNull();
    expect(
      view.host.querySelector(`button[aria-label="Delete ${NAVER.label}"]`),
    ).not.toBeNull();
    // No box on the page holds anything: there is no value to show.
    expect(view.host.querySelector("input")).toBeNull();
  });

  /*
   * AN ANSWER THAT IS NOT THE LIST IS NOT AN EMPTY LIST (Codex's read). Read leniently, a body
   * with no `logins` drew "no login is saved yet", and a row that could not be read was left out:
   * the screen telling a person who saved three that nothing is saved.
   */
  test("an answer that is not the list is the list not having loaded — never 'nothing saved', and never some of the rows", async () => {
    for (const body of [
      {},
      { logins: "none", max: 100 },
      { logins: [NAVER, { id: 7, label: "깨진 행" }], max: 100 },
      { logins: [NAVER] },
    ]) {
      const view = await mountApp({
        path: "/settings/logins",
        api: ({ pathname }) =>
          pathname === "/api/logins" ? json(body) : undefined,
      });
      await view.waitFor(
        () =>
          view.host.textContent?.includes(
            "The saved logins could not be loaded.",
          ) === true,
        "the load failure",
      );
      expect(view.host.textContent).not.toContain("No login is saved yet.");
      expect(view.host.textContent).not.toContain(NAVER.label);
      await view.unmount();
    }
  });

  test("with nothing saved, says so and offers to add one", async () => {
    const { api } = server();
    const view = await mountApp({ path: "/settings/logins", api });
    await view.waitFor(
      () => view.host.textContent?.includes("No login is saved yet.") === true,
      "the empty line",
    );
    expect(view.buttonNamed("Add login")).toBeDefined();
  });

  /*
   * WHAT GOES THROUGH A DIALOG IS PRESSED IN A PROCESS OF ITS OWN (`support/logins-render.tsx`):
   * Base UI decides once per process whether a popup can open, and in this suite's shared one it
   * has usually decided no before this file's DOM exists (`confirm-dialog.test.tsx`). The four
   * below passed in this process when the file ran alone and failed in the whole suite.
   */
  test("saves a new one as it was typed: the addresses one to a line, the name, and both values — once", async () => {
    const { siteBox, saved } = await rendered();
    // The site box reads as words, not as the value behind them (it read "another" once).
    expect(siteBox).toContain("Another site");
    expect(saved.writes).toEqual([
      {
        method: "POST",
        path: "/api/logins",
        body: {
          label: "네이버 (가게)",
          site: null,
          origins: [
            "nid.naver.com",
            "sell.smartstore.naver.com",
            "shop.example",
          ],
          username: "sajang",
          // As typed: a password may begin or end with a space.
          password: " hunter2 ",
        },
      },
    ]);
    // The dialog is gone with what was typed into it, and the list was read again.
    expect(saved).toMatchObject({
      isDialogClosed: true,
      isRowDrawn: true,
      isValueLeft: false,
    });
  }, 120_000);

  test("changes one without its values: what was left empty is not sent, and the saved values are never drawn", async () => {
    const { changed } = await rendered();
    // What is saved fills the boxes that are not values; the two values start empty.
    expect(changed.opened).toEqual({
      "login-label": NAVER.label,
      "login-addresses": "nid.naver.com\nsell.smartstore.naver.com",
      "login-username": "",
      "login-password": "",
    });
    /*
     * ONLY WHAT WAS CHANGED IS SENT (Codex's read). The server keeps whatever a change does not
     * name; a form opened a while ago that sent back the addresses it was opened with would undo
     * what another window had narrowed since, and widen where the login may go.
     */
    expect(changed.writes).toEqual([
      {
        method: "PATCH",
        path: `/api/logins/${NAVER.id}`,
        body: { label: "네이버" },
      },
    ]);
    expect(changed.passwordOnly).toEqual([
      {
        method: "PATCH",
        path: `/api/logins/${NAVER.id}`,
        body: { password: "new-pass" },
      },
    ]);
    // And saved as it was opened, the server is asked for nothing.
    expect(changed.untouched).toEqual({ writes: [], isDialogClosed: true });
    // A login deleted elsewhere while its form was open: said in the form, and gone from the
    // list behind it — not left there to be opened again for the same refusal (Codex's read).
    expect(changed.gone).toEqual({ isSaid: true, isRowLeft: false });
  }, 120_000);

  /*
   * A SAVE ON ITS WAY HOLDS ITS DIALOG (Codex's read). Closed under it, the request still saved the
   * password with nothing left to say whether it had — and its late answer closed whichever form
   * was open by then.
   */
  test("cannot be closed while a save is on its way — not by Escape, not by the × — and closes itself once it is saved", async () => {
    const { pending } = await rendered();
    expect(pending).toEqual({
      isOpenAfterEscape: true,
      isOpenAfterClose: true,
      isCloseDisabled: true,
      isClosedOnceSaved: true,
    });
  }, 120_000);

  test("says a refusal in the person's words beside the box it is about, and keeps the form", async () => {
    const { refused } = await rendered();
    expect(refused).toEqual({
      writes: 1,
      isSaid: true,
      addressesInvalid: "true",
      labelInvalid: "false",
      // Still open, with what was typed: the person mends one box and presses again.
      usernameKept: "sajang",
      // And never the code itself.
      isCodeDrawn: false,
    });
  }, 120_000);

  test("deletes the one whose bin was pressed, after a question that names it — and no other", async () => {
    const { removed } = await rendered();
    expect(removed).toEqual({
      // By name: with two saved, "this login" would not say which (a reviewer's point). The
      // particle after it is the Korean sentence's, carried by the key every delete here uses.
      question: "Delete 거래처 발주를?",
      writesBeforeConfirm: 0,
      writes: [{ method: "DELETE", path: "/api/logins/login-2", body: null }],
      rowsAfter: [NAVER.label],
      refusedText: expect.any(String),
    });
    // A delete the server refuses is said as a sentence: the dialog draws an error's own words,
    // and a refusal's own words are its code (Codex's read).
    expect(removed.refusedText).toContain("That login is not saved any more.");
    expect(removed.refusedText).not.toContain("laf:");
  }, 120_000);

  test("at the most one person may save, offers no more and says why", async () => {
    const { api } = server({ logins: [NAVER], max: 1 });
    const view = await mountApp({ path: "/settings/logins", api });
    await view.waitFor(
      () => view.host.textContent?.includes(NAVER.label) === true,
      "the saved login",
    );
    // Compared as a fact: an element that fails `toBeUndefined` is printed whole.
    expect(view.buttonNamed("Add login") === undefined).toBe(true);
    expect(view.host.textContent).toContain(
      "No more logins can be saved. Delete one first.",
    );
  });
});

/*
 * A LOGIN IS USED ONLY WHERE ITS ADDRESSES SAY, so what the form offers for a site decides whether
 * the login is ever used. 네이버's sellers type their password at `nid.naver.com`, not at the
 * Seller Centre: offered the site's own hosts alone, the login would be saved and never put in.
 */
describe("the addresses offered for a site this product knows", () => {
  test("begin with where its sign-in boxes are, then the site's own — each once, and none for a site it does not know", () => {
    expect(addressesOf("naver-smartstore")).toEqual([
      "nid.naver.com",
      "sell.smartstore.naver.com",
      "smartstore.naver.com",
    ]);
    expect(addressesOf("no-such-site")).toEqual([]);
    expect(addressesOf("another")).toEqual([]);
  });

  test("what a person types is read one address to a line or between commas, and an origin is drawn as its host", () => {
    expect(
      addressesIn(" nid.naver.com \n\n shop.example, b.example ,\n"),
    ).toEqual(["nid.naver.com", "shop.example", "b.example"]);
    expect(addressesIn("  \n ")).toEqual([]);
    expect(hostOf("https://nid.naver.com")).toBe("nid.naver.com");
    // What is not the usual scheme is not hidden: a developer's loopback address says so.
    expect(hostOf("http://127.0.0.1:4395")).toBe("http://127.0.0.1:4395");
  });

  /*
   * NOT A SITE THAT TAKES A CERTIFICATE (Codex's read). 홈택스 is signed in to with a certificate
   * that stays on the person's device; offered here it would take a name and a password, say it
   * had saved them, and never be able to use them.
   */
  test("are offered only for sites a person signs in to with a name and a password", () => {
    expect(LOGIN_SITES.length).toBeGreaterThan(5);
    expect(LOGIN_SITES.every((site) => site.handoff === "login")).toBe(true);
    expect(LOGIN_SITES.map((site) => site.id)).not.toContain("hometax");
    expect(BUSINESS_SITES.find((site) => site.id === "hometax")?.handoff).toBe(
      "certificate",
    );
    expect(addressesOf("hometax")).toEqual([]);
  });

  test("are every one an address a login can be saved for", () => {
    const offered = BUSINESS_SITES.flatMap((site) => addressesOf(site.id));
    expect(offered.length).toBeGreaterThan(BUSINESS_SITES.length);
    expect(offered.filter((host) => loginOriginOf(host) === null)).toEqual([]);
    // And where a site names its sign-in, that is somewhere its own hosts are not.
    for (const site of BUSINESS_SITES) {
      for (const host of site.signInHosts ?? []) {
        expect(site.hosts).not.toContain(host);
      }
    }
  });
});

describe("why a login was not saved", () => {
  test("every code the server refuses a login with has a sentence here", () => {
    const refusals = auditFactCodes.filter(
      (code) => code.startsWith("laf:login_") || code === "laf:logins_full",
    );
    expect(refusals.length).toBeGreaterThanOrEqual(10);
    expect(
      refusals.filter((code) => !Object.hasOwn(LOGIN_REFUSALS, code)),
    ).toEqual([]);
  });
});
