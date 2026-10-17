/**
 * The computers themselves: whether this process is up, which computers it holds, and stopping or
 * resetting one.
 *
 * Stop and reset are operations this process applies to its own browser (see profiles.ts), so the
 * same design works under Compose, Kubernetes or ECS, where the orchestrator's restart policy is
 * what brings a process back.
 */
import { isBotId } from "./authorisation";
import type { BotRoute, Computer } from "./computer";
import { type CoreShareSampler, machineCoreShare } from "./core-share";
import { actionFailure } from "./failures";
import { forgetFilled } from "./filled-values";
import { stopViewer } from "./live-screen";
import { bodyOf, invalid, json } from "./respond";
import { forgetSecretFields } from "./secret-fields";

/**
 * `/health`, which names no Bot.
 *
 * The header is optional here and nowhere else: an orchestrator probing this container has no
 * Bot to name. Where one IS named, the answer is about that Bot's browser, as it always was.
 * Named, and a name — a health check is not a way to ask about `../..` either, and an unnameable
 * Bot is simply not reported on rather than refused.
 */
export function health(
  asked: string | null,
  { profiles, egress }: Computer,
  cpu: CoreShareSampler = machineCoreShare,
): Response {
  const [profile] = isBotId(asked) ? profiles.summary([asked]) : [];
  return json({
    status: "ok",
    // `browser` kept as it was: it is in the published contract and start.sh reads it.
    browser: profile?.running ?? false,
    ...(profile ? { profile } : {}),
    /*
     * Whether the host is holding the browser's egress firewall (egress-guard.ts). Said here and
     * still 200: an unguarded computer is up, answers every call and refuses only to browse, and
     * the server can only say why if it can still reach the process that knows.
     */
    egress: egress.state(),
    /*
     * How much of a core the hypervisor is giving this machine, `{ coreShare, stealPct, pinned }`
     * (core-share.ts): what tells a throttled burstable VM — slower, and its steps given longer —
     * from a broken one. Null where `/proc/stat` cannot be read, never a 1 nothing measured.
     */
    cpu: cpu.current(),
    /*
     * NO `identity` FIELD. It reported what the local SPIRE agent said this computer was, and
     * SPIRE went with the per-Bot container plane in 2026-08. Nothing has set
     * `SPIFFE_ENDPOINT_SOCKET` since, so the field was `null` in every deployment this
     * repository can produce, and nothing read it. A health field that is always null is a
     * claim the deployment cannot back.
     */
  });
}

/**
 * The computers this process holds. The shape is a list because the admin surface is a
 * list, and because a Bot that has a profile has a computer whether or not a browser is running
 * for it this second.
 *
 * Names no Bot, by definition: it is the question "which are there".
 */
export async function listComputers({ profiles }: Computer): Promise<Response> {
  return json({ computers: profiles.summary(await profiles.known()) });
}

/**
 * Stop this Bot's tabs, keep what the browser knows.
 *
 * Closed gracefully so Chromium flushes its profile, and deliberately
 * not restarted here: the next request starts it again, which is the same path as a first ever
 * start, so there is no second way for a browser to come into existence.
 *
 * ONE BOT'S, even though the browser is every Bot's. Stopping is what somebody presses when a Bot is
 * stuck on a page; taking the browser out from under the other four while one of them is mid-way
 * through a routine would be a different button. The browser itself closes when the last Bot's tabs
 * do (profiles.ts).
 */
export const stopComputer: BotRoute = async (
  { botId, session },
  { profiles },
) => {
  const wasRunning = await profiles.stop(botId);
  // The wheel goes back to the Bot because the controlled browser no longer exists.
  session.control.release();
  forgetSecretFields(session);
  // Its tabs are closed, so the pages a value went into are gone with the rest.
  forgetFilled(session);
  return json({ stopped: true, wasRunning });
};

