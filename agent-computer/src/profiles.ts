/**
 * The Bot's browser, and the profile the whole deployment shares.
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
 *     reproduce here. The defensive sweep (`profile-dir.ts`) stays anyway, because it is three lines
 *     and the failure it prevents is "the computer never comes back".
 *
 * ONE PROFILE FOR THE DEPLOYMENT, NOT ONE PER BOT (decided 2026-09-16, reversing what this comment
 * said before). A deployment is one person's machine — `docs/laf/deployment-model.md`, and its second
 * invariant already says a profile is "편의이자 감사 단위이지, 경계가 아니다": a convenience and an
 * audit unit, never a boundary. The person's reason is the one that decided it: they should authorise
 * a site once, not once per Bot. So every Bot opens the same Chromium user-data directory, and a site
 * one Bot signed into is signed in for the others — which is what the product has promised on the
 * onboarding screen the whole time ("봇들은 진짜 브라우저 하나를 함께 씁니다").
 *
 * WHAT THAT TRADED AWAY, said plainly rather than left for somebody to find:
 *
 *   - "This Bot may reach Salesforce and that one may not" is no longer enforceable by the profile.
 *     It never was a boundary, but it WAS a speed bump, and the speed bump is gone: whatever one Bot
 *     signs into, the others are signed into. What keeps a Bot in bounds is the boundary in front of
 *     it — the policy, the approval, the standing allowance — and nothing else.
 *   - ONE BROWSER, SO ONE EGRESS. A profile directory can only be opened by one Chromium at a time,
 *     so sharing the cookie jar means sharing the process, and a proxy is chosen once at launch.
 *     `EGRESS_PROXY_<BOT>` cannot be honoured by a browser that belongs to every Bot; only
 *     `EGRESS_PROXY_DEFAULT` is read now, and `egress.ts` warns at launch when a per-Bot variable is
 *     set so a deployment is never quietly browsing from an address it did not choose.
 *   - Resetting is the whole computer's. `/computers/reset` empties the one profile every Bot uses,
 *     so it signs ALL of them out. `computer-routes.ts` and the app's words say so.
 *
 * WHAT DID NOT CHANGE. Each Bot still keeps its own TABS — `owners` in tabs.ts — because two Bots
 * can act at once (`server/src/runner/bot-lane.ts` queues per Bot, not per account) and sharing one
 * tab would put one Bot's click on the other's page and each one's snapshot stale under the other.
 * Sharing logins is the decision; sharing the thing being looked at is not.
 *
 * A profile is not a container. Two Bots in this process are isolated from each other's kernel,
 * filesystem or memory by nothing at all, and now from each other's cookies by nothing either.
 *
 * Container-per-Bot needs something privileged to create containers, and the API server must never be
 * that: access to the Docker socket is unrestricted root on the host. Stop and reset are
 * operations this process applies to its own browser, so the same design works under Compose,
 * Kubernetes or ECS, where the orchestrator's own restart policy brings a process back.
 *
 * THIS FILE COMPOSES; ITS PARTS LIVE BESIDE IT. What the browser says it is (`browser-identity.ts`),
 * how it is started (`browser-launch.ts`) and ended (`browser-close.ts`), where its profile is on
 * disk (`profile-dir.ts`) and a Bot's tabs in it (`tabs.ts`). What is here is the state that ties
 * them together — the one browser, the launch, the close and the reset in flight — and the calls
 * the routes make.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { Coordinates } from "../../shared/whereabouts";
import { isBotId } from "./authorisation";
import {
  browserPidOf,
  closeAndWait,
  RECYCLE_STEP_MS,
  wait,
} from "./browser-close";
import { botTimeZone, PINNED_CHROMIUM_VERSION } from "./browser-identity";
import { LAUNCH_WAIT_MS, launchBrowser } from "./browser-launch";
import { keepChildProcesses } from "./child-processes";
import { deploymentEgress, deploymentEgressLabel } from "./egress";
import { saysRendererDied } from "./respond";
import { log } from "./log";
import {
  DEFAULT_PROFILE_DIR,
  type ProfileAdoption,
  resolveProfile,
  STATE_DIR,
  sweepLocks,
  writePointer,
} from "./profile-dir";
import { createTabs, IDLE_CLOSE_MS, IDLE_SWEEP_MS, type TabLost } from "./tabs";
import { samePlace, type Whereabouts } from "./whereabouts";
import { within } from "./within";

/** How long the browser is given to say whether a tab's renderer is gone. See `deadTab`. */
const CONFIRM_DEAD_MS = 1_000;

