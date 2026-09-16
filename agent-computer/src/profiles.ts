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
 *     reproduce here. The defensive sweep below stays anyway, because it is three lines and the
 *     failure it prevents is "the computer never comes back".
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
 * WHAT DID NOT CHANGE. Each Bot still keeps its own TABS — `owners` below — because two Bots can act
 * at once (`server/src/runner/bot-lane.ts` queues per Bot, not per account) and sharing one tab would
 * put one Bot's click on the other's page and each one's snapshot stale under the other. Sharing
 * logins is the decision; sharing the thing being looked at is not.
 *
 * A profile is not a container. Two Bots in this process are isolated from each other's kernel,
 * filesystem or memory by nothing at all, and now from each other's cookies by nothing either.
 *
 * Container-per-Bot needs something privileged to create containers, and the API server must never be
 * that: access to the Docker socket is unrestricted root on the host. Stop and reset are
 * operations this process applies to its own browser, so the same design works under Compose,
 * Kubernetes or ECS, where the orchestrator's own restart policy brings a process back.
 */
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { isBotId } from "./authorisation";
import { keepChildProcesses } from "./child-processes";
import { deploymentEgress, deploymentEgressLabel } from "./egress";
import { log } from "./log";
import { titleOf } from "./page-text";

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
  /** Position in the Bot's own list, which is what `computer_switch_tab` takes. */
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
 * How long a Bot may leave its tabs untouched before they are closed.
 *
 * Ten minutes. Four of five Bots are usually asleep between a routine at nine and one at noon, and a
 * tab nobody is looking at still costs a renderer; closing them costs the next call a page load and
 * gives the machine its memory back. The cookies are on the volume and the profile is shared, so
 * nothing is signed out by it — and when the last Bot's tabs go, so does the browser.
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
 * as Postgres; 100MB is enough that a portal's images survive between turns and small enough that it
 * cannot fill a 40GB box. It used to be 100MB per Bot, because there used to be a profile per Bot;
 * one profile means one cache, so the same number now bounds the whole deployment.
 *
 * THERE IS NO `--no-sandbox` HERE ANY MORE, AND THERE MUST NOT BE. It was the first flag in this
 * list from the day the image existed, and with the Dockerfile naming no `USER` it meant the one
 * process in this product that opens pages a model chose — holding somebody's bank and 홈택스 cookies
 * — ran its renderers unsandboxed as the container's root (audit A5 §1, `docker exec … id` → `uid=0`).
 * One renderer bug was the whole container, every Bot's profile included.
 *
 * Chromium's sandbox on Linux is user namespaces, and Docker's default seccomp profile refuses them
 * to an unprivileged process. Measured 2026-09-13 on the customer VMs' platform — Ubuntu 24.04.4,
 * kernel 6.8 aarch64, `apparmor_restrict_unprivileged_userns=1`, Docker 29.8 from get.docker.com —
 * in this image as `pwuser`: under the default profile Chromium exits 133 with "No usable sandbox!";
 * under Playwright's published profile (`agent-computer/seccomp_profile.json`, the same JSON) it
 * starts, and every renderer runs in a user, PID and network namespace of its own, where the shipped
 * image had them in the container's, as root. No AppArmor change: the container is confined by
 * `docker-default`, which does not mediate user namespaces, so Ubuntu's restriction — which is on
 * UNconfined processes — never applies. `docker-compose.yml` hands the container the profile, the
 * Dockerfile runs it as `pwuser`, and this list is what the two make possible. Putting the flag back
 * would "fix" a deployment that lost the profile by removing the boundary in silence;
 * `tests/sandbox.test.ts` pins its absence.
 *
 * AND ITS ABSENCE HERE WAS NOT ENOUGH. Playwright adds `--no-sandbox` itself unless it is launched
 * with `chromiumSandbox: true` (see the launch below). Measured 2026-09-13 in the rebuilt container
 * with the flag already gone from this list: the running browser's command line still carried
 * `--no-sandbox`, and every renderer sat in the container's own user and network namespaces. A
 * test that only read this array would have passed with the sandbox off.
 */
