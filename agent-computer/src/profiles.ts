/**
 * The Bot's browser, and the profile that outlives it.
 *
 * A persistent profile lets a Bot remain signed in across process and container restarts.
 *
 * Persistent context, not a saved storage state. Playwright can export cookies and localStorage as
 * JSON and replay them, and that is the wrong tool here: it captures what the automation knew about,
 * on demand, and misses IndexedDB, service workers, and anything written after the snapshot.
 * `launchPersistentContext` points Chromium at a real user-data directory, so the browser persists
 * its own state the way it does on a desktop. On a mounted volume, that directory outlives the
 * container.
 *
 * Profile behavior in this image and Playwright version:
 *   - A cookie with an expiry survives close-and-reopen. So does localStorage.
 *   - A session cookie (no expiry) does not, and should not: Chromium drops those on restart, exactly
 *     as a desktop browser does. Any "stay signed in" worth the name sets an expiring cookie, but this
 *     is why a site that only ever issues session cookies will still ask a Bot to sign in again.
 *   - Killing the browser process with SIGKILL leaves no stale singleton lock in the profile, and the
 *     profile reopens with its cookies intact. The widely-reported `SingletonLock` breakage does not
 *     reproduce here. The defensive sweep below stays anyway, because it is three lines and the
 *     failure it prevents is "the computer never comes back".
 *
 * One profile per Bot. Two Bots sharing a profile share their logins, which makes "this Bot may reach
 * Salesforce" unenforceable: whatever one signs into, the other is signed into. Each Bot gets its own
 * directory, so its cookies and its storage are its own.
 *
 * A profile is not a container. Two Bots in this process are isolated from each other's cookies, not
 * from each other's kernel, filesystem or memory.
 *
 * Container-per-Bot needs something privileged to create containers, and the API server must never be
 * that: access to the Docker socket is unrestricted root on the host. Stop and reset are
 * operations this process applies to its own browser, so the same design works under Compose,
 * Kubernetes or ECS, where the orchestrator's own restart policy brings a process back.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { egressFor, egressLabel } from "./egress";
import { log } from "./log";

/** The viewport, which is what a person's click coordinates are relative to. */
export const VIEWPORT = { width: 1280, height: 800 };

/**
 * The Bot lives in Korea.
 *
 * Measured before this line existed, inside the shipping image: `navigator.language` was
 * `en-US@posix` and `Intl.DateTimeFormat().resolvedOptions().timeZone` was `UTC`. A Korean site
 * reads both — 네이버 and 홈택스 render dates and some of their navigation from them — so the Bot
 * was browsing a foreign-language, wrong-day version of every page its owner reads in Korean.
 */
const LOCALE = "ko-KR";

/** Where the Bot's clock is, defaulting to Seoul the way the server's own does. */
export function botTimeZone(
  environment: Record<string, string | undefined> = process.env,
): string {
  const wanted = environment.BOT_TIME_ZONE?.trim();
  if (!wanted) return "Asia/Seoul";
  try {
    // A name Chromium would refuse takes the browser down at launch, which would make one typo in a
    // deployment's environment the reason no Bot has a computer. Validated here and ignored if bad,
    // the same decision `botTimeZone` in the server makes for the same variable.
    new Intl.DateTimeFormat("en-US", { timeZone: wanted });
    return wanted;
  } catch {
    log.warn("bot_time_zone_unusable", { value: wanted, using: "Asia/Seoul" });
    return "Asia/Seoul";
  }
}

/**
 * The Chromium this image ships, as the user agent has to spell it.
 *
 * Pinned rather than read from `playwright-core/browsers.json`: that file is not reachable through
 * the package's `exports`, and inside the image `playwright-core` does not resolve from this file at
 * all (measured). The Dockerfile already pins the Playwright version and the base image together
 * — "bump both or neither" — and this is the third thing in that set. It is also self-correcting:
 * the first launch compares this against what the browser actually reports and takes the browser's
 * answer for every launch after it.
 */
const PINNED_CHROMIUM_VERSION = "151.0.7922.34";

