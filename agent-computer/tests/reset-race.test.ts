import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright";
import { createProfiles } from "../src/profiles";

/**
 * A RESET HAS THE PROFILE TO ITSELF, FROM ITS FIRST STEP TO ITS LAST.
 *
 * Reset closes the browser and then deletes the profile, and the only thing a launch waited for was
 * a close in flight — which is over before the delete begins. So anything that asked for a page
 * meanwhile (the live screen asks every second, a Bot mid-task asks on its next step) started
 * Chromium on a profile that was being deleted (upstream OpenBot #554, whose browsers are per Bot;
 * here there is one for the deployment, so there is one reset to wait for). Two more ways onto the
 * profile during a reset were found on the way, and are the same defect: a launch already under way
 * when the reset arrives, and a close already under way.
 *
 * WHAT IT COST, MEASURED 2026-10-02 WITH A REAL CHROMIUM before the fix: on a profile holding 6,000
 * cache files the page was handed out 438 ms into a reset that took 671, and its browser was signed
 * in — and still signed in after the reset had answered. On a profile of 600 files the delete won
 * and nothing showed, which is why most of this file has NO BROWSER in it: what is asserted is the
 * ORDER the launcher, the close and the delete happen in, and a real Chromium shows that only when
 * the profile is big enough. The launcher is Playwright's own, replaced for the length of each
 * test; everything else is `profiles.ts` as it runs, on a real directory. The last test is the real
 * thing, cookie and all.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const BOT = "reset-bot";

/** A browser as `profiles.ts` uses one: something that launches, opens tabs, and closes. */
function stubbedBrowser(options: { closeTakesMs?: number } = {}) {
  let connected = true;
  let failing = false;
  let onGone: (() => void) | null = null;
  let closeBegan: () => void = () => undefined;
  const state = {
    closed: false,
    /** Resolves when `close()` has been asked for — the browser is on its way out. */
    closing: new Promise<void>((resolve) => {
      closeBegan = resolve;
    }),
    /** From now on the browser cannot even be asked about: what makes a close throw. */
    breakIt: () => {
      failing = true;
    },
  };
  const page = () => {
    let closed = false;
    return {
      isClosed: () => closed || !connected,
      once: () => undefined,
      close: async () => {
        closed = true;
      },
    };
  };
  const pages: ReturnType<typeof page>[] = [];
  const browser = {
    // The version `profiles.ts` pins, so the launch says nothing about drift.
    version: () => "151.0.7922.34",
    isConnected: () => connected,
    once: (_event: string, handler: () => void) => {
      onGone = handler;
    },
    newBrowserCDPSession: async () => {
      throw new Error("a stub has no DevTools");
    },
  };
  const context = {
    browser: () => {
      if (failing) throw new Error("the browser is beyond asking");
      return browser;
    },
    on: () => context,
    pages: () => pages.filter((each) => !each.isClosed()),
    newPage: async () => {
      if (!connected) throw new Error("Target page, context or browser closed");
      const opened = page();
      pages.push(opened);
      return opened;
    },
    close: async () => {
      closeBegan();
      await Bun.sleep(options.closeTakesMs ?? 0);
      connected = false;
      state.closed = true;
      onGone?.();
    },
  };
  return { context: context as unknown as BrowserContext, state };
}

/** Cache files, so that deleting the profile takes the time it takes on one that has been used. */
async function fatten(
  profileDir: string,
  folders: number,
  filesEach: number,
): Promise<void> {
  for (let folder = 0; folder < folders; folder += 1) {
    const dir = join(profileDir, "Default", "Cache", `f_${folder}`);
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: filesEach }, (_, index) =>
        writeFile(join(dir, `entry_${index}`), "x".repeat(2_048)),
      ),
    );
  }
}

/** What stands for somebody's logins where there is no browser to hold any: the cookie jar itself. */
async function signIn(profileDir: string): Promise<void> {
  await mkdir(join(profileDir, "Default"), { recursive: true });
  await writeFile(join(profileDir, "Default", "Cookies"), "naver=signed-in");
  await writeFile(join(profileDir, "Local State"), "{}");
  await fatten(profileDir, 20, 20);
}