export type ProfileSummary = {
  botId: string;
  /** Whether this Bot has a tab open in the deployment's browser right now. */
  running: boolean;
  /** When this Bot's first tab was opened, or null if it has none. */
  startedAt: string | null;
  /**
   * The proxy the browser's traffic leaves through, by host only. Never the credentials.
   *
   * The same answer for every Bot, and that is the point: one profile is one browser is one proxy.
   */
  egress: string | null;
};

/** What the process around this wants to know about a page the moment it exists. */
export type ProfileOptions = {
  /**
   * Every page a Bot gets, the first one and every one a site opens afterwards.
   *
   * The hook is how dialogs and downloads are heard: both are per-page listeners, and a `_blank`
   * link means the page a Bot is about to act on is one nothing has attached to yet. Kept as a
   * callback rather than done here so this module stays about lifetimes and `index.ts` stays about
   * behaviour.
   */
  onPage?: (botId: string, page: Page) => void;
  /**
   * The tab a Bot was on has gone from under it: its renderer died, or its site closed it.
   *
   * Said the moment it happens, to whoever keeps what the Bot knows of its page (`index.ts`): the
   * Bot's next call lands on another tab — one it has open, or a new one — and nothing it knew
   * about the page it was on is true of that one. This module only moves the tab; what a Bot may
   * do before it has looked at where it is now is the session's to decide (`tab-loss.ts`).
   */
  onTabLost?: (botId: string, lost: TabLost) => void;
  /**
   * Whether a tab of a Bot's is held open by something this module does not keep: a person with
   * the wheel, a live screen casting it, a value or a hand the Bot asked for on it (`tab-cap.ts`).
   * Asked when the Bot is over its number of tabs, and a tab that is held is not the one closed.
   */
  holdsTab?: (botId: string, page: Page) => boolean;
  /**
   * The browser, the moment it exists and before its first page is handed out.
   *
   * NAMES NO BOT, because the browser belongs to none of them. What goes here has to cover EVERY
   * page EVERY Bot will ever have, including the ones a site opens by itself: something attached to
   * a page misses the popup the next click opens, and something attached per Bot would miss the
   * other four. Awaited, so nothing is navigated before it is in place, and a hook that throws fails
   * the launch — the browser is closed rather than handed out without it.
   */
  onContext?: (context: BrowserContext) => Promise<void> | void;
  /**
   * Asked before the browser is handed to anybody, running or not, and throws to refuse it.
   *
   * On the way to an existing browser as well as a new one, because what it guards — the host's
   * egress firewall (egress-guard.ts) — can go away under a browser that is already open, and a tab
   * handed out on it would be the page this whole arrangement exists to stop.
   */
  beforeBrowser?: () => Promise<void>;
  /**
   * Told once, when an existing per-Bot profile was taken over as the deployment's.
   *
   * Given the Bot whose call caused the first launch, because that is who is owed the explanation:
   * it is about to be looking at somebody else's cookie jar, on purpose.
   */
  onProfileAdopted?: (botId: string, adoption: ProfileAdoption) => void;
  /** Overridable so a test does not have to wait ten minutes to watch a browser close. */
  idleCloseMs?: number;
  now?: () => number;
};

