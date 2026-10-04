/**
 * How the deployment's browser is started: the flags it is given, and the one call that starts it.
 */
import { type BrowserContext, chromium } from "playwright";
import type { Coordinates } from "../../shared/whereabouts";
import { botUserAgent, LOCALE, VIEWPORT } from "./browser-identity";
import type { Egress } from "./egress";

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
 * How long a reset waits for a browser that was already starting when it arrived.
 *
 * Playwright's own bound on a browser starting — its default, which the launch below does not
 * change — so the longest a launch that is going to land can take. A reset always answers
 * (`computer-routes.ts`): past this it goes on without the launch, as it did for every launch
 * before it waited for any.
 */
export const LAUNCH_WAIT_MS = 30_000;

/** What a launch is started on, each read once by the caller so it can record exactly this. */
export type LaunchSettings = {
  timeZone: string;
  geolocation: Coordinates | null;
  chromiumVersion: string;
  proxy: Egress | null;
};

/**
 * Start the deployment's browser on its profile directory.
 *
 * Not `async`: the caller awaits Playwright's own promise, so a launch settles on the tick it would
 * if the call were written where it is made. What a reset waits for, and in what order the launch,
 * the close and the delete land, is exactly that (`tests/reset-race.test.ts`).
 */
export function launchBrowser(
  dir: string,
  { timeZone, geolocation, chromiumVersion, proxy }: LaunchSettings,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(dir, {
    args: LAUNCH_ARGS,
    // Playwright's default is false, and false means it passes `--no-sandbox` on our behalf.
    chromiumSandbox: true,
    viewport: VIEWPORT,
    locale: LOCALE,
    // The person's clock and place, not the VM's (whereabouts.ts). No place, no permission.
    timezoneId: timeZone,
    ...(geolocation ? { geolocation, permissions: ["geolocation"] } : {}),
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
}
