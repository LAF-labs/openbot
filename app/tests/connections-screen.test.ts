import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectionKeys,
  connectionsOverviewQueryOptions,
  forgetSite,
  isStillWaiting,
  PENDING_POLL_MS,
  PENDING_WINDOW_MS,
  withWaiting,
} from "../src/lib/connections/queries";
import { ko } from "../src/lib/i18n-ko";
import { CATALOGUE_COPY } from "../src/lib/plugins/catalogue-copy";
import { stubFetch } from "./support/fetch";

/**
 * The 연결 screen: what it asks for, how often, and what it refuses to draw.
 *
 * WHY THIS IS A WIRE-AND-TABLE TEST AND NOT A RENDERED ONE, the same reason `connect-card.test.ts`
 * is: the failures worth catching here are not "an element exists". They are the screen asking four
 * endpoints again, polling an endpoint forever because nothing turns it off, and a scope string
 * finding its way back onto a shop owner's screen — none of which an assertion about a `<div>` sees.
 *
 * THE SOURCE-WALKING TESTS ARE THE OTHER HALF. A row's Korean is read through `t(variable)` from
 * the copy table, which `i18n-coverage.test.ts` cannot see, and "no raw scopes" is a property of
 * the whole screen rather than of one component — so both are checked by walking, the same way
 * `owner-vocabulary.test.ts` and `account-state.test.ts` do.
 */

const SOURCE = join(import.meta.dir, "../src");
const SCREEN_FILES = [
  "components/connections/connections-screen.tsx",
  "components/connections/connection-row.tsx",
  "components/connections/oauth-row.tsx",
  "components/connections/site-rows.tsx",
  "components/partners/partner-connections.tsx",
  "components/sites/handoff.tsx",
  "lib/connections/queries.ts",
];

const read = (relative: string) => readFileSync(join(SOURCE, relative), "utf8");

let asked: { url: string; method: string }[] = [];
let realFetch: typeof fetch;
let reply: () => Response = () =>
  new Response(
    JSON.stringify({
      generatedAt: "2026-09-05T00:00:00.000Z",
      accounts: [],
      sites: [],
      bots: [],
    }),
    { status: 200 },
  );