/**
 * Forget every login on this computer and start over.
 *
 * IT IS THE WHOLE COMPUTER'S, NOT THIS BOT'S. There is one browser profile on a deployment and every
 * Bot is signed in through it (profiles.ts, 2026-09-16), so this signs ALL of them out — the Bot on
 * the header is who asked, not whose logins go. `scope: "deployment"` rides on the answer so the
 * server has that as a fact rather than an assumption, and the app's confirmation says it in Korean
 * before anybody presses it: a button that reads as one Bot's and empties five is the screen lying
 * about what it just did.
 *
 * Irreversible, which is why it is its own endpoint rather than a flag on the one above: a person
 * clicking "stop" must not be able to discard a login by mistyping a parameter.
 */
export const resetComputer: BotRoute = async (
  { botId, request, session },
  { profiles, sessions, workspace },
) => {
  const body = await bodyOf<{ emptyFolder?: unknown }>(request);
  /*
   * THE BOT'S STATE IN THIS PROCESS GOES WITH THE PROFILE, AND BEFORE IT.
   *
   * Control used to be released AFTER the profile was deleted, and releasing writes
   * `control.json` — which recreated the directory the line above had just removed. Measured
   * 2026-09-13: after a reset `/computers` still listed the Bot, from a directory holding nothing
   * but that file. It is the same Bot's answer to "which computers are there", after the one call
   * that was supposed to end it. So the session is dropped first, without writing anything, and a
   * Bot used again after a reset starts from a session of its own.
   *
   * Only this Bot's. Another Bot's control file says a PERSON is driving, and losing it hands their
   * browser back to a Bot — the one direction control is never allowed to move by accident.
   */
  sessions.drop(botId);
  forgetSecretFields(session);
  await stopViewer(session).catch(() => undefined);
  // Always answers: a browser that will not close is killed (browser-close.ts, closeAndWait), so a
  // reset cannot be the fourth thing queued behind a page that never loaded.
  await profiles.reset(botId);
  /*
   * AND THE BOT'S FOLDER, WHEN THE ACCOUNT IS LEAVING. The folder holds what the person's files
   * became — a receipt's sheet as CSV, a menu's text — beside what the Bot downloaded and the long
   * results it filed, and the next person to get this computer must not find them, any more than
   * they may find the logins (`server/src/account/deletion.ts` asks for this).
   *
   * ONLY WHEN ASKED. The administrator's 초기화 reaches this route too, and its dialog promises a
   * sign-out, not a deleted folder: emptying it there would be the control doing more than it says.
   */
  const emptied =
    body?.emptyFolder === true ? await workspace.clear() : undefined;
  return json({
    reset: true,
    botId,
    scope: "deployment",
    ...(emptied === undefined ? {} : { emptied }),
  });
};

/** The most origins one call forgets: a company's shared logins are a handful, never a crawl. */
export const FORGET_ORIGINS_MAX = 100;

/**
 * The origins a forget names, each exactly an `http(s)://host[:port]` origin and nothing more —
 * or null. A path, a query, a bare host or another scheme is refused rather than read as the
 * nearest origin: the call deletes logins, and it deletes exactly what it was told or nothing.
 */
export function originsOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > FORGET_ORIGINS_MAX) return null;
  const origins = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.origin !== item) return null;
    origins.add(url.origin);
  }
  return [...origins];
}

/**
 * Sign the browser out of the origins named, and only those (`profiles.ts`, `forgetCookies`).
 *
 * THE WHOLE COMPUTER'S, like a reset: the profile is every Bot's, so the Bot on the header is who
 * asked. Its own endpoint for a reset's reason — a person leaving their company must never be able
 * to sign out of everything by a parameter missing (`server/src/hub/leave.ts`).
 */
export const forgetCookies: BotRoute = async (
  { botId, request },
  { profiles },
) => {
  const body = await bodyOf<{ origins?: unknown }>(request);
  const origins = originsOf(body?.origins);
  if (!origins) return invalid("origins");
  try {
    const forgotten = await profiles.forgetCookies(botId, origins);
    return json({ forgotten, origins: origins.length, scope: "deployment" });
  } catch (error) {
    // A browser that would not start is a fact for the server, never Playwright's own message.
    return actionFailure(error);
  }
};
