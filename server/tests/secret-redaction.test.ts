import { describe, expect, test } from "bun:test";
import { SECRET_FIELD_RULE } from "../src/computer/default-policy";
import {
  isSecretFieldRefusal,
  redactSecretTyping,
  SECRET_REDACTION,
} from "../src/runner/secret-redaction";
import type { StoredMessage } from "../src/runner/thread-store";

/**
 * THE RULE THAT DECIDES WHETHER A CREDENTIAL SURVIVES A TURN.
 *
 * Its whole reason to exist is a case that leaves no trace anywhere else: the gateway refuses the
 * typing, the refusal is correct and complete, and the value the model should never have had stays
 * in the history and is replayed into the context window on every following turn. Nothing about
 * that is visible from a passing suite, so this file drives the rule directly and asserts on the
 * serialised result — the same discipline the demonstration recorder's test uses.
 *
 * `SECRET_FIELD_RULE` is imported rather than pasted. It is the expression the boundary actually
 * refuses with, and a wave that rewrites it should break this test rather than quietly leave the
 * detector matching a string nothing sends any more.
 */

/** Distinctive enough that finding it in a serialised message means what it looks like it means. */
const PASSWORD = "hunter2-Zx9-BANKPASS";

/** A card number: sixteen digits, which is a shape the memory store's filter recognises. */
const CARD = "4111-1111-1111-9613";

const typing = (
  callId: string,
  text: string,
  extra: Record<string, unknown> = {},
): StoredMessage =>
  ({
    id: `assistant-${callId}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: callId,
        type: "function",
        function: {
          name: "computer_type",
          arguments: JSON.stringify({ ref: "e4", snapshotId: 3, text }),
        },
      },
    ],
    ...extra,
  }) as StoredMessage;

const answer = (callId: string, content: string): StoredMessage =>
  ({
    id: `tool-${callId}`,
    role: "tool",
    toolCallId: callId,
    content,
  }) as StoredMessage;

/** What the app's fetch wrapper hands the model for a 403 (`computer-tools.tsx`). */
const attendedRefusal = JSON.stringify({
  ok: false,
  reason: "A rule refused typing into that field.",
  refused: true,
  rule: SECRET_FIELD_RULE,
});

/** What the unattended loop hands the model for the same refusal (`outcomeOfError`). */
const unattendedRefusal = JSON.stringify({
  ok: false,
  refused: true,
  reason: "Typing into a password box is refused.",
  rule: SECRET_FIELD_RULE,
});

/** An ordinary successful type, which is what the great majority of these are. */
const typed = JSON.stringify({
  action: "type",
  url: "https://shop.example/order",
  element: { name: "이름", type: "text" },
});

/** The arguments of the first tool call on a message, parsed. */
const argsOf = (message: StoredMessage): Record<string, unknown> =>
  JSON.parse(
    (message as { toolCalls: { function: { arguments: string } }[] })
      .toolCalls[0].function.arguments,
  );

describe("what a refused typing leaves in the conversation", () => {
  test("takes the value out when the attended path reports the refusal", () => {
    const [stored] = redactSecretTyping([
      typing("t1", PASSWORD),
      answer("t1", attendedRefusal),
    ]);

    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(argsOf(stored).text).toBe(SECRET_REDACTION);
    expect(stored.lafRedacted).toBe(true);
  });

  test("takes it out when the unattended loop reports the same refusal", () => {
    const [stored] = redactSecretTyping([
      typing("t1", PASSWORD),
      answer("t1", unattendedRefusal),
    ]);

    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(argsOf(stored).text).toBe(SECRET_REDACTION);
  });

  test("takes it out when the result carries the code rather than the rule", () => {
    // The shape the gateway decides in and the one a rewrite of its refusal envelope would send.
    // Neither wire path copies `code` onto the tool result today, which is why the rule above is
    // what actually fires — but a detector that could not read the code would go blind the moment
    // one of them started sending it.
    const [stored] = redactSecretTyping([
      typing("t1", PASSWORD),
      answer(
        "t1",
        JSON.stringify({ ok: false, code: "laf:use_request_secret" }),
      ),
    ]);

    expect(argsOf(stored).text).toBe(SECRET_REDACTION);
  });

  test("reads a refusal that never became JSON at all", () => {
    const [stored] = redactSecretTyping([
      typing("t1", PASSWORD),
      answer("t1", "Error: laf:use_request_secret"),
    ]);

    expect(argsOf(stored).text).toBe(SECRET_REDACTION);
  });

  test("keeps everything about the call except the value", () => {
    const [stored] = redactSecretTyping([
      typing("t1", PASSWORD, {}),
      answer("t1", attendedRefusal),
    ]);

    // The field, the snapshot and the tool's own name are what make the turn readable afterwards.
    // Losing them would trade one unreadable transcript for another.
    expect(argsOf(stored)).toEqual({
      ref: "e4",
      snapshotId: 3,
      text: SECRET_REDACTION,
    });
    const [call] = (
      stored as { toolCalls: { id: string; function: { name: string } }[] }
    ).toolCalls;
    expect(call.id).toBe("t1");
    expect(call.function.name).toBe("computer_type");
  });

  test("replaces arguments it cannot parse rather than leaving them", () => {
    const broken = {
      id: "assistant-t1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "t1",
          type: "function",
          function: {
            name: "computer_type",
            // A truncated stream leaves exactly this: valid enough to hold the value, not valid
            // enough to edit field by field.
            arguments: `{"ref":"e4","text":"${PASSWORD}`,
          },
        },
      ],
    } as unknown as StoredMessage;

    const [stored] = redactSecretTyping([
      broken,
      answer("t1", attendedRefusal),
    ]);

    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(argsOf(stored).text).toBe(SECRET_REDACTION);
  });
});