describe("a reset and everything else that wants the profile", () => {
  let root = "";
  let launcher: ReturnType<typeof spyOn> | null = null;
  /** Every launch, in order: which browser it handed out, and what it was started on. */
  let launches: {
    browser: ReturnType<typeof stubbedBrowser>;
    whileResetting: boolean;
    onLogins: boolean;
  }[] = [];
  /** Set by a test that wants the next launch held open, the way a real start takes time. */
  let hold: Promise<void> | null = null;
  let launchBegan: () => void = () => undefined;
  /** How many resets are in flight. */
  let resetting = 0;
  let cookies = "";
  let closeTakesMs = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "laf-reset-race-"));
    launches = [];
    hold = null;
    resetting = 0;
    closeTakesMs = 0;
    cookies = join(root, "shared.profile", "Default", "Cookies");
    launcher = spyOn(chromium, "launchPersistentContext").mockImplementation(
      async (dir: string) => {
        const browser = stubbedBrowser({ closeTakesMs });
        launches.push({
          browser,
          whileResetting: resetting > 0,
          onLogins: existsSync(cookies),
        });
        launchBegan();
        await hold;
        // What Chromium does first: make the directory it was pointed at.
        await mkdir(join(dir, "Default"), { recursive: true });
        return browser.context;
      },
    );
  });

  afterEach(async () => {
    // Other files in this run launch a real Chromium through the same object.
    launcher?.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  /** A reset, counted for exactly as long as it is in flight. */
  const reset = (profiles: ReturnType<typeof createProfiles>, bot = BOT) => {
    resetting += 1;
    return profiles.reset(bot).finally(() => {
      resetting -= 1;
    });
  };

  test("a page asked for during a reset gets a browser started after it, on a profile with no logins", async () => {
    const profiles = createProfiles(root, { idleCloseMs: 0 });
    await profiles.page(BOT);
    await signIn(join(root, "shared.profile"));

    const done = reset(profiles);
    // A thumbnail poll, the live screen's follow, a Bot's next step: anything that wants a page.
    await profiles.page(BOT);
    await done;

    expect(
      launches.map(({ whileResetting, onLogins }) => ({
        whileResetting,
        onLogins,
      })),
    ).toEqual([
      { whileResetting: false, onLogins: false },
      { whileResetting: false, onLogins: false },
    ]);
    expect(existsSync(cookies)).toBe(false);
    await profiles.closeAll();
  });

  test("two resets and a page between them: the browser still starts after the last delete", async () => {
    const profiles = createProfiles(root, { idleCloseMs: 0 });
    await profiles.page(BOT);
    await signIn(join(root, "shared.profile"));

    const first = reset(profiles);
    const second = reset(profiles, "another-bot");
    await profiles.page(BOT);
    await Promise.all([first, second]);

    expect(launches.map(({ whileResetting }) => whileResetting)).toEqual([
      false,
      false,
    ]);
    await profiles.closeAll();
  });

  test("a reset that arrives while the browser is starting waits for it, and closes what it started", async () => {
    const profiles = createProfiles(root, { idleCloseMs: 0 });
    const began = new Promise<void>((resolve) => {
      launchBegan = resolve;
    });
    const started = Promise.withResolvers<void>();
    hold = started.promise;
    const asking = profiles.page(BOT).catch(() => "its browser was reset");
    await began;

    let settled = false;
    const done = reset(profiles).then(() => {
      settled = true;
    });
    // A reset that does not wait is a few file operations on an empty root: long over by now.
    await Bun.sleep(150);
    expect(settled).toBe(false);

    started.resolve();
    await done;
    await asking;
    // The browser that start produced is not left running on the profile that was just deleted.
    expect(launches).toHaveLength(1);
    expect(launches[0]?.browser.state.closed).toBe(true);
    await profiles.closeAll();
  });

  test("a reset that arrives while the browser is closing waits for it to be gone", async () => {
    const profiles = createProfiles(root, { idleCloseMs: 0 });
    closeTakesMs = 150;
    await profiles.page(BOT);
    const browser = launches[0]?.browser;
    if (!browser) throw new Error("no browser was started");

    // The last tab going is what closes the browser (`closeIfUnused`): the idle sweep does the same.
    const stopping = profiles.stop(BOT);
    await browser.state.closing;
    expect(browser.state.closed).toBe(false);

    await reset(profiles);
    // Deleting under a browser still flushing its profile is the half-true reset the comment on
    // `reset` warns about.
    expect(browser.state.closed).toBe(true);
    await stopping;
  });

  test("a reset that fails does not leave the next call waiting for ever", async () => {
    const profiles = createProfiles(root, { idleCloseMs: 0 });
    await profiles.page(BOT);
    launches[0]?.browser.state.breakIt();

    await expect(reset(profiles)).rejects.toThrow("beyond asking");

    const next = await Promise.race([
      profiles.page(BOT).then(() => "a page"),
      Bun.sleep(2_000).then(() => "still waiting"),
    ]);
    expect(next).toBe("a page");
    expect(launches).toHaveLength(2);
    await profiles.closeAll();
  });
});

describe.skipIf(!HAS_BROWSER)("with a real Chromium", () => {
  test("a login does not survive a reset that a page was asked for during", async () => {
    const site = "https://example.test";
    const root = await mkdtemp(join(tmpdir(), "laf-reset-real-"));
    const profiles = createProfiles(root, { idleCloseMs: 0 });
    try {
      const first = await profiles.page(BOT);
      await first.context().addCookies([
        {
          name: "session",
          value: "signed-in",
          url: site,
          expires: Math.floor(Date.now() / 1000) + 86_400,
        },
      ]);
      // Closed, so the cookie is in the profile on disk; then a profile the size of a used one.
      await profiles.stop(BOT);
      await fatten(profiles.profileDirectory(), 30, 200);
      const reopened = await profiles.page(BOT);
      expect(await reopened.context().cookies(site)).toHaveLength(1);

      const done = profiles.reset(BOT);
      const during = await profiles.page(BOT);
      // Read at once, as a Bot's next step would: Chromium loads its cookies on first use.
      const atOnce = await during.context().cookies(site);
      await done;
      const afterwards = await during.context().cookies(site);

      expect({
        signedInAtOnce: atOnce.length,
        signedInAfterTheReset: afterwards.length,
      }).toEqual({ signedInAtOnce: 0, signedInAfterTheReset: 0 });
    } finally {
      await profiles.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
