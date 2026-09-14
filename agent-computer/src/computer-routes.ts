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
 * Stop the browser, keep what it knows.
 *
 * Closed gracefully so Chromium flushes its profile, and deliberately
 * not restarted here: the next request starts it again, which is the same path as a first ever
 * start, so there is no second way for a browser to come into existence.
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
 * Forget everything and start over.
 *
 * Signs the computer out of everything by deleting the profile. Irreversible, which is why it is
 * its own endpoint rather than a flag on the one above: a person clicking "stop" must not be able
 * to discard a login by mistyping a parameter.
 */
export const resetComputer: BotRoute = async (
  { botId, session },
  { profiles, sessions },
) => {
  /*
   * THE BOT'S STATE IN THIS PROCESS GOES WITH ITS PROFILE, AND BEFORE IT.
   *
   * Control used to be released AFTER the profile was deleted, and releasing writes
   * `control.json` into the profile directory — which recreated the directory the line above had
   * just removed. Measured 2026-09-13: after a reset `/computers` still listed the Bot, from a
   * directory holding nothing but that file. It is the same Bot's answer to "which computers are
   * there", after the one call that was supposed to end it. So the session is dropped first,
   * without writing anything, and a Bot used again after a reset starts from a session of its own.
   */
  sessions.drop(botId);
  forgetSecretFields(session);
  await stopViewer(session).catch(() => undefined);
  // Always answers: a browser that will not close is killed (profiles.ts, closeAndWait), so a
  // reset cannot be the fourth thing queued behind a page that never loaded.
  await profiles.reset(botId);
  return json({ reset: true, botId });
};
