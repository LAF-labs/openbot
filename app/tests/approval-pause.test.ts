import { describe, expect, test } from "bun:test";
import {
  allowanceScopeOf,
  type AskSubject,
  askSubjectOf,
  pauseFrom,
} from "../src/lib/approvals";

/** What the server sends about a navigation it stopped, in the shape the reply carries. */
const OPENING: AskSubject = {
  kind: "browser",
  intent: "navigate",
  host: "wttr.in",
  reason: "policy_ask",
};

/**
 * The hop between the server's pause reply and the card that draws it.
 *
 * This is here because it broke. The scope a person is asked to consent to was added on the server,
 * carried out through the pause reply, read by the card and translated — and dropped in the middle,
 * by a function that assembled its result field by field and had never been told the field existed.
 * Every test on both sides passed. The button simply was not there.
 *
 * So the reading is one function now, and this is what it must keep doing: carry everything the
 * reply has, and answer null for anything that is not a pause at all.
 */

describe("reading a pause reply", () => {
  test("carries everything the reply said", () => {
    expect(
      pauseFrom({
        awaitingApproval: true,
        approvalId: "a-1",
        subject: OPENING,
        rule: 'intent == "navigate"',
        scope: { kind: "host", value: "wttr.in" },
        expiresAt: "2026-09-03T09:10:00.000Z",
      }),
    ).toEqual({
      approvalId: "a-1",
      subject: OPENING,
      rule: 'intent == "navigate"',
      scope: { kind: "host", value: "wttr.in" },
      expiresAt: "2026-09-03T09:10:00.000Z",
    });
  });

  test("a reply with no scope leaves the card offering this once alone", () => {
    const pause = pauseFrom({
      awaitingApproval: true,
      approvalId: "a-1",
      subject: OPENING,
      rule: null,
    });
    expect(pause?.scope).toBeUndefined();
  });

  test("a subject it cannot read is no subject at all", () => {
    /*
     * The card says it cannot name what is being asked about rather than composing a sentence out of
     * a shape nobody sent. This used to read the reply's `error` as the question, which worked while
     * the error WAS the question in English; it is a fact code now, and "laf:awaiting_approval" is
     * not a thing to put in front of somebody with two buttons under it.
     */
    expect(
      pauseFrom({
        awaitingApproval: true,
        approvalId: "a",
        error: "laf:awaiting_approval",
      })?.subject,
    ).toBeUndefined();
    expect(askSubjectOf({ kind: "browser" })).toBeUndefined();
    expect(
      askSubjectOf({
        kind: "elsewhere",
        intent: "activate",
        reason: "policy_ask",
      }),
    ).toBeUndefined();
    expect(
      askSubjectOf({
        kind: "browser",
        intent: "teleport",
        reason: "policy_ask",
      }),
    ).toBeUndefined();
    expect(askSubjectOf(OPENING)).toEqual(OPENING);
  });

  test("anything that is not a pause is not one", () => {
    expect(pauseFrom(null)).toBeNull();
    expect(pauseFrom({})).toBeNull();
    // The flag is checked for `true`, not for truthiness: a body that merely mentions it is not a
    // question anybody was asked, and reading one as a pause would hold a turn open forever.
    expect(pauseFrom({ awaitingApproval: "yes" })).toBeNull();
    expect(pauseFrom({ awaitingApproval: false, approvalId: "a" })).toBeNull();
  });
});

describe("reading a scope", () => {
  test("takes the three kinds and nothing else", () => {
    expect(allowanceScopeOf({ kind: "host", value: "a" })).toEqual({
      kind: "host",
      value: "a",
    });
    // A kind the surface has no words for would put a button on screen whose label had to be
    // guessed at, which is the one thing a consent button must never be.
    expect(
      allowanceScopeOf({ kind: "everything", value: "a" }),
    ).toBeUndefined();
    expect(allowanceScopeOf({ kind: "host" })).toBeUndefined();
    expect(allowanceScopeOf({ kind: "host", value: "" })).toBeUndefined();
    expect(allowanceScopeOf(null)).toBeUndefined();
    expect(allowanceScopeOf("host=a")).toBeUndefined();
  });
});