beforeEach(() => {
  asked = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url, init) => {
    asked.push({ url: String(url), method: init?.method ?? "GET" });
    return reply();
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the one read", () => {
  test("is one request, and it is the overview", async () => {
    const options = connectionsOverviewQueryOptions();
    await options.queryFn?.({} as never);

    expect(asked).toEqual([
      { url: "/api/connections/overview", method: "GET" },
    ]);
    // The four this replaced. Asking any of them again would be the old screen's four-request mount
    // creeping back in, which is what the composition exists to end.
    expect(asked.map((one) => one.url)).not.toContain(
      "/api/plugins/connections",
    );
    expect(asked.map((one) => one.url)).not.toContain("/api/partners");
    expect(asked.map((one) => one.url)).not.toContain("/api/sites/connections");
  });

  test("re-asks when the window comes back, against the app's own default", () => {
    /*
     * A consent finishes somewhere else — another tab, or in the installed app the person's own
     * browser — and the only signal this window gets that it is over is the person returning to it.
     * The app's global default is not to refetch on focus, so this has to say so.
     */
    expect(connectionsOverviewQueryOptions().refetchOnWindowFocus).toBe(true);
    // Short rather than zero: crossing to this screen and back should not re-ask.
    expect(connectionsOverviewQueryOptions().staleTime).toBe(15_000);
  });

  test("polls only while something is waiting on somebody else", () => {
    expect(connectionsOverviewQueryOptions(false).refetchInterval).toBe(false);
    expect(connectionsOverviewQueryOptions(true).refetchInterval).toBe(
      PENDING_POLL_MS,
    );
    // A hidden tab cannot see a consent finish, and its throttled timers only bank up requests.
    expect(
      connectionsOverviewQueryOptions(true).refetchIntervalInBackground,
    ).toBe(false);
  });

  test("the waiting stops on its own", () => {
    const now = 1_000_000;
    expect(isStillWaiting([now + PENDING_WINDOW_MS], now)).toBe(true);
    // The whole point: a consent nobody finished is a tab somebody closed, and a screen left open
    // on it must go quiet rather than ask an endpoint every three seconds for the rest of the day.
    expect(isStillWaiting([now - 1], now)).toBe(false);
    expect(isStillWaiting([], now)).toBe(false);
    expect(PENDING_WINDOW_MS).toBe(5 * 60_000);
  });

  test("a row that stops waiting takes its deadline back", () => {
    /*
     * MEASURED, NOT REASONED. With only the start reported, pressing 취소 on a consent left the
     * screen polling every three seconds for the rest of the five minutes: forty requests to an
     * endpoint with nothing new to say, in front of a row that had stopped waiting.
     */
    const started = withWaiting({}, "google-drive", 1_000);
    expect(started).toEqual({ "google-drive": 1_000 });
    expect(withWaiting(started, "google-drive", null)).toEqual({});

    // The rows report from an effect, so an unchanged map has to come back as the same object or
    // every report is a fresh state and the screen renders forever.
    expect(withWaiting(started, "google-drive", 1_000)).toBe(started);
    expect(withWaiting(started, "gmail", null)).toBe(started);
    // One row's wait ending leaves another's alone.
    const two = withWaiting(started, "gmail", 2_000);
    expect(withWaiting(two, "gmail", null)).toEqual({ "google-drive": 1_000 });
  });

  test("a failed read is an error rather than an empty screen", async () => {
    reply = () => new Response("", { status: 500 });
    const options = connectionsOverviewQueryOptions();
    expect(options.queryFn?.({} as never)).rejects.toThrow();
  });

  test("one key, so every mutation on the screen invalidates the same thing", () => {
    expect(connectionKeys.overview().slice(0, 1)).toEqual(
      connectionKeys.all.slice(0, 1),
    );
  });
});

describe("turning a site off", () => {
  test("asks the server to forget this person's row for that site", async () => {
    reply = () =>
      new Response(JSON.stringify({ forgotten: true }), { status: 200 });

    expect(await forgetSite("naver-smartstore")).toBe(true);
    expect(asked).toEqual([
      {
        url: "/api/sites/naver-smartstore/connection",
        method: "DELETE",
      },
    ]);
  });

  test("a refusal throws rather than reporting a disconnection that did not happen", async () => {
    reply = () => new Response("", { status: 503 });
    expect(forgetSite("baemin-ceo")).rejects.toThrow();
  });
});

