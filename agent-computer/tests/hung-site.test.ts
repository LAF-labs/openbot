import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { arrivalOf, followArrivals } from "../src/page-arrival";
import { readSettledPageText } from "../src/page-text";
import { createSessions } from "../src/sessions";
import { SNAPSHOT_DEADLINE_MS, snapshotPage } from "../src/snapshot";
import {
  FRAME_BUTTON,
  HANGING_FRAME_PAGE_BUTTON,
  PW_FIELDS,
  serveFixture,
  TO_HANG_PIN,
  VISIBLE_TEXT,
} from "./fixture-site";

/**
 * A site that never answers, and the Bot that has to go on working afterwards.
 *
 * Measured 2026-09-06 (docs/laf/browser-limits.md §3): one navigation to 기업마당 that ran out its
 * deadline left that Bot's browser dead for the rest of the day — every later `navigate` sat out
 * its own deadline, and stop and reset hung behind a `context.close()` that never returned. This
 * drives the real `src/index.ts` against a fixture endpoint that accepts the connection and then
 * says nothing, with a two-second deadline so the run stays short, and asks the two questions that
 * matter: does the next command on that Bot work, and does reset answer while a page is hanging.
 *
 * Skipped where Playwright has no browser downloaded, like korean-sites.test.ts.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const BOT = "hung-site-bot";
const TOKEN = "test-computer-token";
const NAVIGATION_TIMEOUT_MS = 2_000;

type Computer = { url: string; stop: () => Promise<void> };

let fixture: ReturnType<typeof serveFixture> | null = null;
let computer: Computer | null = null;

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

/** The real computer, in a process of its own, giving a page `navigationTimeoutMs` to arrive. */
async function startComputer(navigationTimeoutMs: number): Promise<Computer> {
  const profilesDir = await mkdtemp(join(tmpdir(), "laf-hung-profiles-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "laf-hung-workspace-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      NAVIGATION_TIMEOUT_MS: String(navigationTimeoutMs),
      // The fixture is served on 127.0.0.1, which the navigation guard refuses without this — the
      // same opt-in a laptop deployment sets to browse its own services (navigation-guard.ts).
      AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = async () => {
    child.kill();
    await child.exited;
    await rm(profilesDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = await fetch(`${url}/health`).catch(() => null);
    if (alive?.ok) return { url, stop };
    await Bun.sleep(100);
  }
  await stop();
  throw new Error("the computer did not start");
}

type Answer = { status: number; body: Record<string, unknown>; text: string };

async function call(
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
  { bot = BOT, on = computer }: { bot?: string; on?: Computer | null } = {},
): Promise<Answer> {
  const response = await fetch(`${on?.url}${path}`, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": bot,
    },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return { status: response.status, body, text };
}

const post = (path: string, payload: unknown, bot = BOT) =>
  call("POST", path, payload, { bot });

const timed = async <T>(
  work: Promise<T>,
): Promise<{ result: T; ms: number }> => {
  const started = Date.now();
  const result = await work;
  return { result, ms: Date.now() - started };
};

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  computer = await startComputer(NAVIGATION_TIMEOUT_MS);
});

afterAll(async () => {
  await computer?.stop();
  fixture?.stop();
});

describe.skipIf(!HAS_BROWSER)("a page that never loads", () => {
  test("is given up on at the deadline, as the fact, and the next command works", async () => {
    const hung = await timed(post("/navigate", { url: `${fixture?.url}hang` }));
    expect(hung.result.status).toBe(504);
    expect(hung.result.body.code).toBe("laf:page_timeout");
    // The code in `error` too, and none of Playwright's words: `error` held `goto: Timeout 2000ms
    // exceeded.` until 2026-09-14, for a server that matched it instead of reading `code`.
    expect(hung.result.body.error).toBe("laf:page_timeout");
    expect(JSON.stringify(hung.result.body)).not.toMatch(/Timeout|goto|hang/);
    // The tab was replaced, or the browser was; either way the Bot was told which.
    expect(["page", "browser"]).toContain(String(hung.result.body.recycled));
    // The deadline plus the recovery, never a second deadline on top.
    expect(hung.ms).toBeLessThan(NAVIGATION_TIMEOUT_MS + 8_000);

    // THE FACT THAT WAS BROKEN: the same Bot, the next page. It used to take >45s and fail.
    const next = await timed(post("/navigate", { url: fixture?.url }));
    expect(next.result.status).toBe(200);
    expect(String(next.result.body.text)).toContain(VISIBLE_TEXT);
    expect(next.ms).toBeLessThan(NAVIGATION_TIMEOUT_MS + 8_000);
  }, 40_000);

  test("reset answers while a page is still hanging, and the Bot starts clean", async () => {
    // Not awaited: this is the navigation somebody presses reset in the middle of.
    const hanging = post("/navigate", { url: `${fixture?.url}hang` });
    await Bun.sleep(300);

    const reset = await timed(post("/computers/reset", {}));
    expect(reset.result.status).toBe(200);
    expect(reset.result.body.reset).toBe(true);
    // A close that hangs is killed after its grace (profiles.ts); nothing here waits longer.
    expect(reset.ms).toBeLessThan(10_000);

    // Whatever the interrupted navigation says, it says it rather than waiting for ever.
    const interrupted = await timed(hanging);
    expect(interrupted.result.status).not.toBe(200);
    expect(interrupted.ms).toBeLessThan(NAVIGATION_TIMEOUT_MS + 10_000);

    const fresh = await timed(post("/navigate", { url: fixture?.url }));
    expect(fresh.result.status).toBe(200);
    expect(String(fresh.result.body.text)).toContain(VISIBLE_TEXT);
  }, 40_000);
});

/*
 * A FRAME THAT NEVER LOADS, ON A PAGE THAT DID.
 *
 * Found by W3-c (2026-09-14) and measured again in the image built from eeea985: `/navigate` to
 * `/hanging-frame` answered 200 in 7.1 s, and `/snapshot` did not answer in 120 s — twice — while
 * `/read` beside it answered in 4.5 s. Every look the Bot took at a page carrying a dead payment
 * window was its whole turn. The look answers inside its deadline now, with what the page and the
 * frame that did load hold, and the dead frame counted rather than left out in silence. Twice, so
 * nothing the first look left waiting holds the second.
 */
describe.skipIf(!HAS_BROWSER)("a page with a frame that never loads", () => {
  test("is looked at within the deadline, the frame counted as unseen and the rest listed", async () => {
    const opened = await post("/navigate", {
      url: `${fixture?.url}hanging-frame`,
    });
    expect(opened.status).toBe(200);

    for (let look = 0; look < 2; look += 1) {
      const shot = await timed(post("/snapshot", {}));
      expect(shot.result.status).toBe(200);
      expect(shot.ms).toBeLessThan(SNAPSHOT_DEADLINE_MS);
      expect(shot.result.body.opaqueFrames).toBe(1);
      const elements = shot.result.body.elements as {
        ref: string;
        name: string;
      }[];
      expect(elements.map((element) => element.name)).toContain(
        HANGING_FRAME_PAGE_BUTTON,
      );
      // The frame that did load is read, its control under a frame-scoped ref.
      expect(
        elements.find((element) => element.name === FRAME_BUTTON)?.ref,
      ).toMatch(/^f\d+e\d+$/);
    }
  }, 60_000);
});

/*
 * A TAB WHOSE NEXT PAGE NEVER ARRIVES, LOOKED AT.
 *
 * While a navigation waits on a site that never answers, the tab's document answers nothing
 * (page-arrival.ts). Measured 2026-09-14 in the image built from dbc1c67, one second into a
 * `/navigate` to `/hang`: `/read`, `/screenshot` and `/describe-point` answered 502 at 29.1 s — when
 * the navigation gave the page up — `/snapshot` 502 at 12.0 s, and `/tabs/switch` at once, with the tab
 * titled `Loading http://…/hang`. After a form sent by GET nothing gives the page up, and that title
 * is the address the form's fields are in.
 *
 * Every look answers now within {@link LOOK_BOUND_MS} — it takes about one second — with what the
 * browser can say without the document, and `laf:page_loading` with the origin it is coming from. And
 * a secret a person typed into the page before it left is in none of it: asserted on the whole of
 * every answer, the way a secret is tested.
 */

/** Far above the second a look takes, far below the 12–29 s the looks took before. */
const LOOK_BOUND_MS = 5_000;

/** Every look at the page: the Bot's four, and the person's picture. */
const LOOKS = [
  ["GET", "/read", undefined],
  ["POST", "/snapshot", {}],
  ["POST", "/tabs/switch", { index: 0 }],
  ["POST", "/describe-point", { x: 20, y: 20 }],
  ["GET", "/screenshot", undefined],
] as const;

/** The Bot asks for a value into a field, and a person types it. */
async function typeThroughTheDoor(
  bot: string,
  on: Computer | null,
  box: { ref: string },
  snapshotId: unknown,
  secret: string,
) {
  const asked = await call(
    "POST",
    "/control/secret",
    { label: "확인에 필요한 값", ref: box.ref, snapshotId },
    { bot, on },
  );
  expect(asked.status).toBe(200);
  const supplied = await call(
    "POST",
    "/human/secret",
    { text: secret },
    { bot, on },
  );
  expect(supplied.status).toBe(200);
}

type Element = { ref: string; name: string; type?: string };

/** Every look, each answered in time, as the page still loading from `origin`, with `secret` in none. */
async function looksWhileArriving(
  bot: string,
  on: Computer | null,
  origin: string,
  secret: string,
) {
  for (const [method, path, payload] of LOOKS) {
    const look = await timed(call(method, path, payload, { bot, on }));
    const { status, body, text } = look.result;
    expect({ path, status }).toEqual({ path, status: 200 });
    expect({ path, fast: look.ms < LOOK_BOUND_MS }).toEqual({
      path,
      fast: true,
    });
    expect(text).not.toContain(secret);
    if (path === "/screenshot") {
      // The browser's own picture of the tab, of the page it is leaving.
      expect(String(body.base64).length).toBeGreaterThan(1000);
      continue;
    }
    expect({ path, notes: body.notes }).toMatchObject({
      path,
      notes: [{ code: "laf:page_loading", origin }],
    });
    if (path === "/read") expect([body.text, body.title]).toEqual(["", ""]);
    if (path === "/snapshot") {
      expect([body.elements, body.title]).toEqual([[], ""]);
    }
    if (path === "/snapshot" || path === "/tabs/switch") {
      // No title of a tab between documents: the one Playwright hands back is the address.
      for (const tab of body.tabs as { title: string }[]) {
        expect(tab.title).toBe("");
      }
    }
    if (path === "/describe-point") expect(body.element).toBeNull();
  }
}

describe.skipIf(!HAS_BROWSER)("a tab whose next page never arrives", () => {
  test("after a form sent by GET, every look answers at once, says the page is loading, and carries no secret", async () => {
    const bot = "arrival-form-bot";
    const SECRET = "GET-FORM-SECRET-6021";
    const origin = new URL(fixture?.url ?? "").origin;
    expect(
      (await post("/navigate", { url: `${fixture?.url}to-hang` }, bot)).status,
    ).toBe(200);
    const shot = await post("/snapshot", {}, bot);
    const box = (shot.body.elements as Element[]).find(
      (element) => element.name === TO_HANG_PIN,
    );
    if (!box) throw new Error("the /to-hang fixture has no box to type into");
    await typeThroughTheDoor(bot, computer, box, shot.body.snapshotId, SECRET);

    // Enter in the box sends the form, and the address it goes to is `/hang?pin=<the secret>`.
    const sent = await post("/key", { key: "Enter" }, bot);
    expect(sent.status).toBe(200);
    expect(sent.text).not.toContain(SECRET);

    await looksWhileArriving(bot, computer, origin, SECRET);

    // And the tab can be sent somewhere else: the navigation that never arrived holds nothing up.
    const next = await timed(
      post("/navigate", { url: `${fixture?.url}other` }, bot),
    );
    expect(next.result.status).toBe(200);
    expect(String(next.result.body.text)).toContain("주문 상세 화면");
    const after = await post("/snapshot", {}, bot);
    expect(after.body.notes).toBeUndefined();
    expect((after.body.elements as Element[]).length).toBeGreaterThanOrEqual(0);
  }, 60_000);

  describe("while /navigate still waits for it", () => {
    let patient: Computer | null = null;

    // A deadline the looks fit inside many times over, so every look is of a navigation still waiting.
    beforeAll(async () => {
      patient = await startComputer(20_000);
    });

    afterAll(async () => {
      await patient?.stop();
    });

    test("every look answers at once, says the page is loading, and a secret typed on the page before is in none of them", async () => {
      const bot = "arrival-navigate-bot";
      const SECRET = "PERSON-TYPED-BEFORE-LEAVING-3390";
      const origin = new URL(fixture?.url ?? "").origin;
      const on = patient;
      expect(
        (
          await call(
            "POST",
            "/navigate",
            { url: `${fixture?.url}pw` },
            { bot, on },
          )
        ).status,
      ).toBe(200);
      const shot = await call("POST", "/snapshot", {}, { bot, on });
      const box = (shot.body.elements as Element[]).find(
        (element) => element.name === PW_FIELDS.labelledby,
      );
      if (!box) throw new Error("the /pw fixture has no 패스워드 box");
      await typeThroughTheDoor(bot, on, box, shot.body.snapshotId, SECRET);

      // Not awaited: the navigation the Bot looks at the page in the middle of.
      const hanging = timed(
        call("POST", "/navigate", { url: `${fixture?.url}hang` }, { bot, on }),
      );
      await Bun.sleep(300);
      await looksWhileArriving(bot, on, origin, SECRET);

      // The next navigation replaces the one that never arrived, and that one answers rather than waits.
      const next = await timed(
        call("POST", "/navigate", { url: `${fixture?.url}other` }, { bot, on }),
      );
      expect(next.result.status).toBe(200);
      expect(String(next.result.body.text)).toContain("주문 상세 화면");
      const replaced = await hanging;
      expect(replaced.result.status).not.toBe(200);
      expect(replaced.ms).toBeLessThan(20_000);
    }, 60_000);
  });
});

/*
 * WHAT A TAB BETWEEN DOCUMENTS IS KNOWN BY, IN-PROCESS.
 *
 * The browser's own events for the tab (`followArrivals`): the start of a navigation that replaces the
 * document, and each of its ends — a document that lands, and a navigation that stops without one,
 * which a 204 is. A look in the middle answers with the fact, not with a wait.
 */
describe.skipIf(!HAS_BROWSER)("following a tab between documents", () => {
  const until = async (done: () => boolean, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!done() && Date.now() < deadline) await Bun.sleep(20);
    return done();
  };

  test("is known from the start of a navigation to its end, and a look in between is told so at once", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      followArrivals(page);
      const origin = new URL(fixture?.url ?? "").origin;
      await page.goto(`${fixture?.url}pw`);
      expect(await until(() => arrivalOf(page) === undefined)).toBe(true);

      void page
        .goto(`${fixture?.url}hang`, { timeout: 30_000 })
        .catch(() => undefined);
      expect(await until(() => arrivalOf(page) !== undefined)).toBe(true);
      expect(arrivalOf(page)?.origin).toBe(origin);

      const read = await timed(readSettledPageText(page));
      expect(read.result).toMatchObject({ text: "", arriving: { origin } });
      expect(read.ms).toBeLessThan(LOOK_BOUND_MS);

      const session = createSessions({
        stateDirectoryFor: () => join(tmpdir(), "laf-arrival-unused"),
      }).sessionFor("arrival-bot");
      const look = await timed(snapshotPage(session, page, async () => []));
      expect(look.result.elements).toEqual([]);
      expect(session.notes).toMatchObject([
        { code: "laf:page_loading", origin },
      ]);
      expect(look.ms).toBeLessThan(LOOK_BOUND_MS);

      // A document that lands ends it, and the page reads again.
      await page.goto(`${fixture?.url}other`);
      expect(await until(() => arrivalOf(page) === undefined)).toBe(true);
      expect((await readSettledPageText(page)).text).toContain(
        "주문 상세 화면",
      );

      // So does a navigation that stops with no document: the tab stays on the page it was on.
      await page.goto(`${fixture?.url}no-content`).catch(() => undefined);
      expect(await until(() => arrivalOf(page) === undefined)).toBe(true);
      expect(page.url()).toBe(`${fixture?.url}other`);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
