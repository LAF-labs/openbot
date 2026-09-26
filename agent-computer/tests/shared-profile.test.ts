import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { resolveProfile } from "../src/profiles";
import { createSessions } from "../src/sessions";
import { serveFixture, SIGNED_OUT_TEXT, signedInAs } from "./fixture-site";

/**
 * ONE BROWSER PROFILE FOR THE WHOLE DEPLOYMENT, MEASURED RATHER THAN ASSERTED ABOUT A STUB.
 *
 * The owner's decision, 2026-09-16: a deployment is one person's machine, so a site one Bot signs
 * into is signed in for the others — they should authorise 스마트스토어 once, not once per Bot. The
 * code said the opposite ("One profile per Bot", `directoryFor(botId)`) while the onboarding screen
 * had been promising the shared model the whole time.
 *
 * So every test below drives the real thing: real Chromium profiles on disk, and the real
 * `src/index.ts` over HTTP with `x-openbot-bot-id`, which is how the server drives it. A stub that
 * agreed two Bots got the same string would have passed on the day the browsers were separate.
 *
 * Skipped where Playwright has no browser downloaded, which is the case on a checkout that has not
 * run `bunx playwright install chromium`. A skip says so out loud; a test that quietly launched
 * nothing would be worse than not having it.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "test-computer-token";

/** Two Bots of one person, as different as two Bots get: neither knows the other exists. */
const SHOP_BOT = "shop-bot";
const OFFICE_BOT = "office-bot";

/** Who signs in, so a read of the second Bot's page says whose session it is looking at. */
const SIGNED_IN_AS = "가게봇";

let fixture: ReturnType<typeof serveFixture> | null = null;
let workspaceDir = "";

/** A port nothing else has, found by taking one and giving it straight back. */
async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

type Computer = {
  base: string;
  child: ReturnType<typeof Bun.spawn>;
  profilesDir: string;
};

/** Start a computer of this test's own on its own port, against its own profiles root. */
async function startComputer(profilesDir: string): Promise<Computer> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      // The fixture is served on 127.0.0.1, which the navigation guard refuses without this — the
      // same opt-in a laptop deployment sets to browse its own services (navigation-guard.ts).
      AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      // A laptop has no host to hold the browser's egress rules (egress-guard.ts).
      AGENT_COMPUTER_EGRESS_FIREWALL: "off",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = await fetch(`${base}/health`).catch(() => null);
    if (alive?.ok) return { base, child, profilesDir };
    await Bun.sleep(100);
  }
  child.kill();
  throw new Error("the computer did not start");
}

async function stopComputer(computer: Computer | null): Promise<void> {
  if (!computer) return;
  computer.child.kill();
  await computer.child.exited.catch(() => undefined);
}

type Answer = { status: number; body: Record<string, unknown> };

async function call(
  computer: Computer,
  path: string,
  init: RequestInit & { bot?: string | null } = {},
): Promise<Answer> {
  const { bot, ...rest } = init;
  const response = await fetch(`${computer.base}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      ...(bot ? { "x-openbot-bot-id": bot } : {}),
    },
  });
  return {
    status: response.status,
    body: ((await response.json().catch(() => null)) ?? {}) as Record<
      string,
      unknown
    >,
  };
}

const post = (
  computer: Computer,
  path: string,
  payload: unknown,
  bot: string | null,
) =>
  call(computer, path, {
    method: "POST",
    body: JSON.stringify(payload),
    bot,
  });

type Note = { code: string } & Record<string, unknown>;
const notesOf = (body: Record<string, unknown>): Note[] =>
  Array.isArray(body.notes) ? (body.notes as Note[]) : [];

/**
 * A real Chromium profile with a real login in it, built the way the product builds one.
 *
 * `launchPersistentContext` on the directory, a navigation that sets a cookie, then a close — which
 * is what flushes the cookie to disk. Nothing here writes a Cookies file by hand: the point of these
 * tests is that Chromium's own state is what moves.
 */
async function signInToProfile(dir: string, who: string): Promise<void> {
  const context = await chromium.launchPersistentContext(dir, {
    args: ["--password-store=basic"],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${fixture?.url}sign-in?as=${encodeURIComponent(who)}`);
  await context.close();
  // Chromium commits cookies as it exits; the close above only asks it to.
  await Bun.sleep(1_000);
}

/** Age a profile so "most recently used" is a fact of this test rather than of the clock. */
async function ageProfile(dir: string, when: Date): Promise<void> {
  for (const path of [
    join(dir, "Default", "Cookies"),
    join(dir, "Default"),
    join(dir, "Local State"),
    dir,
  ]) {
    await utimes(path, when, when).catch(() => undefined);
  }
}

beforeAll(async () => {
  fixture = serveFixture();
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-shared-workspace-"));
});