/**
 * What the page sees us as.
 *
 * Playwright's headless Chromium reports `HeadlessChrome/151.0.7922.34` (measured in this image).
 * That string is the single cheapest automation signal a site can read, and the sites this product
 * exists for — 스마트스토어, 배민, a bank — answer it with a new-device check or a CAPTCHA, which a
 * Bot cannot pass and which costs its owner a takeover every time.
 *
 * Linux is kept, and deliberately: claiming Windows here would disagree with `navigator.platform`,
 * the client hints Chromium sends alongside, and the fonts the container has. A quiet, consistent
 * Linux Chrome is a better answer than a loud, contradictory Windows one.
 */
export function botUserAgent(version: string): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

/** One tab in a Bot's browser, as the snapshot lists them. */
export type TabSummary = {
  /** Position in the browser's own list, which is what `computer_switch_tab` takes. */
  index: number;
  title: string;
  url: string;
  /** The one the Bot's next action lands on. */
  active: boolean;
};

/** A tab index that names nothing. Its own type so the route can answer 400 rather than 502. */
export class TabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabError";
  }
}

/**
 * How long a Bot's browser may sit untouched before it is closed.
 *
 * Ten minutes. Five Bots on a 6GB VM is five Chromiums, and four of them are usually asleep between
 * a routine at nine and one at noon. Closing an idle one costs the next call a cold start and gives
 * the machine back ~300MB; the cookies are on the volume, so nothing is signed out by it.
 */
const IDLE_CLOSE_MS = 10 * 60_000;

/** How often idleness is checked. Coarse on purpose: this is housekeeping, not a deadline. */
const IDLE_SWEEP_MS = 60_000;

/**
 * Files Chromium uses to refuse a second instance on one profile.
 *
 * Swept on the way in rather than the way out, because the way out is the case that does not happen:
 * a container that is killed does not get to run cleanup. If this process is starting, no browser of
 * ours is running, so any lock here is by definition from a life that has already ended.
 */
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/**
 * How the browser is started, and why each flag is here.
 *
 * `--password-store=basic` makes a durable profile work in a container. Chromium normally encrypts
 * cookie values with a desktop keyring; containers have no stable gnome-keyring or kwallet, so the
 * default fallback can make stored cookies unreadable after restart.
 *
 * `basic` pins it to Chromium's own fixed fallback, which is deterministic and survives restarts.
 * This is obfuscation at rest, not protection. Anything that can read the volume can read the
 * cookies — a login cookie for somebody's bank included. One person per VM is what makes that
 * acceptable, and `docs/laf/browser-limits.md` says so out loud rather than leaving it in a comment.
 * The volume's own permissions are the security boundary.
 *
 * `--disk-cache-size` bounds the one thing in the profile that grows for ever. Without it Chromium
 * sizes its cache from the free space on the volume and the agent-profiles volume is the same disk
 * as Postgres; 100MB per Bot is enough that a portal's images survive between turns and small
 * enough that five Bots cannot fill a 40GB box. Compose left a note saying this belonged to the
 * browser wave because the args are a literal list here rather than read from the environment: it
 * is still a literal list, because a cache size is not a thing a deployment tunes.
 */
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--password-store=basic",
  "--disk-cache-size=104857600",
];

/**
 * How long to let a closing browser finish writing before moving on.
 *
 * The profile's Cookies file may be rewritten shortly after `close()` is called. This delay stays
 * clear of that window while remaining inside the container's
 * 30s stop grace period, so a shutdown never becomes the reason a computer does not come back.
 */
const CLOSE_SETTLE_MS = 2_000;

/** What a Bot's browser looks like from outside. */
export type BotBrowser = {
  botId: string;
  context: BrowserContext;
  page: Page;
};

export type ProfileSummary = {
  botId: string;
  /** Whether a browser is running for this Bot right now. */
  running: boolean;
  /** When this Bot's browser was last started, or null if it is not running. */
  startedAt: string | null;
  /** The proxy its traffic leaves through, by host only. Never the credentials. */
  egress: string | null;
};

/** A moment after the browser process is gone, for whatever it was still flushing. */
const FLUSH_SETTLE_MS = 250;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Close a context and wait for Chromium to actually be gone.
 *
 * Chromium batches cookie writes and commits them as it exits, while `close()` only asks it to exit.
 * Bounded, because a shutdown that hangs must never be the reason a computer does not come back. We
 * would rather lose the last few seconds of cookies than never restart.
 *
 * THE EXIT IS WAITED FOR, NOT ASSUMED. This used to sleep two seconds flat, on the stated grounds
 * that a persistent context exposes no exit signal — but `context.browser()` is not null in this
 * Playwright version (measured), so `disconnected` is exactly that signal. It matters more now that
 * a browser also closes on its own after ten idle minutes: returning from a close before the process
 * has released the profile directory is how two Chromiums end up on one user-data-dir, and the
 * second one comes up in a state where every call hangs until its timeout.
 */
