/**
 * THE BROWSERS THIS COMPUTER HOLDS: THE MAIN ONE, AND A FEW IN THE BACKGROUND
 * (2026-10-10, `docs/laf/redesign-2026-10.md` §5, piece 5-3).
 *
 * There was one browser for the deployment, and everything beside it — whose tab is whose, what a
 * Bot last looked at, who has the wheel — was kept per Bot. That is still the main browser, exactly:
 * the person's logins on the volume, the screen a person watches. What is new is that the same
 * arrangement can stand more than once. A background browser is a second copy of all of it — its
 * own Chromium, its own tabs, its own sessions — on a profile directory made for it and thrown
 * away with it. "A Bot" was the unit; "a Bot in a browser" is.
 *
 * NAMED BY THE CALLER, IN A HEADER ({@link BROWSER_HEADER}). A request that names no browser is
 * the main one's, so every caller from before this file is answered as it was.
 *
 * OPENED AND LET GO OF BY NAME, BY WHOEVER WANTS ONE (`open`, `release`). A call that names a
 * browser nobody opened is a request with an unusable part, not a reason to start a Chromium: a
 * name mistyped once would otherwise hold a place until something noticed.
 *
 * A BACKGROUND BROWSER HAS NO LOGINS. Two Chromiums cannot share a user-data directory — the second
 * comes up and hangs (`profiles.ts`) — so each background one starts empty and signs in, where it
 * has to, with a saved login the server fills (§6). A site that asks a new device to prove itself
 * is a site it stops at.
 *
 * ROOM IS A NUMBER, AND PAST IT THE ANSWER TO `open` IS NO ({@link BACKGROUND_BROWSERS}). An answer,
 * not a failure and not a queue: the caller that was told no knows what it was about to do and how
 * long that is worth waiting for, and this process does not.
 *
 * A PLACE NOBODY IS USING IS GIVEN TO THE NEXT ONE ASKED FOR: a browser with no call in it, no Bot
 * on a tab, and nothing asked of it for as long as an unused tab is kept ({@link UNUSED_MS}). That
 * is what a caller that died without letting go leaves behind, and nothing else would ever free it.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Computer } from "./computer";
import { IDLE_CLOSE_MS } from "./tabs";

/** The header that names the browser a call is for. Absent: the main one. */
export const BROWSER_HEADER = "x-openbot-browser";

/**
 * How many background browsers may be open at once.
 *
 * MEASURED, AND IT IS THE MOST THERE IS ROOM FOR, NOT A COMFORTABLE NUMBER (2026-10-10, this image
 * as a container under the service's own `mem_limit: 3g`, `docker stats`, 11번가's front page in
 * every tab — the heaviest page of the four this product is measured on):
 *
 *     nothing open                                   167 MiB    23 processes
 *     the main browser, six tabs (a Bot's whole cap)  2.09 GiB   251
 *     and one background browser, one tab             2.77 GiB   380
 *     and a second                                    2.85 GiB   517
 *     (one let go of, and a third opened)             2.97 GiB   512
 *
 * A browser of its own with one such tab is about 0.7 GiB and 130 processes. So with the main
 * browser as full as one Bot can make it, one background browser fits and the second is the end of
 * the limit — past it the kernel takes a renderer, which a Bot is told as a dead tab. On ordinary
 * pages (a tab is 130–140 MiB in `docs/laf/browser-limits.md`, three in ten more since the full
 * Chromium) all of this is under 2 GiB. A third is never opened: on the heavy pages there is no
 * memory for it, and the process limit (1,024) is half spent at two.
 *
 * WHAT IT DOES NOT BOUND is how many tabs a background browser holds: a Bot's cap there is the same
 * six (`tabs.ts`). Nothing opens one yet; whoever first does should hold it to fewer.
 */
export const BACKGROUND_BROWSERS = 2;

/**
 * How long a background browser may go unused before its place is given away: as long as a tab
 * nobody uses is kept (`IDLE_CLOSE_MS` in `tabs.ts`), which is when its own tabs would be gone.
 */
export const UNUSED_MS = IDLE_CLOSE_MS;

/** What a background profile's directory is called, so a start can find the ones a crash left. */
const ROOT_PREFIX = "laf-browser-";

const BROWSER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A name, not a path: it is logged and never joined into one. */
export function isBrowserName(value: unknown): value is string {
  return typeof value === "string" && BROWSER_NAME.test(value);
}

export type Browsers = {
  /** The deployment's own browser: the logins, and the screen a person watches. */
  main: Computer;
  /**
   * Open a background browser under a name, or say there is no room. True where one is open under
   * the name when this returns — newly, or already.
   */
  open(name: string): boolean;
  /**
   * The browser a call is for: the main one where it names none, the one open under the name, or
   * null where none is. A call that was handed a browser says when it is over ({@link Browsers.left}).
   */
  take(name: string | null): Computer | null;
  /** The call `take` answered is over. Until then its browser is nobody's to make room with. */
  left(name: string | null): void;
  /** Close a background browser and forget it. False where nothing was open under the name. */
  release(name: string): Promise<boolean>;
  /** Every browser, the main one included: what a shutdown and a lost firewall both need. */
  closeAll(): Promise<void>;
  /** The background browsers open now, by name. */
  names(): string[];
  /** How many may be open at once. */
  cap: number;
};