describe("what the switch starts", () => {
  test("each kind of row starts its own flow, and nothing else", () => {
    // An OAuth row goes to the vendor; it must never be the one calling the site or partner doors.
    const oauth = read("components/connections/oauth-row.tsx");
    expect(oauth).toContain("beginConnect");
    expect(oauth).toContain("openConsent");
    expect(oauth).toContain("disconnectServer");
    expect(oauth).not.toContain("takeControl");
    expect(oauth).not.toContain("forgetSite");

    // A site row opens the Bot's browser and takes the wheel; it holds no consent flow at all.
    const sites = read("components/connections/site-rows.tsx");
    expect(sites).toContain("openSite");
    expect(sites).toContain("takeControl");
    expect(sites).toContain("forgetSite");
    expect(sites).not.toContain("beginConnect");

    // A partner row registers; there is no consent screen and no browser in it.
    const partners = read("components/partners/partner-connections.tsx");
    expect(partners).toContain("requestAlimtalkCode");
    expect(partners).toContain("confirmAlimtalkCode");
    expect(partners).not.toContain("beginConnect");
    expect(partners).not.toContain("takeControl");
  });

  test("turning one off asks first, and the row is what asks", () => {
    const row = read("components/connections/connection-row.tsx");
    // The confirmation lives in the row rather than in each caller, so a Google row and a 배민 row
    // cannot end up with two different ideas of what an off means.
    expect(row).toContain("confirmText");
    expect(row).toContain("setAsking(true)");
    // And it is `role="switch"` and keyboard-operable because it is the project's own Switch.
    expect(row).toContain("<Switch");
    expect(row).toContain("aria-labelledby");
  });

  test("every row that can be turned off says what off means before doing it", () => {
    for (const [file, confirmation] of [
      [
        "components/connections/oauth-row.tsx",
        "Disconnect this? The Bot will not be able to use this account any more.",
      ],
      [
        "components/partners/partner-connections.tsx",
        "Disconnect this? The Bot will not be able to use this account any more.",
      ],
      [
        "components/connections/site-rows.tsx",
        "Turn this site off? The Bot will stop using it. It stays signed in on the Bot's browser until you log out on the site itself.",
      ],
    ] as const) {
      expect(read(file)).toContain(confirmation);
      expect(ko[confirmation]).toBeTruthy();
    }
  });

  test("the wheel is verified before the overlay claims the person has it", () => {
    /*
     * This is the bug the check exists for. `takeControl` answers null when the server refused, and
     * the old screen threw that away and opened the overlay anyway under "조종권은 당신에게
     * 있습니다" — so a refused takeover put somebody in front of a live screen typing a password at
     * a browser that was not listening to them.
     */
    const sites = read("components/connections/site-rows.tsx");
    expect(sites).toContain('held?.holder !== "human"');
    expect(sites).toContain("The browser could not be handed over.");
    // And the overlay keeps watching, because control can end without this window doing anything.
    expect(read("components/sites/handoff.tsx")).toContain("watchControl");
  });

  test("a check that could not be read says so, with a way to ask again", () => {
    // It used to be a silent no-op: the overlay closed, nothing was said, and a row that had just
    // been logged into kept reading 연결 안 됨 with no way to find out why.
    const sites = read("components/connections/site-rows.tsx");
    expect(sites).toContain("The browser's state could not be read.");
    expect(sites).toContain("handleRetryCheck");
    expect(ko["The browser's state could not be read."]).toContain("다시 확인");
  });
});

describe("what the screen is allowed to say", () => {
  test("no scope string, and no vendor address, anywhere on it", () => {
    for (const file of SCREEN_FILES) {
      const text = read(file);
      // The row used to print the vendor's grant verbatim under "Granted access": the most precise
      // thing on the screen, and meaningless to a shop owner — it reads as an error.
      expect(text).not.toContain("Granted access");
      expect(text).not.toContain("connection.scope");
      expect(text).not.toContain("googleapis.com/auth");
      expect(text).not.toMatch(/<code[\s>]/);
    }
  });

  test("nothing on it waits for an administrator", () => {
    /*
     * One VM per person: the reader IS the administrator, and the screen the old sentence pointed
     * at does not render here at all. A person told to wait for somebody has nobody to wait for.
     */
    for (const file of [
      ...SCREEN_FILES,
      "components/plugins/connections.tsx",
    ]) {
      const korean = Object.entries(ko)
        .filter(([key]) => read(file).includes(`t("${key}"`))
        .map(([, value]) => value);
      expect(korean.filter((line) => line.includes("관리자"))).toEqual([]);
    }
  });

  test("a row's capability line is a sentence about the shop, not about the connection", () => {
    // A one-line guard against the table drifting back towards the server's own summaries, which
    // describe what a connector IS rather than what the Bot will now do with it.
    for (const [key, copy] of Object.entries(CATALOGUE_COPY)) {
      expect(`${key}: ${copy.can}`).not.toContain("whoever is asking");
      expect(ko[copy.can]?.length ?? 0).toBeGreaterThan(5);
    }
  });
});