describe("what an ordinary turn keeps", () => {
  test("leaves the text a Bot typed into an ordinary field", () => {
    const [stored] = redactSecretTyping([
      typing("t1", "김기범"),
      answer("t1", typed),
    ]);

    expect(argsOf(stored).text).toBe("김기범");
    expect(stored.lafRedacted).toBeUndefined();
  });

  test("leaves a typing the boundary allowed into a password box", () => {
    /*
     * A successful result names the element it typed into, and that element carries `type` — so a
     * detector that read the shape without checking for a refusal would redact exactly the case
     * where a deployment had decided, in writing, that this Bot may fill that box.
     */
    const [stored] = redactSecretTyping([
      typing("t1", PASSWORD),
      answer(
        "t1",
        JSON.stringify({
          ok: true,
          action: "type",
          element: { name: "pw", type: "password" },
        }),
      ),
    ]);

    expect(argsOf(stored).text).toBe(PASSWORD);
  });

  test("leaves a file the Bot wrote, which is its own work product", () => {
    const writing = {
      id: "assistant-w1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "w1",
          type: "function",
          function: {
            name: "computer_write_file",
            arguments: JSON.stringify({ path: "notes.md", contents: PASSWORD }),
          },
        },
      ],
    } as unknown as StoredMessage;

    const [stored] = redactSecretTyping([writing]);

    expect(JSON.stringify(stored)).toContain(PASSWORD);
  });

  test("leaves a refusal that was about something other than a secret field", () => {
    const [stored] = redactSecretTyping([
      typing("t1", "김기범"),
      answer(
        "t1",
        JSON.stringify({
          ok: false,
          refused: true,
          reason: "Somebody said no to that recently.",
          rule: 'intent == "click"',
          code: "laf:declined_recently",
        }),
      ),
    ]);

    expect(argsOf(stored).text).toBe("김기범");
  });
});

describe("a run that ended before the result arrived", () => {
  test("takes out a value that looks like a secret", () => {
    // No `tool` message: the process died between the call and its answer, so nothing ever said
    // whether the boundary would have refused it.
    const [stored] = redactSecretTyping([typing("t1", CARD)]);

    expect(JSON.stringify(stored)).not.toContain(CARD);
    expect(stored.lafRedacted).toBe(true);
  });

  test("leaves ordinary text, because a crash is not evidence of anything", () => {
    const [stored] = redactSecretTyping([typing("t1", "김기범")]);

    expect(argsOf(stored).text).toBe("김기범");
    expect(stored.lafRedacted).toBeUndefined();
  });

  test("counts a result the thread already holds as a result", () => {
    // The answer landed on an earlier append. The call arriving again in a later batch is not a
    // crash, and reading it as one would apply the pattern where the boundary has already spoken.
    const [stored] = redactSecretTyping(
      [typing("t1", CARD)],
      [typing("t1", CARD), answer("t1", typed)],
    );

    expect(argsOf(stored).text).toBe(CARD);
  });
});

describe("the history coming round again", () => {
  test("does not un-redact when the unredacted copy arrives on the next run", () => {
    /*
     * THE CASE THIS WHOLE MODULE TURNS ON. Every run hands the entire history back as its input,
     * and the store updates a message in place when the incoming copy differs — so the client's
     * still-unredacted copy of the same message id comes round on the very next turn. A rule that
     * only read this batch would put the credential straight back, and the store's own unique index
     * would help it do so.
     */
    const [redacted] = redactSecretTyping([
      typing("t1", PASSWORD),
      answer("t1", attendedRefusal),
    ]);

    const [again] = redactSecretTyping([typing("t1", PASSWORD)], [redacted]);

    expect(JSON.stringify(again)).not.toContain(PASSWORD);
    expect(argsOf(again).text).toBe(SECRET_REDACTION);
    expect(again.lafRedacted).toBe(true);
  });

  test("does not un-redact even when the result now says the action succeeded", () => {
    const [redacted] = redactSecretTyping([typing("t1", CARD)]);

    const [again] = redactSecretTyping(
      [typing("t1", CARD), answer("t1", typed)],
      [redacted],
    );

    expect(argsOf(again).text).toBe(SECRET_REDACTION);
  });

  test("leaves an already-redacted copy alone rather than rewriting its row", () => {
    const [redacted] = redactSecretTyping([
      typing("t1", PASSWORD),
      answer("t1", attendedRefusal),
    ]);

    // Handed its own output back: the same object, so `appendMessages` sees no change and takes no
    // update. A rule that returned a fresh object here would rewrite every stored row every turn.
    const [again] = redactSecretTyping([redacted], [redacted]);

    expect(again).toBe(redacted);
  });
});

describe("reading a refusal off the wire", () => {
  test("says nothing about an empty result", () => {
    expect(isSecretFieldRefusal("")).toBe(false);
    expect(isSecretFieldRefusal("   ")).toBe(false);
  });

  test("reads a subject-shaped refusal without being told a code for it", () => {
    // The `subject.element.type` shape does not exist in this deployment — `FactCode` holds
    // `laf:use_request_secret` and `laf:declined_recently` and nothing else — but it is what a
    // refusal envelope rewrite would most naturally produce, and reading the shape rather than a
    // code name is what lets this survive one.
    expect(
      isSecretFieldRefusal(
        JSON.stringify({
          ok: false,
          refused: true,
          subject: { element: { name: "pw", type: "password" } },
        }),
      ),
    ).toBe(true);
  });

  test("does not read a success as a refusal", () => {
    expect(
      isSecretFieldRefusal(
        JSON.stringify({
          ok: true,
          subject: { element: { type: "password" } },
        }),
      ),
    ).toBe(false);
  });
});