export type BrowsersOptions = {
  main: Computer;
  /** Everything a browser needs beside it, built on a profile root of its own. */
  seatAt: (root: string, name: string) => Computer;
  cap?: number;
  /** Where a background browser's profile is made. A test names its own. */
  under?: string;
  /** How long a place may go unused before the next browser asked for is given it. */
  unusedMs?: number;
  now?: () => number;
  log?: (event: string, facts: Record<string, unknown>) => void;
};

export function createBrowsers(options: BrowsersOptions): Browsers {
  const cap = options.cap ?? BACKGROUND_BROWSERS;
  const under = options.under ?? tmpdir();
  const unusedMs = options.unusedMs ?? UNUSED_MS;
  const now = options.now ?? (() => Date.now());
  const say = options.log ?? (() => undefined);
  /**
   * `calls`: how many calls are being carried out in the browser right now. `usedAt`: when it was
   * opened, or when the last of them ended.
   */
  const open = new Map<
    string,
    { seat: Computer; root: string; calls: number; usedAt: number }
  >();

  const release = async (name: string): Promise<boolean> => {
    const held = open.get(name);
    if (!held) return false;
    // Forgotten first: a call that arrives while the browser closes is told nothing is open
    // under the name rather than being handed the one on its way out.
    open.delete(name);
    await held.seat.profiles.closeAll().catch(() => undefined);
    await rm(held.root, { recursive: true, force: true }).catch(
      () => undefined,
    );
    say("browser_released", { browser: name, open: open.size });
    return true;
  };

  /*
   * NOT BY TABS ALONE. A browser is opened before the first call into it, and that call has not
   * opened its tab when the next `open` arrives: counted by tabs, the second took the first one's
   * place and closed a browser with a navigation on its way into it. So a place is unused only
   * with no call in it, no Bot on a tab, and nothing asked of it for a while.
   */
  const unused = (): string | undefined =>
    [...open].find(
      ([, held]) =>
        held.calls === 0 &&
        now() - held.usedAt >= unusedMs &&
        held.seat.profiles.liveBots().length === 0,
    )?.[0];

  return {
    main: options.main,
    cap,

    open(name) {
      const held = open.get(name);
      if (held) {
        held.usedAt = now();
        return true;
      }
      if (open.size >= cap) {
        const spare = unused();
        if (spare === undefined) {
          say("browsers_full", { asked: name, open: open.size, cap });
          return false;
        }
        // Its place is taken now; closing it is not something the new browser waits for.
        void release(spare);
      }
      /*
       * SYNCHRONOUS UP TO HERE, ON PURPOSE. Counting and taking the place happen in one turn of
       * the loop, so two calls arriving together for two new names cannot both be told there is
       * room for the last one.
       */
      const root = mkdtempSync(join(under, ROOT_PREFIX));
      const seat = options.seatAt(root, name);
      open.set(name, { seat, root, calls: 0, usedAt: now() });
      say("browser_opened", { browser: name, open: open.size, cap });
      return true;
    },

    take(name) {
      if (name === null) return options.main;
      const held = open.get(name);
      if (!held) return null;
      held.calls += 1;
      return held.seat;
    },

    left(name) {
      const held = name === null ? undefined : open.get(name);
      if (!held) return;
      if (held.calls > 0) held.calls -= 1;
      held.usedAt = now();
    },

    release,

    async closeAll() {
      await Promise.all([
        options.main.profiles.closeAll(),
        ...[...open.keys()].map((name) => release(name)),
      ]);
    },

    names: () => [...open.keys()],
  };
}

/**
 * A computer with its one browser and no room for another: what this process was before background
 * browsers, and what a test that builds a computer by hand hands the door.
 */
export function soleBrowser(main: Computer): Browsers {
  return createBrowsers({
    main,
    cap: 0,
    seatAt: () => {
      throw new Error("This computer has no room for a background browser.");
    },
  });
}

/**
 * The profile directories a process that died left behind. Called once, before any browser: a
 * container that restarts keeps its `/tmp`, and nothing else would ever remove them.
 */
export async function sweepBackgroundProfiles(
  under: string = tmpdir(),
): Promise<number> {
  let names: string[] = [];
  try {
    names = readdirSync(under).filter((name) => name.startsWith(ROOT_PREFIX));
  } catch {
    return 0;
  }
  await Promise.all(
    names.map((name) =>
      rm(join(under, name), { recursive: true, force: true }).catch(
        () => undefined,
      ),
    ),
  );
  return names.length;
}