export function createProfiles(root: string, options: ProfileOptions = {}) {
  /*
   * Before the first browser, so no browser this module ever launches can have its DevTools pipe
   * closed by the garbage of one it closed earlier. See child-processes.ts: measured, five Bots'
   * browsers at once, dead within seconds of launch, every second run.
   */
  keepChildProcesses();
  const now = options.now ?? (() => Date.now());
  const idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
  /**
   * The version the user agent claims, corrected by the first browser that actually starts.
   *
   * A pinned constant that has drifted from the image would be a lie in the one string this exists
   * to make honest, so it is checked against the real thing rather than trusted.
   */
  let chromiumVersion = PINNED_CHROMIUM_VERSION;

  /** Which directory the browser opens. Resolved once, on the first launch. */
  let adoption: ProfileAdoption | null = null;
  /** So the adoption is announced to one Bot, once, and not on every relaunch after an idle close. */
  let adoptionTold = false;

  /** The one browser this deployment has, while it is running. */
  let shared: {
    context: BrowserContext;
    startedAt: string;
    /** The browser process, for the close that has to end it. See closeAndWait. */
    pid: number | null;
    /** The zone it was started on, which cannot change while it runs. See whereabouts.ts. */
    timeZone: string;
    /** The place it is showing sites right now, null for none. */
    geolocation: Coordinates | null;
  } | null = null;

  /**
   * Where the person is, as the server last said (whereabouts.ts). Read by every launch, so the
   * browser a Bot's first call starts is already on the person's clock and in their place.
   */
  const wanted: {
    timeZone: string | undefined;
    geolocation: Coordinates | null;
  } = { timeZone: undefined, geolocation: null };
  const wantedZone = (): string => wanted.timeZone ?? botTimeZone();

  /** The launch in flight, so a cold computer is started once however many Bots ask at once. */
  let starting: Promise<BrowserContext> | null = null;
  /**
   * The close in flight, so a launch cannot start on a profile a browser is still letting go of.
   *
   * Two Chromiums on a single user-data-dir do not fail loudly — the second comes up and then hangs
   * on everything, which is indistinguishable from a broken site until you look at the process list.
   * It mattered when each Bot had its own directory and it matters more now that they all have this
   * one.
   */
  let closing: Promise<void> | null = null;
  /**
   * The reset in flight, so a launch cannot start on a profile that is being deleted.
   *
   * `closing` did not cover it: a reset's close is over, and `closing` cleared, BEFORE its delete
   * begins. A page asked for meanwhile — the live screen asks every second, a Bot mid-task on its
   * next step — waited for the close and then started Chromium beside the delete. Measured
   * 2026-10-02 with a real Chromium on a profile of 6,000 cache files: the page was handed out
   * 438 ms into a reset that took 671, its browser was signed in, and it was still signed in after
   * the reset had answered — the one thing the button is pressed to end. (On 600 files the delete
   * won, and nothing showed.) Upstream OpenBot #554, which keeps one such promise per Bot; there is
   * one browser here, so there is one.
   *
   * Never rejects, and cleared when the reset ends however it ends: a reset that failed must not
   * be the reason no browser ever starts again.
   */
  let resetting: Promise<void> | null = null;

  /** Which tab is whose. See tabs.ts. */
  const {
    owners,
    live,
    hasCrashed,
    isSpare,
    hear,
    died,
    pagesOf,
    own,
    touch,
    use,
    closeTabsOf,
    closeStrays,
    adoptOpened,
    tabs,
    cappedOf,
    listRead,
    switchTab,
  } = createTabs({
    pages: () => shared?.context.pages() ?? [],
    now,
    // Read when a page arrives rather than now, as it always was.
    onPage: (botId, page) => options.onPage?.(botId, page),
    onLost: (botId, lost) => options.onTabLost?.(botId, lost),
    holds: (botId, page) => options.holdsTab?.(botId, page) ?? false,
    /*
     * Asked of the browser about the tab, on a session of its own: no line of the page runs, so
     * no page can say it of itself. A failure is the caller's to read as "not known" (tabs.ts).
     */
    reportsToOpener: async (page) => {
      const session = await page.context().newCDPSession(page);
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        return targetInfo.canAccessOpener;
      } finally {
        void session.detach().catch(() => undefined);
      }
    },
  });

  const profileDirectory = (): string =>
    join(root, adoption?.directory ?? DEFAULT_PROFILE_DIR);

  /**
   * Where this Bot's own state goes — who has the wheel, and nothing else.
   *
   * NOT the profile directory any more, and that is the whole point of it having a name of its own:
   * `control.json` is per Bot and the cookies are not, so writing one inside the other would have
   * five Bots overwriting each other's answer to "is a person driving right now".
   */
  const stateDirectoryFor = (botId: string): string =>
    join(root, STATE_DIR, botId);

  /**
   * Where a Bot's control state was kept before the profile was shared.
   *
   * Read-only, and only as a fallback (`sessions.ts`). A person holding the wheel when the container
   * was upgraded must not have it handed back to the Bot by the upgrade: `createControl`'s default
   * holder is the Bot, so a control file this process cannot find is a control file that silently
   * makes control looser — the one direction `restoredControl` exists to refuse.
   */
  const legacyStateDirectoryFor = (botId: string): string => join(root, botId);

  /** Close the browser itself, and make the wait for it visible to anything that wants to launch. */
  const closeBrowser = (): Promise<void> => {
    const running = shared;
    shared = null;
    live.clear();
    owners.clear();
    if (!running) return Promise.resolve();
    const done = closeAndWait(running.context, { pid: running.pid }).finally(
      () => {
        if (closing === done) closing = null;
      },
    );
    closing = done;
    return done;
  };

  /** Once nobody has a tab, nobody needs a browser: ~300MB back until the next call. */
  const closeIfUnused = async (): Promise<void> => {
    if (live.size === 0 && shared) await closeBrowser();
  };

  /**
   * The deployment's browser, started if it is not running.
   *
   * Started on first use rather than at boot, and re-created if it died: a crashed Chromium would
   * otherwise leave this process alive and answering the same error for every request until the
   * container restarts. This turns that into one slow request instead of an outage.
   */
  const browserFor = async (botId: string): Promise<BrowserContext> => {
    await options.beforeBrowser?.();
    const running = starting;
    if (running) return running;
    if (shared?.context.browser()?.isConnected()) return shared.context;
    if (shared) {
      // Half-dead: the browser went away and left its tabs behind. Dropped rather than repaired,
      // because a context whose browser has gone is not usable for anything.
      await shared.context.close().catch(() => undefined);
      shared = null;
      live.clear();
      owners.clear();
    }

    const launch = (async () => {
      /*
       * The reset under way as this launch begins, read before the first wait and waited for
       * below. One that arrives later is not this launch's to wait for: it waits for this launch
       * instead (`reset`), and each waiting for the other would be both waiting for ever.
       */
      const reset = resetting;
      /*
       * A browser that is still letting go of this profile gets to finish first. The sweep of
       * singleton locks below assumes no browser of ours is running on this directory, and that is
       * only true once the close has actually completed.
       */
      await closing?.catch(() => undefined);
      await reset;
      adoption ??= await resolveProfile(root);
      const dir = profileDirectory();
      await sweepLocks(dir);
      const proxy = deploymentEgress(process.env);
      // Read once, so the browser is started on exactly what `shared` below says it was started on.
      const timeZone = wantedZone();
      const geolocation = wanted.geolocation;
      const context = await launchBrowser(dir, {
        timeZone,
        geolocation,
        chromiumVersion,
        proxy,
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
      // Before any page is handed out, because the first thing done with a page is a navigation.
      try {
        await options.onContext?.(context);
      } catch (error) {
        await closeAndWait(context).catch(() => undefined);
        throw error;
      }
      shared = {
        context,
        startedAt: new Date().toISOString(),
        pid: await browserPidOf(context),
        timeZone,
        geolocation,
      };
      // A tab a site opens goes to the Bot whose click opened it (tabs.ts, `adoptOpened`).
      context.on("page", adoptOpened);
      // And the tab the browser starts with is listened to as every later one is: it is nobody's
      // until a Bot takes it, and one that died meanwhile must not be the one handed out.
      for (const page of context.pages()) hear(page);
      if (adoption.adoptedFrom && !adoptionTold) {
        adoptionTold = true;
        log.info("profile_adopted", {
          adopted: adoption.adoptedFrom,
          kept: adoption.kept,
          note: "the Bots share one browser profile; the rest were left where they are",
        });
        options.onProfileAdopted?.(botId, adoption);
      }
      return context;
    })();

    starting = launch;
    try {
      return await launch;
    } finally {
      // Cleared whether it worked or not so a failed launch does not pin future calls to a rejected
      // promise.
      starting = null;
    }
  };

  const profiles = {
    /**
     * The Bot's page, starting the deployment's browser if it is not running.
     *
     * The browser is shared and the tab is not: whatever the other Bots are looking at, this returns
     * a tab of this Bot's own, opened on the same cookie jar.
     */
    async page(botId: string): Promise<Page> {
      const context = await browserFor(botId);

      const existing = live.get(botId);
      /*
       * Still open AND still this Bot's. A tab whose renderer died is open as far as the browser
       * says and is no longer anybody's (tabs.ts, `died`); handing it back is how one crash
       * became a Bot that could open no address at all (measured 2026-10-05).
       */
      if (
        existing &&
        !existing.page.isClosed() &&
        owners.get(existing.page) === botId
      ) {
        existing.usedAt = now();
        // And the tab's own place in the order its Bot used its tabs in (tabs.ts, `used`).
        use(existing.page);
        return existing.page;
      }
      /*
       * A closed tab is not a dead Bot, and neither is a crashed one. Somebody's `_blank` window
       * being closed used to take the whole context down with it and start a cold Chromium, because
       * the only page this map held was the closed one. Falling back to whatever else this Bot still
       * has open is what a person does when they close a tab.
       */
      const open = pagesOf(botId);
      const last = open[open.length - 1];
      if (last) return touch(botId, last);

      /*
       * A persistent context opens with a page already. The first Bot to ask takes it rather than
       * leaving a blank tab behind that belongs to nobody and shows up in nobody's list. Never a
       * crashed one, or one closed for the cap, which is nobody's too until its close lands
       * (tabs.ts, `isSpare`).
       */
      const spare = context.pages().find(isSpare);
      const page = spare ?? (await context.newPage());
      own(botId, page);
      touch(botId, page);
      options.onPage?.(botId, page);
      return page;
    },

    /**
     * The tab this Bot is on, if it has one — and nothing started to find out.
     *
     * For whoever has to remember which tab something was asked on (`control-routes.ts`): asking
     * for a hand must not be what launches a browser.
     */
    tabOf(botId: string): Page | undefined {
      const on = live.get(botId)?.page;
      return on && !on.isClosed() && owners.get(on) === botId ? on : undefined;
    },

    /** Where the deployment's one browser profile is, for anything that has to look at it. */
    profileDirectory,

    /** Where this Bot's own state goes. NOT the profile: see the comment on the definition. */
    stateDirectoryFor,

    /** Where it used to go, for reading only. See the comment on the definition. */
    legacyStateDirectoryFor,

    /** Every tab this Bot has open, and moving it to one of them. See tabs.ts. */
    tabs,
    switchTab,

    /** What became of the Bot's list since it last read it: tabs closed for the cap. See tabs.ts. */
    cappedOf,
    listRead,

    /** Whether this tab's renderer died, which ended its time as a Bot's tab. See tabs.ts. */
    hasCrashed,

    /**
     * A call on this tab failed the way a call on a dead tab does (`answeredADeadTab`).
     *
     * THE SECOND WAY A DEATH IS LEARNED, for the one nothing heard: no `crash` event let go of the
     * tab, and it is dead. Let go of here exactly as the event would have (tabs.ts, `died`) —
     * once: a death already heard is not counted again.
     *
     * CONFIRMED BY THE BROWSER BEFORE IT IS BELIEVED. The failure is known by Playwright's words
     * for it, and words can be a page's: `throw "Target crashed"` inside anything a route runs in
     * the page comes back spelled exactly as Playwright spells a dead renderer (measured:
     * `evaluate: Target crashed`, against the real one's `evaluate: Target crashed ` — one space),
     * and a page that did that would close its own tab and end whatever the Bot had asked a
     * person for on it. So the browser is asked something it answers without running a line of
     * the page: its emulated media, set to what they already are. On a dead tab Playwright refuses
     * that at once in the same words (measured: 1 ms); on a live one it answers (11 ms), and the
     * tab stays.
     */
    async deadTab(page: Page): Promise<void> {
      if (hasCrashed(page) || page.isClosed()) return;
      const dead = await within(
        CONFIRM_DEAD_MS,
        page.emulateMedia({}).then(() => false, saysRendererDied),
      );
      if (dead === true) died(page);
    },

    /**
     * Close the tabs nobody has used for a while, and the browser once nobody has any.
     *
     * Cookies are on the volume, so this signs nothing out: the next call opens a tab again with the
     * same logins. Exposed as well as swept on a timer so a test can move the clock instead of
     * waiting.
     */
    async closeIdle(): Promise<string[]> {
      const deadline = now() - idleCloseMs;
      const stale = [...live.entries()]
        .filter(([, entry]) => entry.usedAt <= deadline)
        .map(([botId]) => botId);
      for (const botId of stale) await closeTabsOf(botId);
      if (stale.length) {
        log.info("computer_idle_closed", { bots: stale, idleCloseMs });
      }
      // And the tabs that are nobody's, which no Bot's idleness reaches (tabs.ts, `closeStrays`).
      closeStrays();
      await closeIfUnused();
      return stale;
    },

    /**
     * Close this Bot's tabs without touching what the browser knows.
     *
     * This is what "kill" means for a Bot's computer: its tabs go, the logins stay, and the next
     * request opens a page again on the same profile. The browser itself only goes when the last
     * Bot's tabs have — stopping one Bot must not take the page another Bot is mid-way through.
     */
    async stop(botId: string): Promise<boolean> {
      const had = await closeTabsOf(botId);
      await closeIfUnused();
      return had;
    },

    /**
     * Get this Bot a page that answers, after the one it had stopped answering.
     *
     * A navigation that ran out its deadline is the caller. Two steps, each bounded, cheapest
     * first: close the tab and open another in the same browser, which keeps the logins in memory
     * and costs nothing visible; and if the browser will not even do that, it is the browser that
     * is wedged — for every Bot, now that there is one of it — so it is closed, killed if it will
     * not close, and the next call starts a fresh one on the same profile. Measured 2026-09-06:
     * without this, one site that never finished loading kept a Bot's browser dead for the rest of
     * the day.
     *
     * Says which step it took, so the caller can put that in front of the Bot.
     */
    async recycle(botId: string): Promise<"page" | "browser" | "none"> {
      const existing = live.get(botId);
      const context = shared?.context;
      if (!existing || !context) return "none";
      // Held before `newPage`, because the entry below moves to the new tab.
      const stuck = existing.page;
      const fresh = await Promise.race([
        context.newPage().catch(() => null),
        wait(RECYCLE_STEP_MS).then(() => null),
      ]);
      if (fresh && live.get(botId) === existing) {
        own(botId, fresh);
        existing.page = fresh;
        existing.usedAt = now();
        use(fresh);
        options.onPage?.(botId, fresh);
        // Not awaited: a tab that will not close must not hold the one that just opened hostage.
        owners.delete(stuck);
        void stuck.close().catch(() => undefined);
        return "page";
      }
      log.warn("computer_recycled_browser", { bot: botId });
      await closeBrowser();
      return "browser";
    },

    /**
     * Forget every login on this computer and start over.
     *
     * IT IS THE DEPLOYMENT'S PROFILE, SO IT IS EVERY BOT'S LOGINS. There is one cookie jar and this
     * empties it; the Bot on the header is who asked, not whose logins go. The route's answer says
     * so and the app's words say so, because a button labelled as one Bot's that signs out five is
     * the screen lying about what it just did.
     *
     * The browser is closed before the directory is deleted: deleting a profile out from under a
     * running Chromium is how you get a browser that is alive, writing to files that no longer
     * exist, and reporting success. Nothing is recreated here, the next request starts a clean
     * browser, which is the same path as a first ever start and so needs no second code path.
     *
     * EVERY PROFILE GOES, NOT ONLY THE SHARED ONE. An upgraded machine still has the per-Bot
     * directories this change left in place, cookies and all (see `resolveProfile`). A reset that
     * emptied one of them and left four sitting on the volume would be the most dangerous kind of
     * half-true: somebody presses it precisely because they want the logins gone.
     *
     * AND NOTHING ELSE IS ON THE PROFILE WHILE IT GOES — which "closed before deleted" promised and
     * did not deliver, three ways (`tests/reset-race.test.ts`; each failed before this, 8 runs of 8
     * with the launcher stubbed):
     *
     *  - a launch that begins during the reset: it waits for `resetting`, set here before anything
     *    is awaited;
     *  - a launch already under way when the reset arrives. `closeBrowser` knows only a browser
     *    that has finished starting, so the reset found nothing to close and had deleted the
     *    profile before that browser was up — which then ran on, on a profile that was gone. It is
     *    waited for, for as long as a launch can take and no longer, and closed like any other;
     *  - a close already under way, from the idle sweep or a stop: `closeBrowser` answers at once
     *    when nothing is running, and the delete was over before that browser had gone — and going
     *    is when Chromium writes its cookies out (`closeAndWait`). It is waited for too.
     *
     * One reset at a time, each after the one before it.
     */
    async reset(botId: string): Promise<void> {
      const earlier = resetting;
      const launching = starting;
      const { promise: over, resolve: finish } = Promise.withResolvers<void>();
      resetting = over;
      try {
        await earlier;
        if (launching) await within(LAUNCH_WAIT_MS, launching);
        await closeBrowser();
        await closing?.catch(() => undefined);
        const entries = await readdir(root, { withFileTypes: true }).catch(
          () => [],
        );
        await Promise.all(
          entries
            .filter((entry) => entry.isDirectory() && entry.name !== STATE_DIR)
            .map((entry) =>
              rm(join(root, entry.name), {
                recursive: true,
                force: true,
              }).catch(() => undefined),
            ),
        );
        // Its own state too, which used to go because it lived inside the directory above. Only
        // this Bot's: another Bot's control file says a PERSON is driving, and losing it hands
        // their browser back to a Bot (`control.ts`, `restoredControl`) — the one direction that
        // is never safe to be careless in.
        await rm(stateDirectoryFor(botId), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
        // A clean machine points at the default again: there is nothing left to have adopted.
        adoption = {
          directory: DEFAULT_PROFILE_DIR,
          adoptedFrom: null,
          kept: 0,
        };
        adoptionTold = true;
        await writePointer(root, adoption);
      } finally {
        if (resetting === over) resetting = null;
        finish();
      }
    },

    /**
     * Every Bot this computer holds something for, whether or not it has a tab open.
     *
     * Read from disk rather than from memory, because after a restart nothing is open and everything
     * is still there: an admin page that listed only the Bots with a live tab would show an empty
     * screen and imply the logins were gone. `isBotId` is what separates a Bot's directory from the
     * two the layout owns — both of those carry a dot, which no Bot id may.
     */
    async known(): Promise<string[]> {
      const [atRoot, withState] = await Promise.all([
        readdir(root, { withFileTypes: true }).catch(() => []),
        readdir(join(root, STATE_DIR), { withFileTypes: true }).catch(() => []),
      ]);
      const directories = (entries: typeof atRoot) =>
        entries
          .filter((e) => e.isDirectory() && isBotId(e.name))
          .map((e) => e.name);
      return [
        ...new Set([
          ...directories(atRoot),
          ...directories(withState),
          ...live.keys(),
        ]),
      ].sort();
    },

    /** What the admin surface lists. Tabs open or not, because every Bot has the one computer. */
    summary(botIds: string[]): ProfileSummary[] {
      const known = new Set([...botIds, ...live.keys()]);
      // One browser, one proxy: the same answer on every row, which is the honest one now.
      const egress = deploymentEgressLabel(process.env);
      return [...known].sort().map((botId) => {
        const running = live.get(botId);
        return {
          botId,
          running: Boolean(running),
          startedAt: running?.since ?? null,
          egress,
        };
      });
    },

    /**
     * Close the browser, for shutdown.
     *
     * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait. Closing the context
     * here gives Chromium the chance to flush its profile within that grace period.
     */
    async closeAll(): Promise<void> {
      await closeBrowser();
    },

    /**
     * The Bots with a tab open right now.
     *
     * For the one question the navigation guard cannot answer on its own: a refused hop carries a
     * frame id, and when exactly one Bot has anything open, every frame in the browser is that Bot's
     * (see `index.ts`). A fact, not a guess — which is why it is a count rather than "the Bot that
     * acted most recently".
     */
    liveBots(): string[] {
      return [...live.keys()];
    },

    /**
     * Follow where the person is, as one call said it (whereabouts.ts).
     *
     * The place moves at once on a running browser. The zone cannot — Playwright fixes it when the
     * context is created — so a browser nobody has a tab in is closed here and the call that brought
     * the change starts the next one on the right clock; a browser a Bot is working in keeps its zone
     * until its tabs close or it idles out. Called before every Bot route, so almost every call finds
     * nothing moved and returns without touching the browser.
     */
    async follow(said: Whereabouts): Promise<void> {
      if (said.timeZone !== undefined) wanted.timeZone = said.timeZone;
      if (said.geolocation !== undefined) wanted.geolocation = said.geolocation;
      const running = shared;
      if (!running || starting) return;
      if (!samePlace(running.geolocation, wanted.geolocation)) {
        const place = wanted.geolocation;
        try {
          if (place) {
            await running.context.setGeolocation(place);
            await running.context.grantPermissions(["geolocation"]);
          } else {
            // Nothing else is ever granted on this context, so clearing takes only the place.
            await running.context.clearPermissions();
            await running.context.setGeolocation(null);
          }
          running.geolocation = place;
          log.info("browser_place_followed", { place: place !== null });
        } catch (error) {
          // The next call tries again: `running.geolocation` still says what the browser shows.
          log.warn("browser_place_follow_failed", { reason: error });
        }
      }
      // A Bot's tab, not a Bot's entry in `live`: a tab a site closed leaves the entry behind.
      const anybodyIn = [...owners.keys()].some((page) => !page.isClosed());
      if (running.timeZone !== wantedZone() && !anybodyIn) {
        log.info("browser_zone_followed", { restarted: true });
        await closeBrowser();
      }
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