const LAUNCH_ARGS = [
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

/** A moment after the browser process is gone, for whatever it was still flushing. */
const FLUSH_SETTLE_MS = 250;

/**
 * How long a graceful close is given before the process is killed instead.
 *
 * Measured 2026-09-06 against 기업마당: a navigation that hit its 30s deadline left that Bot's
 * Chromium answering nothing at all — the next `goto` sat out its own deadline, `context.close()`
 * never returned, and because the launch path waits for a close in flight, every later call on that
 * Bot waited on it too. Stop, reset and ten idle minutes all queued behind the same promise. A close
 * that cannot finish in this long is not going to, and the kill below is what ends it.
 */
export const CLOSE_GRACE_MS = 3_000;

/** After a kill, how long the `disconnected` event is waited for before the profile is presumed free. */
const KILL_SETTLE_MS = 1_000;

/** How long a page-level recovery step (close the tab, open another) is given before the browser goes. */
const RECYCLE_STEP_MS = 2_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The slice of a context a close needs, so the bounded close can be tested without a browser. */
export type ClosableContext = Pick<BrowserContext, "close"> & {
  browser(): {
    isConnected(): boolean;
    once(event: "disconnected", handler: () => void): unknown;
  } | null;
};

/**
 * Close a context and wait for Chromium to actually be gone — or make it go.
 *
 * Chromium batches cookie writes and commits them as it exits, while `close()` only asks it to exit.
 * Bounded, because a shutdown that hangs must never be the reason a computer does not come back. We
 * would rather lose the last few seconds of cookies than never restart.
 *
 * THE EXIT IS WAITED FOR, NOT ASSUMED. This used to sleep two seconds flat, on the stated grounds
 * that a persistent context exposes no exit signal — but `context.browser()` is not null in this
 * Playwright version (measured), so `disconnected` is exactly that signal. It matters more now that
 * a browser also closes on its own once every Bot has gone idle: returning from a close before the
 * process has released the profile directory is how two Chromiums end up on one user-data-dir, and
 * the second one comes up in a state where every call hangs until its timeout.
 *
 * AND THE CLOSE ITSELF IS BOUNDED, which it was not. `context.close()` was awaited without a limit
 * on the assumption that a browser asked to exit exits; a Chromium wedged mid-navigation does not,
 * and everything for that Bot then waited for ever (see CLOSE_GRACE_MS). So: ask nicely, wait the
 * grace, and if the browser is still connected, kill the process by the id recorded at launch. The
 * profile directory is on disk either way; what a kill costs is the last few seconds of cookies.
 */
export async function closeAndWait(
  context: ClosableContext,
  process: { pid: number | null; kill?: (pid: number) => void } = {
    pid: null,
  },
): Promise<void> {
  const browser = context.browser();
  const gone = browser
    ? new Promise<void>((resolve) => {
        browser.once("disconnected", () => resolve());
      })
    : null;
  const asked = context.close().catch(() => undefined);
  await Promise.race([asked, wait(CLOSE_GRACE_MS)]);
  if (browser?.isConnected()) {
    log.warn("computer_close_hung", {
      pid: process.pid,
      graceMs: CLOSE_GRACE_MS,
    });
    if (process.pid !== null) {
      try {
        (process.kill ?? killProcess)(process.pid);
      } catch {
        // Already gone between the check and the kill; nothing to end.
      }
    }
    // With no pid there is nothing more to do than not wait: the caller gets its answer and the
    // launch path's lock sweep takes its chances, which is what it did before this existed.
    if (gone) await Promise.race([gone, wait(KILL_SETTLE_MS)]);
    await wait(FLUSH_SETTLE_MS);
    return;
  }
  if (gone) {
    await Promise.race([gone, wait(CLOSE_SETTLE_MS)]);
    await wait(FLUSH_SETTLE_MS);
    return;
  }
  await wait(CLOSE_SETTLE_MS);
}

/** SIGKILL, not SIGTERM: a Chromium that ignored a graceful close is not going to honour a signal it may handle. */
function killProcess(pid: number): void {
  globalThis.process.kill(pid, "SIGKILL");
}

/**
 * The operating-system id of the browser behind a context, read the moment it starts.
 *
 * Playwright exposes no process for a persistent context, but the browser will say its own pid over
 * CDP. Asked once, at launch, while the browser is certainly answering: by the time a kill is needed
 * it no longer is, which is the whole point of asking early. Null when it cannot be read — then a
 * hung close still returns after the grace, it just cannot end the process.
 */
async function browserPidOf(context: BrowserContext): Promise<number | null> {
  try {
    const browser = context.browser();
    if (!browser) return null;
    const session = await browser.newBrowserCDPSession();
    const info = (await Promise.race([
      session.send("SystemInfo.getProcessInfo"),
      wait(RECYCLE_STEP_MS).then(() => null),
    ])) as { processInfo?: { type: string; id: number }[] } | null;
    await session.detach().catch(() => undefined);
    const main = info?.processInfo?.find((entry) => entry.type === "browser");
    return typeof main?.id === "number" ? main.id : null;
  } catch {
    return null;
  }
}

/**
 * The file that records which directory under the profiles root the deployment's browser opens.
 *
 * A pointer rather than a fixed path, because an upgrade adopts a directory that already exists and
 * already holds somebody's logins. Written once, read every boot after: two boots must not disagree
 * about where the cookies are.
 */
const POINTER_FILE = "profile.json";

/**
 * The directory the shared profile gets when there is no per-Bot profile to take over.
 *
 * A dot in the name, deliberately: `isBotId` refuses any id with a dot in it, so no Bot anybody
 * creates can ever be called this and no per-Bot directory can ever collide with it. `bot.state`
 * below is dot-named for the same reason.
 */
const DEFAULT_PROFILE_DIR = "shared.profile";

/** Where per-Bot state that is NOT the cookie jar lives: who has the wheel (`sessions.ts`). */
const STATE_DIR = "bot.state";

/**
 * What a Chromium user-data directory has in it.
 *
 * Asked so that a directory holding nothing but `control.json` — a Bot that was driven before its
 * browser ever started — is not adopted as somebody's profile and reported as their logins.
 */
const PROFILE_MARKERS = ["Default", "Local State"];

/** Which directory the deployment's browser opens, and what taking it over cost. */
export type ProfileAdoption = {
  /** The directory the shared profile lives in, by name under the profiles root. */
  directory: string;
  /** The per-Bot profile it was taken over from, or null when a fresh one was made. */
  adoptedFrom: string | null;
  /** How many other per-Bot profiles were left exactly where they are. */
  kept: number;
};

const isAdoption = (value: unknown): value is ProfileAdoption =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProfileAdoption).directory === "string" &&
  (value as ProfileAdoption).directory.length > 0;

