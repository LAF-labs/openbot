import { describe, expect, test } from "bun:test";
import {
  type AskSubject,
  allowanceScopeOf,
  askSubjectOf,
  type PendingApproval,
  questionFromRecord,
} from "../src/lib/approvals";

/** What the server sends about a navigation it stopped, in the shape the record carries. */
const OPENING: AskSubject = {
  kind: "browser",
  intent: "navigate",
  host: "wttr.in",
  reason: "policy_ask",
};

/** The server's record of that question, with nothing on it a question need not have. */
const RECORD: PendingApproval = {
  id: "a-1",
  botId: "bot-1",
  rule: "",
  subject: OPENING,
  requestedAt: "2026-09-03T09:00:00.000Z",
  expiresAt: "2026-09-03T09:10:00.000Z",
};

/**
 * The hop between the server's record of a question and the card that draws it.
 *
 * This is here because it broke, when the hop was a pause reply read by the window that had made
 * the call. The scope a person is asked to consent to was added on the server, carried out through
 * the pause reply, read by the card and translated — and dropped in the middle, by a function that
 * assembled its result field by field and had never been told the field existed. Every test on both
 * sides passed. The button simply was not there.
 *
 * The server carries the calls out now and a window reads the question off the server's record
 * (`questionFromRecord`), which is the same assembly, field by field. So this is what that one
 * function must keep doing: carry everything the record has.
 */

describe("reading a question off the server's record", () => {
  test("carries everything the record said", () => {
    expect(
      questionFromRecord({
        ...RECORD,
        rule: 'intent == "navigate"',
        scope: { kind: "host", value: "wttr.in" },
      }),
    ).toEqual({
      approvalId: "a-1",
      botId: "bot-1",
      subject: OPENING,
      rule: 'intent == "navigate"',
      scope: { kind: "host", value: "wttr.in" },
      expiresAt: "2026-09-03T09:10:00.000Z",
    });
  });

  test("a record with no scope leaves the card offering this once alone", () => {
    expect(questionFromRecord(RECORD).scope).toBeUndefined();
  });

  test("the conversation the question came from is carried, and only when it said one", () => {
    // The middle button — "for this conversation" — is drawn off this field and nothing else, so
    // a record that names the thread has to reach the card with it, and one that does not must not
    // arrive with an empty string the card would read as a conversation.
    expect(
      questionFromRecord({
        ...RECORD,
        scope: { kind: "host", value: "wttr.in" },
        threadId: "thread-7",
      }).threadId,
    ).toBe("thread-7");
    expect(questionFromRecord({ ...RECORD, threadId: "" })).not.toHaveProperty(
      "threadId",
    );
    expect(questionFromRecord(RECORD)).not.toHaveProperty("threadId");
  });

  test("a subject it cannot read is no subject at all", () => {
    // The card says it cannot name what is being asked about rather than composing a sentence out of
    // a shape nobody sent.
    expect(
      questionFromRecord({
        ...RECORD,
        subject: { kind: "browser" } as unknown as AskSubject,
      }).subject,
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
