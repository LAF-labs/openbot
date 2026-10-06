import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { OauthAccount } from "../src/lib/connections/queries";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * BACK FROM A CONSENT, ON THE SCREEN A PERSON LANDS ON.
 *
 * Two things were wrong at once on `/settings/connected-accounts`, and every test there was passed
 * over both, because the mapping was tested as a function and the notice as a component:
 *
 * NOBODY READ THE REASON. The callback has sent `?connected=failed&reason=…` since 2026-09-05 — one
 * of five words, each with a different next move — and `connectFailureText` has had a sentence for
 * each since the same day. No screen read the parameter, so all five drew one sentence.
 *
 * AND THAT SENTENCE DID NOT STAY. Measured 2026-10-06 through this route: drawn 88 ms after the page
 * opened, gone before it had settled. The notice clears the parameter the moment it has latched it,
 * and the screen mounted the notice only while the parameter was there — so somebody back from a
 * consent that had worked was told nothing either.
 *
 * So everything here is mounted through the real route tree and looked at AFTER the address has
 * lost what the redirect put in it: that is the screen somebody is left reading.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const GENERAL =
  "The connection did not finish, and nothing was saved. Please try again.";

/**
 * The five words the callback chooses from (`REASONS` in the server's `connected-page.ts`), and
 * the line each is said on. Four are failures and interrupt (`alert`). `denied` is the person's own
 * cancel at the vendor: said on the quiet line, because nothing went wrong.
 */
const REASONS: { reason: string; says: string; on: "alert" | "status" }[] = [
  {
    reason: "expired",
    says: "The connection took too long. Please try again.",
    on: "alert",
  },
  {
    reason: "reused",
    says: "That connection link has already been used.",
    on: "alert",
  },
  { reason: "denied", says: "The connection was cancelled.", on: "status" },
  {
    reason: "exchange",
    says: "The service could not finish connecting. Please try again.",
    on: "alert",
  },
  {
    reason: "mismatch",
    says: "This connection could not be completed.",
    on: "alert",
  },
];

type View = Awaited<ReturnType<typeof mountApp>>;

/** What the address still carries of the redirect. */
const carried = (view: View) => {
  const search = view.router.state.location.search as Record<string, unknown>;
  return { connected: search.connected, reason: search.reason };
};

/** Every line of one kind under the page that has words in it. */
const said = (view: View, role: "alert" | "status") =>
  [...(view.main()?.querySelectorAll(`[role="${role}"]`) ?? [])]
    .map((region) => region.textContent ?? "")
    .filter((words) => words !== "");

/** The screen as a redirect opens it, once the address has lost what the redirect carried. */
async function backWith(search: string, api?: ApiAnswer): Promise<View> {
  const view = await mountApp({
    path: `/settings/connected-accounts?${search}`,
    ...(api ? { api } : {}),
  });
  await view.waitFor(
    () =>
      carried(view).connected === undefined &&
      carried(view).reason === undefined,
    "the address to lose what the redirect carried",
  );
  await view.settle(60);
  return view;
}

describe("a consent that did not finish", () => {
  test.each(REASONS)(
    "$reason is told in its own words, and they stay once the address has lost them",
    async ({ reason, says, on }) => {
      const view = await backWith(`connected=failed&reason=${reason}`);
      // On its own line and not the other: a cancel is not alarmed, and a failure is not whispered.
      // The quiet lines are searched rather than listed: the screen has status lines of its own.
      expect({
        alert: said(view, "alert"),
        quiet: said(view, "status").includes(says),
      }).toEqual({
        alert: on === "alert" ? [says] : [],
        quiet: on === "status",
      });
      expect(carried(view)).toEqual({
        connected: undefined,
        reason: undefined,
      });
      // What a Korean reader is left with is this reason's own sentence, not the general one.
      expect(typeof ko[says]).toBe("string");
      expect(ko[says]).not.toBe(ko[GENERAL]);
    },
  );

  test("a reason this build does not know is told as the general sentence, and the word is drawn nowhere", async () => {
    // An older or a newer server, or an address somebody typed.
    const view = await backWith("connected=failed&reason=something-else");
    expect(said(view, "alert")).toEqual([GENERAL]);
    expect(view.host.textContent).not.toContain("something-else");
    expect(carried(view)).toEqual({ connected: undefined, reason: undefined });
  });

  test("with no reason at all, which is all the installed app's link back carries, the general sentence stays too", async () => {
    const view = await backWith("connected=failed");
    expect(said(view, "alert")).toEqual([GENERAL]);
    expect(typeof ko[GENERAL]).toBe("string");
  });

  /*
   * The router reads `reason=7` as a number and a reason given twice as a list, and hands the page
   * what it read whatever the route's schema made of it (measured: a search that fails validation
   * still reaches `useSearch` as it was parsed). Neither is a word the mapping knows.
   */
  test.each(["reason=7", "reason=expired&reason=denied"])(
    "a reason that is not one word, %s, costs the notice its reason and not the notice",
    async (odd) => {
      const view = await backWith(`connected=failed&${odd}`);
      expect(said(view, "alert")).toEqual([GENERAL]);
      expect(carried(view)).toEqual({
        connected: undefined,
        reason: undefined,
      });
    },
  );
});

describe("a consent that finished", () => {
  const GMAIL: OauthAccount = {
    kind: "oauth",
    id: "gmail",
    serverId: "gmail",
    title: "Gmail",
    vendor: "google",
    status: "connected",
    connectedAt: "2026-10-06T00:00:00.000Z",
    account: null,
    needsInstanceName: false,
    health: {
      status: "ok",
      lastOkAt: "2026-10-06T00:00:00.000Z",
      lastFailureAt: null,
      failureCode: null,
    },
  };

  test("is told by the vendor's name, and that stays once the address has lost it", async () => {
    const view = await backWith("connected=gmail", (request) =>
      request.pathname === "/api/connections/overview"
        ? json({
            generatedAt: "2026-10-06T00:00:00.000Z",
            accounts: [GMAIL],
            sites: [],
            bots: [],
          })
        : undefined,
    );
    await view.waitFor(
      () => said(view, "status").includes("Connected to Gmail."),
      "the notice to name the vendor",
    );
    expect(said(view, "alert")).toEqual([]);
    expect(carried(view)).toEqual({ connected: undefined, reason: undefined });
  });
});
