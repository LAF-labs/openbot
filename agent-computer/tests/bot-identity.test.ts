import { describe, expect, test } from "bun:test";
import { isOpenPath } from "../src/authorisation";

/**
 * WHICH BOT A REQUEST IS FOR.
 *
 * This container holds one browser per Bot: a profile with that Bot's logins, a snapshot generation,
 * a control state saying whose wheel it is, and the proxy its traffic leaves through. Every one of
 * those keys off `x-openbot-bot-id`, and nothing in this repository named that header in a test
 * until this file — which is how the thing below stayed true.
 *
 * `botIdOf` FALLS BACK TO A DEFAULT WHEN THE HEADER IS ABSENT (`src/index.ts`, `DEFAULT_BOT_ID`,
 * `COMPUTER_BOT_ID` or "shared"). So a caller that forgets the header is not refused: it is quietly
 * served a different Bot's browser. The failure has no error in it. The Bot reports that the site
 * has logged it out, or acts on a page belonging to somebody else's session, and the audit row on
 * the server says the call was made for the Bot the server thought it named.
 *
 * The fallback was written for the health check, which genuinely has no Bot. `/health` is also the
 * one path this container serves without a token (below), so "no Bot" and "no token" already
 * describe the same single request — which is why the fallback can be narrowed to it.
 *
 * The two cases below are TODO deliberately. They are the contract this container should keep, and
 * the change that makes them pass belongs to whoever owns this directory: they need `botIdOf` to
 * refuse rather than default, and the fetch handler to answer 400 before it touches a session. See
 * §3.3 and §5.8 of docs/laf/redesign-2026-09.md.
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

  test.todo("a Bot-scoped request with no x-openbot-bot-id is refused with 400, not defaulted", () => {
    /*
     * The expectation, exactly.
     *
     * A request to any path other than `/health` that carries a valid token and no
     * `x-openbot-bot-id` header must answer 400 with `{ error: … }` and must not create a session,
     * launch a profile, or touch a browser. `COMPUTER_BOT_ID` stops being a fallback for every
     * request and becomes, if it stays at all, the id `/health` reports for itself.
     *
     * Today it answers 200 for the Bot named by `COMPUTER_BOT_ID ?? "shared"`.
     */
  });

  test.todo("a /stream upgrade with neither the header nor ?bot is refused the same way", () => {
    /*
     * The socket is the one caller that cannot send a header, so `?bot=` is accepted there and
     * only there. That exception must not become a second fallback: an upgrade carrying neither
     * has to be refused rather than watched against the default Bot's screen, which would show one
     * person another person's browser.
     */
  });
});
