import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";
import {
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_REFUSALS,
  feedbackBody,
  screenFactsFor,
  sendFeedback,
} from "../src/lib/support/feedback";
import {
  forgetTurnFailures,
  lastTurnFailure,
  noteTurnFailure,
} from "../src/lib/support/last-failure";
import { stubFetch } from "./support/fetch";

/**
 * The 문의·의견 box's half of the promise: what leaves this browser, and what 보냈습니다 means.
 *
 * "Send what is on screen too" has to mean exactly two facts, and the way to know it does is to
 * serialise the body and look. The sentence on the other end has to come from a 201, so a request
 * that did not land throws instead of returning something the dialog could draw as sent.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

afterEach(() => {
  forgetTurnFailures();
});

describe("what leaves the browser", () => {
  test("the words alone, trimmed, when the box is not ticked", () => {
    expect(feedbackBody("  안 됩니다  ", null)).toEqual({ text: "안 됩니다" });
  });

  test("the words, the path and the last failure code, when it is", () => {
    noteTurnFailure("laf:turn_rate_limited");
    const facts = screenFactsFor("/channel/abc", lastTurnFailure());

    expect(feedbackBody("안 됩니다", facts)).toEqual({
      text: "안 됩니다",
      screen: { route: "/channel/abc", failureCode: "laf:turn_rate_limited" },
    });
  });

  test("the path alone when this tab has drawn no failure", () => {
    expect(screenFactsFor("/routines", lastTurnFailure())).toEqual({
      route: "/routines",
    });
  });

  test("nothing else, whatever the screen held", () => {
    // The body is the whole of what is sent. Two keys, and the second has two.
    const body = JSON.parse(
      JSON.stringify(
        feedbackBody(
          "x",
          screenFactsFor("/channel/abc", { code: "laf:turn_failed", at: "" }),
        ),
      ),
    );
    expect(Object.keys(body).sort()).toEqual(["screen", "text"]);
    expect(Object.keys(body.screen).sort()).toEqual(["failureCode", "route"]);
  });
});

describe("the last failure this tab drew", () => {
  test("is nothing until a line is drawn, then the latest code", () => {
    expect(lastTurnFailure()).toBeNull();
    noteTurnFailure("laf:turn_unreachable");
    noteTurnFailure("laf:turn_timed_out");
    expect(lastTurnFailure()?.code).toBe("laf:turn_timed_out");
  });

  test("is written by the transcript's failure line and read by the dialog", () => {
    expect(read("components/channels/chat-transcript.tsx")).toContain(
      "noteTurnFailure(code)",
    );
    const dialog = read("components/help/feedback-dialog.tsx");
    expect(dialog).toContain("lastTurnFailure()");
    // Off until ticked, and the current route rather than one typed in.
    expect(dialog).toContain("useState(false)");
    expect(dialog).toContain("useLocation()");
    // No screenshot and no transcript: the dialog reads nothing but the path and the code. It
    // draws no picture of the screen and imports nothing from the conversation.
    expect(dialog).not.toMatch(/canvas|toDataURL|getDisplayMedia|html2canvas/);
    expect(dialog).not.toMatch(/from "@\/lib\/channels|from "@\/lib\/copilot/);
  });
});

describe("sending", () => {
  test("posts the body with the session, and hands back the server's facts", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const receipt = await sendFeedback(
      "잘 쓰고 있습니다",
      null,
      stubFetch(async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            id: "feedback-1",
            receivedAt: "2026-09-06T09:00:00.000Z",
            told: ["support-webhook"],
          }),
          { status: 201 },
        );
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/support/feedback");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      text: "잘 쓰고 있습니다",
    });
    expect(receipt).toEqual({
      id: "feedback-1",
      receivedAt: "2026-09-06T09:00:00.000Z",
      told: ["support-webhook"],
    });
  });

  test("says the limit, in Korean, when the server refuses the length", async () => {
    await expect(
      sendFeedback(
        "x",
        null,
        stubFetch(
          async () =>
            new Response(
              JSON.stringify({ error: "laf:feedback_too_long", limit: 2000 }),
              { status: 400 },
            ),
        ),
      ),
    ).rejects.toThrow(String(FEEDBACK_MAX_LENGTH));
  });

  test("says the generic sentence when the server fell over", async () => {
    await expect(
      sendFeedback(
        "x",
        null,
        stubFetch(async () => new Response("boom", { status: 500 })),
      ),
    ).rejects.toThrow("That did not go through. Try again.");
    // The test runner reads as English; the Korean reader gets this one.
    expect(ko["That did not go through. Try again."]).toBeString();
  });

  test("does not call a 200 with no facts on it a receipt", async () => {
    await expect(
      sendFeedback(
        "x",
        null,
        stubFetch(async () => new Response("{}", { status: 200 })),
      ),
    ).rejects.toThrow();
  });
});

describe("the refusals, read through t(variable)", () => {
  test("every one has Korean", () => {
    for (const sentence of Object.values(FEEDBACK_REFUSALS)) {
      expect(ko[sentence]).toBeString();
    }
  });
});