async function closeAndWait(context: BrowserContext): Promise<void> {
  const browser = context.browser();
  const gone = browser
    ? new Promise<void>((resolve) => {
        browser.once("disconnected", () => resolve());
      })
    : null;
  await context.close().catch(() => undefined);
  if (gone) {
    await Promise.race([gone, wait(CLOSE_SETTLE_MS)]);
    await wait(FLUSH_SETTLE_MS);
    return;
  }
  await wait(CLOSE_SETTLE_MS);
}

/** What the process around this wants to know about a page the moment it exists. */
export type ProfileOptions = {
  /**
   * Every page this Bot gets, the first one and every one a site opens afterwards.
   *
   * The hook is how dialogs and downloads are heard: both are per-page listeners, and a `_blank`
   * link means the page a Bot is about to act on is one nothing has attached to yet. Kept as a
   * callback rather than done here so this module stays about lifetimes and `index.ts` stays about
   * behaviour.
   */
  onPage?: (botId: string, page: Page) => void;
  /** Overridable so a test does not have to wait ten minutes to watch a browser close. */
  idleCloseMs?: number;
  now?: () => number;
};

export function createProfiles(root: string, options: ProfileOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
  /**
   * The version the user agent claims, corrected by the first browser that actually starts.
   *
   * A pinned constant that has drifted from the image would be a lie in the one string this exists
   * to make honest, so it is checked against the real thing rather than trusted.
   */
  let chromiumVersion = PINNED_CHROMIUM_VERSION;

  /** One running browser per Bot. */
  const live = new Map<
    string,
    {
      context: BrowserContext;
      page: Page;
      startedAt: string;
      /** When this Bot last had a call. See IDLE_CLOSE_MS. */
      usedAt: number;
    }
  >();
  /** Launches in flight, so a cold computer is started once however many callers ask at once. */
  const starting = new Map<string, Promise<Page>>();
  /**
   * Closes in flight, so a launch cannot start on a profile a browser is still letting go of.
   *
   * The idle sweep made this necessary: a close now happens on a timer rather than only when
   * somebody presses Stop, so a call can arrive in the middle of one. Two Chromiums on a single
   * user-data-dir do not fail loudly — the second comes up and then hangs on everything, which is
   * indistinguishable from a broken site until you look at the process list.
   */
  const closing = new Map<string, Promise<void>>();

  /** Close this Bot's context, and make the wait for it visible to anything that wants to launch. */
  const closeContext = (botId: string, context: BrowserContext) => {
    const done = closeAndWait(context).finally(() => {
      if (closing.get(botId) === done) closing.delete(botId);
    });
    closing.set(botId, done);
    return done;
  };

  const directoryFor = (botId: string): string => join(root, botId);

  const sweepLocks = async (dir: string): Promise<void> => {
    await Promise.all(
      SINGLETON_FILES.map((name) =>
        rm(join(dir, name), { force: true }).catch(() => undefined),
      ),
    );
  };

  const profiles = {
    /**
     * The Bot's page, starting its browser if it is not running.
     *
     * Started on first use rather than at boot, and re-created if it died: a crashed Chromium would
     * otherwise leave this process alive and answering the same error for every request until the
     * container restarts. This turns that into one slow request instead of an outage.
     */
    async page(botId: string): Promise<Page> {
      /*
       * One launch at a time per Bot. Calls that arrive during a launch wait for that launch instead
       * of starting another browser against the same profile directory.
       */
      const launching = starting.get(botId);
      if (launching) return launching;

      const existing = live.get(botId);
      if (existing?.context.browser()?.isConnected()) {
        /*
         * A closed tab is not a dead browser. Somebody's `_blank` window being closed used to take
         * the whole context down with it and start a cold Chromium, because the only page this map
         * held was the closed one. Falling back to whatever is still open is what a person does
         * when they close a tab.
         */
        if (existing.page.isClosed()) {
          const open = existing.context
            .pages()
            .filter((candidate) => !candidate.isClosed());
          const last = open[open.length - 1];
          if (last) existing.page = last;
        }
        if (!existing.page.isClosed()) {
          existing.usedAt = now();
          return existing.page;
        }
      }
      if (existing) {
        // Half-dead: the browser went away, or its page did. Dropped rather than repaired, because a
        // context whose browser has gone is not usable for anything.
        await existing.context.close().catch(() => undefined);
        live.delete(botId);
      }

      const launch = (async () => {
        const dir = directoryFor(botId);
        /*
         * A browser that is still letting go of this profile gets to finish first. The sweep of
         * singleton locks below assumes no browser of ours is running on this directory, and that is
         * only true once the close has actually completed.
         */
        await closing.get(botId)?.catch(() => undefined);
        await sweepLocks(dir);
        const proxy = egressFor(botId, process.env);
        const context = await chromium.launchPersistentContext(dir, {
          args: LAUNCH_ARGS,
          viewport: VIEWPORT,
          locale: LOCALE,
          timezoneId: botTimeZone(),
          userAgent: botUserAgent(chromiumVersion),
          // A download with nowhere to go is refused by Chromium before anything here hears about
          // it, so this is the switch that makes 세금계산서 PDF a thing a Bot can fetch at all. Where
          // the file lands is decided by the `download` listener the page hook attaches.
          acceptDownloads: true,
          // This process owns shutdown. Playwright's signal handlers kill Chromium immediately on
          // SIGTERM, before pending cookie writes have time to flush.
          handleSIGTERM: false,
          handleSIGINT: false,
          handleSIGHUP: false,
          ...(proxy ? { proxy } : {}),
        });
        const reported = context.browser()?.version();
        if (reported && reported !== chromiumVersion) {
          log.warn("chromium_version_drifted", {
            pinned: chromiumVersion,
            actual: reported,
            note: "the user agent this container claims is now the browser's own version",
          });
          chromiumVersion = reported;
        }
        // Persistent contexts open with a page already; reuse it rather than leaving an extra blank tab.
        const page = context.pages()[0] ?? (await context.newPage());
        const entry = {
          context,
          page,
          startedAt: new Date().toISOString(),
          usedAt: now(),
        };
        live.set(botId, entry);
        /*
         * THE NEWEST PAGE BECOMES THE ONE THE BOT IS ON.
         *
         * 네이버 opens half its links with `target=_blank`. Without this the Bot clicked, the page it
         * asked for opened in a tab nothing here held a handle to, and both the Bot and the person
         * watching the screencast went on looking at the page they had left — the click "worked" and
         * nothing about the answer was true. Adopting the newest page is what a person does: the tab
         * that just opened is the one they are looking at.
         */
        context.on("page", (opened) => {
          const current = live.get(botId);
          if (current?.context !== context) return;
          current.page = opened;
          current.usedAt = now();
          options.onPage?.(botId, opened);
        });
        options.onPage?.(botId, page);
        return page;
      })();

      starting.set(botId, launch);
      try {
        return await launch;
      } finally {
        // Cleared whether it worked or not so a failed launch does not pin future calls to a rejected
        // promise.
        starting.delete(botId);
      }
    },

    /** Where this Bot's profile lives, so what must survive a restart can be written beside it. */
    directoryFor,

    /**
     * Every tab this Bot has open, in the browser's own order.
     *
     * Reported on every snapshot rather than only when asked: a Bot that cannot see that a second
     * tab exists cannot decide to go to it, and the tab a click opened is usually the one holding
     * the answer.
     */
    async tabs(botId: string): Promise<TabSummary[]> {
      const running = live.get(botId);
      if (!running) return [];
      const pages = running.context.pages().filter((page) => !page.isClosed());
      return Promise.all(
        pages.map(async (page, index) => ({
          index,
          // A page that navigates while we are describing it costs its title, not the list.
          title: await page.title().catch(() => ""),
          url: page.url(),
          active: page === running.page,
        })),
      );
    },

    /** Move the Bot to one of them. Refuses an index that names nothing rather than picking one. */
    async switchTab(botId: string, index: number): Promise<TabSummary[]> {
      const running = live.get(botId);
      if (!running) {
        throw new TabError("laf:tab_missing");
      }
      const pages = running.context.pages().filter((page) => !page.isClosed());
      const wanted = pages[index];
      if (!wanted) {
        throw new TabError("laf:tab_missing");
      }
      running.page = wanted;
      running.usedAt = now();
      // Chromium keeps rendering a background tab differently — animations pause, some lazy content
      // never loads — so the tab the Bot is on is brought to the front as a person's would be.
      await wanted.bringToFront().catch(() => undefined);
      return profiles.tabs(botId);
    },

    /**
     * Close the browsers nobody has used for a while.
     *
     * Cookies are on the volume, so this signs nothing out: the next call starts the browser again
     * with the same logins. Exposed as well as swept on a timer so a test can move the clock instead
     * of waiting.
     */
    async closeIdle(): Promise<string[]> {
      const deadline = now() - idleCloseMs;
      const stale = [...live.entries()].filter(
        ([, entry]) => entry.usedAt <= deadline,
      );
      for (const [botId] of stale) live.delete(botId);
      await Promise.all(
        stale.map(([botId, entry]) => closeContext(botId, entry.context)),
      );
      if (stale.length) {
        log.info("computer_idle_closed", {
          bots: stale.map(([botId]) => botId),
          idleCloseMs,
        });
      }
      return stale.map(([botId]) => botId);
    },

    /**
     * Close this Bot's browser without touching what it knows.
     *
     * Gracefully, so Chromium flushes its profile. This is what "kill" means for a Bot's computer: the
     * browser stops, the login survives, and the next request starts it again where it left off.
     */
    async stop(botId: string): Promise<boolean> {
      const existing = live.get(botId);
      if (!existing) return false;
      live.delete(botId);
      await closeContext(botId, existing.context);
      return true;
    },

    /**
     * Forget everything this Bot knows and start over.
     *
     * The browser is closed before the directory is deleted: deleting a profile
     * out from under a running Chromium is how you get a browser that is alive, writing to files that
     * no longer exist, and reporting success. Nothing is recreated here, the next request starts a
     * clean browser, which is the same path as a first ever start and so needs no second code path.
     */
    async reset(botId: string): Promise<void> {
      await this.stop(botId);
      await rm(directoryFor(botId), { recursive: true, force: true });
    },

    /**
     * Every Bot that has a computer, whether or not one is running.
     *
     * Read from disk rather than from memory, because a Bot's computer exists as long as its profile
     * does: after a restart nothing is running and every login is still there, and an admin page that
     * listed only live browsers would show an empty screen and imply the logins were gone.
     */
    async known(): Promise<string[]> {
      const onDisk = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      );
      return [
        ...new Set([
          ...onDisk.filter((e) => e.isDirectory()).map((e) => e.name),
          ...live.keys(),
        ]),
      ].sort();
    },

    /** What the admin surface lists. Running or not, because a Bot that has a profile has a computer. */
    summary(botIds: string[]): ProfileSummary[] {
      const known = new Set([...botIds, ...live.keys()]);
      return [...known].sort().map((botId) => {
        const running = live.get(botId);
        return {
          botId,
          running: Boolean(running),
          startedAt: running?.startedAt ?? null,
          egress: egressLabel(botId, process.env),
        };
      });
    },

    /**
     * Close every browser, for shutdown.
     *
     * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait. Closing the contexts
     * here gives Chromium the chance to flush its profile within that grace period.
     */
    async closeAll(): Promise<void> {
      const contexts = [...live.values()];
      live.clear();
      await Promise.all(contexts.map((c) => closeAndWait(c.context)));
    },
  };

  /*
   * The sweep that closes what nobody is using.
   *
   * Unreferenced, so it is never the reason this process stays alive, and started here rather than
   * in `index.ts` because a browser nobody closes is this module's problem. A deployment that wants
   * browsers kept open for ever sets the interval to zero.
   */
  if (idleCloseMs > 0) {
    const sweep = setInterval(() => {
      void profiles.closeIdle().catch((error: unknown) => {
        log.error("computer_idle_sweep_failed", { reason: error });
      });
    }, IDLE_SWEEP_MS);
    sweep.unref?.();
  }

  return profiles;
}

export type Profiles = ReturnType<typeof createProfiles>;
