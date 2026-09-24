import { describe, expect, test } from "bun:test";
import { rosterNotice } from "../src/lib/agents/roster-state";
import type { Reading } from "../src/lib/reading";

/**
 * WHAT THE SIDEBAR SAYS ABOUT ITS BOT, OVER EVERY COMBINATION OF ITS TWO READS.
 *
 * MEASURED 2026-09-18 before this: with `/api/agents` answering 500, the roster said
 * 아직 봇이 없습니다 — the empty line was drawn whenever the Bots list was not pending and had no
 * rows, and a list that failed has no rows. Each case here is a thing the column could say.
 */

const ready: Reading<unknown> = { state: "ready", data: [1] };
const empty: Reading<unknown> = { state: "empty", data: [] };
const loading: Reading<unknown> = { state: "loading" };
const failed: Reading<unknown> = {
  state: "failed",
  previous: null,
  isRetrying: false,
};
const stale: Reading<unknown> = {
  state: "failed",
  previous: { state: "ready", data: [1] },
  isRetrying: false,
};

const notice = (bots: Reading<unknown>, conversations: Reading<unknown>) =>
  rosterNotice({ bots, conversations });

describe("the sidebar's line about its Bot", () => {
  test("a Bots list that failed says so — never that there is none", () => {
    const expected = {
      kind: "failed" as const,
      message: "Your Bot could not be loaded.",
      isRetrying: false,
    };
    expect(notice(failed, empty)).toEqual(expected);
    expect(notice(failed, ready)).toEqual(expected);
  });

  test("a list this account cannot have says so, with nothing to press", () => {
    expect(
      notice(
        { state: "unavailable", code: "laf:no_access", why: "not_allowed" },
        ready,
      ),
    ).toEqual({
      kind: "unavailable",
      message: "This account cannot see this here.",
    });
    expect(
      notice(
        { state: "unavailable", code: "laf:not_found", why: "not_configured" },
        ready,
      ),
    ).toEqual({ kind: "unavailable", message: "Bots are not offered here." });
  });

  test("nothing is said while the Bot is loading: the skeleton says it", () => {
    expect(notice(loading, failed)).toBeNull();
  });

  test("the conversations failing is said beside the Bot that did load", () => {
    expect(notice(ready, failed)).toEqual({
      kind: "failed",
      message: "Your conversations could not be loaded.",
      isRetrying: false,
    });
  });

  test("a refresh that failed over either list keeps the row and says it is from before", () => {
    expect(notice(stale, ready)).toEqual({ kind: "stale", isRetrying: false });
    expect(notice(ready, stale)).toEqual({ kind: "stale", isRetrying: false });
    expect(
      notice({ state: "failed", previous: empty, isRetrying: true }, ready),
    ).toEqual({ kind: "stale", isRetrying: true });
  });

  test("a sidebar whose reads answered says nothing, whatever they answered", () => {
    expect(notice(ready, ready)).toBeNull();
    // No "none yet": a person with no Bot is sent to make one before the sidebar is ever drawn.
    expect(notice(empty, empty)).toBeNull();
  });
});
