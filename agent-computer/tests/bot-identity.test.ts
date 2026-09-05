import { describe, expect, test } from "bun:test";
import { isBotId, isOpenPath } from "../src/authorisation";

/**
 * WHICH BOT A REQUEST IS FOR.
 *
 * This container holds one browser per Bot: a profile with that Bot's logins, a snapshot generation,
 * a control state saying whose wheel it is, and the proxy its traffic leaves through. Every one of
 * those keys off `x-openbot-bot-id`, and nothing in this repository named that header in a test
 * until this file — which is how both of the things below stayed true for as long as they did.
 *
 * The first was the FALLBACK: a request with no header was served a fixed `"shared"` profile rather
 * than refused, so a caller that forgot it silently drove a different Bot's browser. That is gone;
 * `index.ts` answers `laf:bot_header_missing` on every path but `/health`.
 *
 * The second is what this file now pins. The id was never LOOKED at, and it becomes a directory
 * name: `join(PROFILES_DIR, botId)` is the profile Chromium opens, the `control.json` written on
 * every handover, and the tree `/computers/reset` hands to `rm -rf`. The server did not check it
 * either, and Hono decodes `%2F` in a path parameter before a handler sees it, so
 * `POST /api/computers/..%2F..%2Ftmp%2Fx/control/take` arrived here as `../../tmp/x` and
 * `join("/profiles", that)` is `/tmp/x` — a file written outside the profiles root, as root, by
 * anyone with a session on the server in front.
 *
 * Both ends check now (`server/src/computer/bot-id.ts` is the other), because each of them was once
 * the only one checking and that is exactly how the pair of silent fallbacks got in.
 */
describe("the Bot a request names", () => {
  test("only the health check is served without proof of who is calling", () => {
    // The one request that legitimately has no Bot behind it is also the one that needs no token.
    // Both exceptions describe the same caller, which is what makes narrowing the Bot fallback to
    // this path a change with no second case to find.
    expect(isOpenPath("/health")).toBe(true);
    for (const path of [
      "/navigate",
      "/snapshot",
      "/click",
      "/type",
      "/control/take",
      "/control/secret",
      "/human/secret",
      "/files/write",
      "/computers/reset",
      "/stream",
    ]) {
      expect([path, isOpenPath(path)]).toEqual([path, false]);
    }
  });

  test("a Bot id that could mean somewhere else is not a Bot id", () => {
    for (const id of [
      // The measured one, as it arrived on the header.
      "../../tmp/x",
      "..",
      ".",
      "profiles/../etc",
      "a/b",
      "a\\b",
      // `/profiles/.ssh` is a directory too, and it is not this Bot's profile.
      ".ssh",
      "-flag",
      "%2e%2e",
      "bot 7",
      // A dot is a path's punctuation, and no id the server mints has one.
      "a.b",
      // The id also goes back out in log lines and, on the server side, in a header value.
      "bot\r\n7",
      "봇",
      "",
      "x".repeat(129),
    ]) {
      expect([id, isBotId(id)]).toEqual([id, false]);
    }
    for (const value of [null, undefined, 7, {}]) {
      expect(isBotId(value)).toBe(false);
    }
  });

  test("every id this product mints is still one", () => {
    // A check that also refused `agent_<uuid>` would take the browser away from every Bot anybody
    // has made — the same failure as the fallback, arriving from the other direction.
    for (const id of [
      "agent_2f1c9a3e-7d24-4a6b-9b1e-0c8f5d2a7b41",
      "bot-1",
      "health",
      "a",
      "x".repeat(128),
    ]) {
      expect([id, isBotId(id)]).toEqual([id, true]);
    }
  });
});
