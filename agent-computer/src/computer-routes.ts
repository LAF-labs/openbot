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
import { stopViewer } from "./live-screen";
import { json } from "./respond";
import { forgetSecretFields } from "./secret-fields";

/**
 * `/health`, which names no Bot.
 *
 * The header is optional here and nowhere else: an orchestrator probing this container has no
 * Bot to name. Where one IS named, the answer is about that Bot's browser, as it always was.
 * Named, and a name — a health check is not a way to ask about `../..` either, and an unnameable
 * Bot is simply not reported on rather than refused.
 */
export function health(asked: string | null, { profiles }: Computer): Response {
  const [profile] = isBotId(asked) ? profiles.summary([asked]) : [];
  return json({
    status: "ok",
    // `browser` kept as it was: it is in the published contract and start.sh reads it.
    browser: profile?.running ?? false,
    ...(profile ? { profile } : {}),
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
  { botId, session },
  { profiles, sessions },
) => {
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
  // Always answers: a browser that will not close is killed (profiles.ts, closeAndWait), so a
  // reset cannot be the fourth thing queued behind a page that never loaded.
  await profiles.reset(botId);
  return json({ reset: true, botId, scope: "deployment" });
};