/**
 * When a profile was last used, as well as the filesystem can say.
 *
 * The cookie database first: it is rewritten whenever a login changes, which is the closest thing on
 * disk to "this is the profile the person was actually using". The directory's own mtime is the
 * fallback, and it moves for any write at all — enough to order two profiles, not enough to be
 * trusted on its own.
 */
async function profileUsedAt(dir: string): Promise<number> {
  const candidates = [
    join(dir, "Default", "Cookies"),
    join(dir, "Default"),
    join(dir, "Local State"),
    dir,
  ];
  let newest = 0;
  for (const path of candidates) {
    const info = await stat(path).catch(() => null);
    if (info) newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

async function looksLikeProfile(dir: string): Promise<boolean> {
  for (const marker of PROFILE_MARKERS) {
    if (await stat(join(dir, marker)).catch(() => null)) return true;
  }
  return false;
}

/**
 * Which directory the deployment's browser opens — TAKING OVER A PERSON'S LOGINS RATHER THAN
 * THROWING THEM AWAY.
 *
 * A machine upgrading into this change has a directory per Bot, each with cookies in it, and the
 * cheap thing to do would be to start a clean shared profile and let the person sign into their
 * bank, 홈택스 and 스마트스토어 again on the strength of a version bump. So instead: the profile that
 * was used most recently BECOMES the shared one, in place, and the rest are left exactly where they
 * are — untouched, not merged and not deleted, because merging two Chromium profiles is not a thing
 * that can be done safely and deleting them is the person's call, not an upgrade's. The choice is
 * written to the pointer file so every later boot agrees with this one, and `laf:profile_adopted`
 * puts it in front of the Bot that caused the first launch.
 *
 * `kept` counts what was left behind, so "why is 배민 still asking me to log in" has an answer: it is
 * signed in in one of those, and the way to move it is to sign in once on the shared browser.
 */
export async function resolveProfile(root: string): Promise<ProfileAdoption> {
  const pointed = await readFile(join(root, POINTER_FILE), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  if (isAdoption(pointed)) {
    // Field by field rather than handed back whole: the file also carries `at`, and a caller that
    // compared two resolutions would be comparing timestamps.
    return {
      directory: pointed.directory,
      adoptedFrom: pointed.adoptedFrom ?? null,
      kept: typeof pointed.kept === "number" ? pointed.kept : 0,
    };
  }

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: { name: string; usedAt: number }[] = [];
  for (const entry of entries) {
    // Only a directory a Bot could have been called: `bot.state` and `shared.profile` carry a dot
    // and so can never be one, and neither can a stray file.
    if (!entry.isDirectory() || !isBotId(entry.name)) continue;
    const dir = join(root, entry.name);
    if (!(await looksLikeProfile(dir))) continue;
    candidates.push({ name: entry.name, usedAt: await profileUsedAt(dir) });
  }
  // Newest first, and by name when two are the same age, so an upgrade run twice on one machine
  // picks the same directory both times.
  candidates.sort(
    (a, b) => b.usedAt - a.usedAt || a.name.localeCompare(b.name),
  );

  const [newest] = candidates;
  const adoption: ProfileAdoption = newest
    ? {
        directory: newest.name,
        adoptedFrom: newest.name,
        kept: candidates.length - 1,
      }
    : { directory: DEFAULT_PROFILE_DIR, adoptedFrom: null, kept: 0 };
  await writePointer(root, adoption);
  return adoption;
}

/**
 * The decision, written down.
 *
 * Best effort: a root that cannot be written to is a broken deployment already, and refusing to give
 * anybody a browser over it would turn "the pointer did not save" into "nothing works". The
 * resolution above is deterministic anyway, so the next boot reaches the same answer by itself.
 */
async function writePointer(
  root: string,
  adoption: ProfileAdoption,
): Promise<void> {
  await writeFile(
    join(root, POINTER_FILE),
    JSON.stringify({ ...adoption, at: new Date().toISOString() }),
    "utf8",
  ).catch((error: unknown) => {
    log.error("profile_pointer_not_saved", { reason: error });
  });
}

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
  } | null = null;

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
   * Which Bot each open tab belongs to.
   *
   * The cookie jar is shared and the tabs are not. Without this, one Bot's `/snapshot` would describe
   * whatever page another Bot happened to open last, and `computer_switch_tab` would hand it the
   * wheel of a tab it never opened.
   */
  const owners = new Map<Page, string>();

  /** Each Bot's current tab, and when it last did anything. See IDLE_CLOSE_MS. */
  const live = new Map<string, { page: Page; usedAt: number; since: string }>();

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

  const sweepLocks = async (dir: string): Promise<void> => {
    await Promise.all(
      SINGLETON_FILES.map((name) =>
        rm(join(dir, name), { force: true }).catch(() => undefined),
      ),
    );
  };

  /** This Bot's open tabs, in the browser's own order. */
  const pagesOf = (botId: string): Page[] =>
    (shared?.context.pages() ?? []).filter(
      (page) => !page.isClosed() && owners.get(page) === botId,
    );

  /** Mark a tab as this Bot's, and stop saying so once it is closed. */
  const own = (botId: string, page: Page): void => {
    owners.set(page, botId);
    page.once("close", () => {
      if (owners.get(page) === botId) owners.delete(page);
    });
  };

  /** Note that this Bot has a tab, without moving `since` if it already had one. */
  const touch = (botId: string, page: Page): Page => {
    const existing = live.get(botId);
    live.set(botId, {
      page,
      usedAt: now(),
      since: existing?.since ?? new Date().toISOString(),
    });
    return page;
  };

  /** Close this Bot's tabs and forget it is here. Says whether it had any. */
  const closeTabsOf = async (botId: string): Promise<boolean> => {
    const pages = pagesOf(botId);
    live.delete(botId);
    for (const page of pages) owners.delete(page);
    await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
    return pages.length > 0;
  };

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
       * A browser that is still letting go of this profile gets to finish first. The sweep of
       * singleton locks below assumes no browser of ours is running on this directory, and that is
       * only true once the close has actually completed.
       */
      await closing?.catch(() => undefined);
      adoption ??= await resolveProfile(root);
      const dir = profileDirectory();
      await sweepLocks(dir);
      const proxy = deploymentEgress(process.env);
      const context = await chromium.launchPersistentContext(dir, {
        args: LAUNCH_ARGS,
        // Playwright's default is false, and false means it passes `--no-sandbox` on our behalf.
        chromiumSandbox: true,
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
      };
      /*
       * A TAB A SITE OPENED BELONGS TO THE BOT WHOSE CLICK OPENED IT.
       *
       * 네이버 opens half its links with `target=_blank`. Without this the Bot clicked, the page it
       * asked for opened in a tab nothing here held a handle to, and both the Bot and the person
       * watching the screencast went on looking at the page they had left — the click "worked" and
       * nothing about the answer was true. Adopting the newest page is what a person does: the tab
       * that just opened is the one they are looking at.
       *
       * WHOSE it is now has to be worked out rather than assumed, because the browser is everyone's.
       * `opener()` is the browser's own answer to "which page opened this one", so the new tab lands
       * with the Bot that clicked the link and in nobody else's list. A tab we opened ourselves has
       * already been claimed by the time this resolves, and is left alone.
       */
      context.on("page", (opened) => {
        void (async () => {
          if (owners.has(opened)) return;
          const opener = await opened.opener().catch(() => null);
          if (owners.has(opened)) return;
          const botOf = opener ? owners.get(opener) : undefined;
          // Not ours to hand to anybody: a tab with no opener we did not open. Left unowned rather
          // than guessed at — a page in the wrong Bot's list is a click landing on a stranger's page.
          if (!botOf) return;
          own(botOf, opened);
          touch(botOf, opened);
          options.onPage?.(botOf, opened);
        })();
      });
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
      if (existing && !existing.page.isClosed()) {
        existing.usedAt = now();
        return existing.page;
      }
      /*
       * A closed tab is not a dead Bot. Somebody's `_blank` window being closed used to take the
       * whole context down with it and start a cold Chromium, because the only page this map held
       * was the closed one. Falling back to whatever else this Bot still has open is what a person
       * does when they close a tab.
       */
      const open = pagesOf(botId);
      const last = open[open.length - 1];
      if (last) return touch(botId, last);

      /*
       * A persistent context opens with a page already. The first Bot to ask takes it rather than
       * leaving a blank tab behind that belongs to nobody and shows up in nobody's list.
       */
      const spare = context
        .pages()
        .find((page) => !page.isClosed() && !owners.has(page));
      const page = spare ?? (await context.newPage());
      own(botId, page);
      touch(botId, page);
      options.onPage?.(botId, page);
      return page;
    },

    /** Where the deployment's one browser profile is, for anything that has to look at it. */
    profileDirectory,

    /** Where this Bot's own state goes. NOT the profile: see the comment on the definition. */
    stateDirectoryFor,

    /** Where it used to go, for reading only. See the comment on the definition. */
    legacyStateDirectoryFor,

    /**
     * Every tab this Bot has open, in the browser's own order.
     *
     * Reported on every snapshot rather than only when asked: a Bot that cannot see that a second
     * tab exists cannot decide to go to it, and the tab a click opened is usually the one holding
     * the answer. Another Bot's tabs are not in this list — they are on the same browser, not in
     * this Bot's hands.
     */
    async tabs(botId: string): Promise<TabSummary[]> {
      const running = live.get(botId);
      if (!running) return [];
      return Promise.all(
        pagesOf(botId).map(async (page, index) => ({
          index,
          // A page that navigates while we are describing it costs its title, not the list — and a
          // tab between documents has none, never Playwright's `Loading <address>` (see `titleOf`).
          title: await titleOf(page),
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
      const wanted = pagesOf(botId)[index];
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
     */
    async reset(botId: string): Promise<void> {
      await closeBrowser();
      const entries = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      );
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && entry.name !== STATE_DIR)
          .map((entry) =>
            rm(join(root, entry.name), { recursive: true, force: true }).catch(
              () => undefined,
            ),
          ),
      );
      // Its own state too, which used to go because it lived inside the directory above. Only this
      // Bot's: another Bot's control file says a PERSON is driving, and losing it hands their
      // browser back to a Bot (`control.ts`, `restoredControl`) — the one direction that is never
      // safe to be careless in.
      await rm(stateDirectoryFor(botId), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      // A clean machine points at the default again: there is nothing left to have adopted.
      adoption = { directory: DEFAULT_PROFILE_DIR, adoptedFrom: null, kept: 0 };
      adoptionTold = true;
      await writePointer(root, adoption);
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