afterAll(async () => {
  fixture?.stop();
  await rm(workspaceDir, { recursive: true, force: true }).catch(
    () => undefined,
  );
});

describe.if(HAS_BROWSER)("two Bots, one cookie jar", () => {
  let computer: Computer | null = null;
  let profilesDir = "";

  beforeAll(async () => {
    profilesDir = await mkdtemp(join(tmpdir(), "laf-shared-profiles-"));
    computer = await startComputer(profilesDir);
  });

  afterAll(async () => {
    await stopComputer(computer);
    await rm(profilesDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  });

  test("a site one Bot signs into is signed in for the other", async () => {
    if (!computer) throw new Error("no computer");

    // Nobody is signed in yet, asked as the Bot that is about to sign in. Without this the test
    // would pass on a fixture that said 로그인됨 to everybody.
    const before = await post(
      computer,
      "/navigate",
      { url: `${fixture?.url}whoami` },
      SHOP_BOT,
    );
    expect(before.status).toBe(200);
    expect(String(before.body.text ?? "")).toContain(SIGNED_OUT_TEXT);

    const signedIn = await post(
      computer,
      "/navigate",
      { url: `${fixture?.url}sign-in?as=${encodeURIComponent(SIGNED_IN_AS)}` },
      SHOP_BOT,
    );
    expect(signedIn.status).toBe(200);
    expect(String(signedIn.body.text ?? "")).toContain(
      signedInAs(SIGNED_IN_AS),
    );

    /*
     * THE MEASUREMENT. A different Bot, a different tab, the same cookie — and the page it gets is
     * the one the person authorised once. Before 2026-09-16 this read 로그인해 주세요, because
     * `office-bot` opened a Chromium of its own on a directory of its own.
     */
    const other = await post(
      computer,
      "/navigate",
      { url: `${fixture?.url}whoami` },
      OFFICE_BOT,
    );
    expect(other.status).toBe(200);
    expect(String(other.body.text ?? "")).toContain(signedInAs(SIGNED_IN_AS));
  }, 60_000);

  test("and there is one profile directory on disk, not one per Bot", async () => {
    const entries = await readdir(profilesDir, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toContain("shared.profile");
    // Neither Bot's id is a directory of its own any more, which is the whole change. Asserted on
    // the ids rather than on the exact list: `bot.state` appears only once somebody has taken the
    // wheel, and nothing here has.
    expect(directories).not.toContain(SHOP_BOT);
    expect(directories).not.toContain(OFFICE_BOT);
    // And nothing else made one: every directory here is the layout's, and the layout's carry a dot
    // so that no Bot anybody creates can collide with them.
    expect(directories.filter((name) => !name.includes("."))).toEqual([]);
  }, 20_000);

  test("each Bot still has tabs of its own, because they act at the same time", async () => {
    if (!computer) throw new Error("no computer");
    // Sharing the logins is the decision; sharing the page being looked at is not — two Bots can run
    // at once (server/src/runner/bot-lane.ts queues per Bot), and one snapshot going stale under the
    // other is a click landing on a stranger's page.
    await post(computer, "/navigate", { url: fixture?.url }, SHOP_BOT);
    await post(
      computer,
      "/navigate",
      { url: `${fixture?.url}other` },
      OFFICE_BOT,
    );
    const shop = await post(computer, "/snapshot", {}, SHOP_BOT);
    const office = await post(computer, "/snapshot", {}, OFFICE_BOT);
    const tabsOf = (answer: Answer) =>
      (answer.body.tabs as { url: string }[] | undefined) ?? [];
    expect(tabsOf(shop)).toHaveLength(1);
    expect(tabsOf(office)).toHaveLength(1);
    expect(tabsOf(office)[0]?.url).toContain("/other");
    expect(tabsOf(shop)[0]?.url).not.toContain("/other");
  }, 60_000);

  test("and the computer still refuses a call that names no Bot", async () => {
    if (!computer) throw new Error("no computer");
    // The profile stopped being per Bot; the header did not. It is what the audit trail, the
    // allowlist and the live screen are keyed on, and a call without it used to be served a fixed
    // `"shared"` profile as though it had worked.
    for (const path of ["/read", "/snapshot", "/computers/reset"]) {
      const answered = await call(computer, path, {
        method: path === "/read" ? "GET" : "POST",
        ...(path === "/read" ? {} : { body: "{}" }),
        bot: null,
      });
      expect([path, answered.status, answered.body.code]).toEqual([
        path,
        400,
        "laf:bot_header_missing",
      ]);
    }
    // And `/health` still answers without one, because an orchestrator has no Bot to name.
    const health = await call(computer, "/health", { bot: null });
    expect(health.status).toBe(200);
  }, 30_000);
});

describe.if(HAS_BROWSER)("resetting the computer", () => {
  let computer: Computer | null = null;
  let profilesDir = "";

  beforeAll(async () => {
    profilesDir = await mkdtemp(join(tmpdir(), "laf-reset-profiles-"));
    computer = await startComputer(profilesDir);
  });

  afterAll(async () => {
    await stopComputer(computer);
    await rm(profilesDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  });

  test("empties the one profile every Bot uses, once, whichever Bot asked", async () => {
    if (!computer) throw new Error("no computer");
    await post(
      computer,
      "/navigate",
      { url: `${fixture?.url}sign-in?as=${encodeURIComponent(SIGNED_IN_AS)}` },
      SHOP_BOT,
    );

    /*
     * ASKED BY THE OTHER BOT, and it signs the first one out. That is the property the button's
     * words had to change for: the Bot on the header is who pressed it, not whose logins go.
     */
    // A file the owner attached, as the server files it for the Bot to read.
    const attached = join(
      workspaceDir,
      "uploads",
      "2026-09-26-1a2b3c4d-매출.csv",
    );
    await mkdir(join(workspaceDir, "uploads"), { recursive: true });
    await writeFile(attached, "메뉴,수량\n라떼,2\n", "utf8");

    const reset = await post(computer, "/computers/reset", {}, OFFICE_BOT);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      reset: true,
      botId: OFFICE_BOT,
      scope: "deployment",
    });
    // The administrator's reset promises a sign-out, and the folder is not part of that promise.
    expect(existsSync(attached)).toBe(true);
    expect(reset.body.emptied).toBeUndefined();

    // An account leaving asks for the folder as well, and gets it.
    const leaving = await post(
      computer,
      "/computers/reset",
      { emptyFolder: true },
      OFFICE_BOT,
    );
    expect(leaving.status).toBe(200);
    expect(existsSync(attached)).toBe(false);
    expect(leaving.body.emptied).toBeGreaterThanOrEqual(1);
    expect(existsSync(workspaceDir)).toBe(true);

    const after = await post(
      computer,
      "/navigate",
      { url: `${fixture?.url}whoami` },
      SHOP_BOT,
    );
    expect(String(after.body.text ?? "")).toContain(SIGNED_OUT_TEXT);
  }, 90_000);
});

describe.if(HAS_BROWSER)(
  "upgrading a machine that has a profile per Bot",
  () => {
    let computer: Computer | null = null;
    let profilesDir = "";

    beforeAll(async () => {
      profilesDir = await mkdtemp(join(tmpdir(), "laf-upgrade-profiles-"));
      /*
       * The machine as it stands before the upgrade: two real Chromium profiles, each with a real
       * login in it, one used yesterday and one used last month. Built with Playwright rather than
       * written by hand, because what has to survive is Chromium's own state.
       */
      await signInToProfile(join(profilesDir, "old-bot"), "옛봇");
      await signInToProfile(join(profilesDir, "new-bot"), "새봇");
      await ageProfile(
        join(profilesDir, "old-bot"),
        new Date(Date.now() - 30 * 24 * 3_600_000),
      );
      await ageProfile(
        join(profilesDir, "new-bot"),
        new Date(Date.now() - 24 * 3_600_000),
      );
      computer = await startComputer(profilesDir);
    });

    afterAll(async () => {
      await stopComputer(computer);
      await rm(profilesDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    });

    test("keeps the person's logins: the newest profile becomes everybody's", async () => {
      if (!computer) throw new Error("no computer");
      // A THIRD Bot, which never had a profile at all, reading a login it did not perform. The
      // alternative — a clean shared profile — would have made a version bump the reason somebody has
      // to sign into their bank, 홈택스 and 스마트스토어 again.
      const opened = await post(
        computer,
        "/navigate",
        { url: `${fixture?.url}whoami` },
        "third-bot",
      );
      expect(opened.status).toBe(200);
      expect(String(opened.body.text ?? "")).toContain(signedInAs("새봇"));
    }, 90_000);

    test("says which it took and how many it left, and leaves those alone", async () => {
      if (!computer) throw new Error("no computer");
      /*
       * The note rides out on the result of whatever call started the browser — so this test reads it
       * from a computer started fresh, rather than from the one above whose note has been drained.
       */
      await stopComputer(computer);
      computer = await startComputer(profilesDir);
      const opened = await post(
        computer,
        "/navigate",
        { url: `${fixture?.url}whoami` },
        "fourth-bot",
      );
      const told = notesOf(opened.body).find(
        (note) => note.code === "laf:profile_adopted",
      );
      expect(told).toMatchObject({ adopted: "new-bot", kept: 1 });

      // And the one that was left is still there, cookies and all. Merging two Chromium profiles is
      // not a thing that can be done safely, and deleting one is the person's call, not an upgrade's.
      const entries = await readdir(profilesDir, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(directories).toContain("old-bot");
      expect(directories).toContain("new-bot");
      // Nothing fresh was made: the adopted directory IS the shared profile.
      expect(directories).not.toContain("shared.profile");
    }, 90_000);
  },
);

describe("which profile an upgrade takes over", () => {
  /**
   * The ordering on its own, without waiting for four Chromiums.
   *
   * The browser tests above prove the adoption moves real cookies; these prove the choice is the
   * right one in the cases that are awkward to build with a real browser — nothing to adopt, a
   * directory that is not a profile, and a decision that has to be the same on the second boot.
   */
  const asProfile = async (dir: string, when: number): Promise<void> => {
    await mkdir(join(dir, "Default"), { recursive: true });
    await writeFile(join(dir, "Default", "Cookies"), "", "utf8");
    await writeFile(join(dir, "Local State"), "{}", "utf8");
    await ageProfile(dir, new Date(when));
  };

  test("the most recently used, with the rest counted and left", async () => {
    const root = await mkdtemp(join(tmpdir(), "laf-adopt-"));
    try {
      await asProfile(join(root, "bot-a"), Date.now() - 10 * 86_400_000);
      await asProfile(join(root, "bot-b"), Date.now() - 86_400_000);
      await asProfile(join(root, "bot-c"), Date.now() - 5 * 86_400_000);

      expect(await resolveProfile(root)).toEqual({
        directory: "bot-b",
        adoptedFrom: "bot-b",
        kept: 2,
      });
      // The other two are still on disk. `kept` is a count of what was left, not of what went.
      expect((await readdir(root)).sort()).toContain("bot-a");
      expect((await readdir(root)).sort()).toContain("bot-c");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the same answer on the next boot, from the pointer rather than the clock", async () => {
    const root = await mkdtemp(join(tmpdir(), "laf-adopt-again-"));
    try {
      await asProfile(join(root, "bot-a"), Date.now() - 10 * 86_400_000);
      await asProfile(join(root, "bot-b"), Date.now() - 86_400_000);
      const first = await resolveProfile(root);
      // Touching the other one must not move the deployment's cookie jar under it.
      await ageProfile(join(root, "bot-a"), new Date());
      expect(await resolveProfile(root)).toEqual(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a directory that is not a profile is not somebody's logins", async () => {
    const root = await mkdtemp(join(tmpdir(), "laf-adopt-empty-"));
    try {
      // A Bot that was driven before its browser ever started leaves exactly this behind.
      await mkdir(join(root, "bot-a"), { recursive: true });
      await writeFile(join(root, "bot-a", "control.json"), "{}", "utf8");
      expect(await resolveProfile(root)).toEqual({
        directory: "shared.profile",
        adoptedFrom: null,
        kept: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a fresh machine starts on a directory no Bot could be called", async () => {
    const root = await mkdtemp(join(tmpdir(), "laf-adopt-fresh-"));
    try {
      const adoption = await resolveProfile(root);
      expect(adoption).toEqual({
        directory: "shared.profile",
        adoptedFrom: null,
        kept: 0,
      });
      // A dot: `isBotId` refuses one, so no Bot anybody creates can collide with this directory.
      expect(adoption.directory).toContain(".");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the wheel, across the upgrade that moved where it is written", () => {
  /**
   * A PERSON HOLDING THE WHEEL MUST NOT HAVE IT TAKEN BY A VERSION BUMP.
   *
   * `control.json` used to live inside the Bot's profile directory; it had to move out when the
   * profile became the deployment's, or five Bots would each be answering "is a person driving"
   * for all of them. The hazard in moving it is one-directional: `createControl`'s default holder
   * is the Bot, so a control file this process cannot find hands a browser back to a Bot while
   * somebody is still standing in front of their bank's login form.
   */
  test("a control file left in the old place is still read", async () => {
    const root = await mkdtemp(join(tmpdir(), "laf-control-upgrade-"));
    try {
      await mkdir(join(root, "old-bot"), { recursive: true });
      await writeFile(
        join(root, "old-bot", "control.json"),
        JSON.stringify({ holder: "human", since: new Date().toISOString() }),
        "utf8",
      );
      const sessions = createSessions({
        stateDirectoryFor: (botId) => join(root, "bot.state", botId),
        legacyStateDirectoryFor: (botId) => join(root, botId),
      });
      expect(sessions.sessionFor("old-bot").control.get().holder).toBe("human");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("and a Bot with no file anywhere still starts with the Bot driving", async () => {
    const root = await mkdtemp(join(tmpdir(), "laf-control-fresh-"));
    try {
      const sessions = createSessions({
        stateDirectoryFor: (botId) => join(root, "bot.state", botId),
        legacyStateDirectoryFor: (botId) => join(root, botId),
      });
      expect(sessions.sessionFor("new-bot").control.get().holder).toBe("bot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
