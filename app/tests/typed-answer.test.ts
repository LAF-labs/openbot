/**
 * Which question words can answer (`lib/turns/typed-answer.ts`).
 *
 * The mounted half is `choice-answer.test.tsx`; this is the rule by itself, with the cards a turn
 * can be stopped on side by side.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  answeredInWords,
  hasResult,
  isSavedByPress,
  openChoiceCall,
  typedAnswer,
  typedAnswerIn,
} from "@/lib/turns/typed-answer";

const call = (id: string, name: string, args: unknown = {}) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const asking = (id: string, ...calls: ReturnType<typeof call>[]) =>
  ({ id, role: "assistant", content: "", toolCalls: calls }) as Message;

const CHOICE = { title: "저녁 메뉴", options: [{ id: "a", label: "한식" }] };

describe("the question words can answer", () => {
  test("is the choice card the turn is stopped on", () => {
    const messages = [asking("m-1", call("c-1", "askChoice", CHOICE))];
    expect(openChoiceCall(messages, ["c-1"])).toBe("c-1");
  });

  test("is the newest of them, when the turn waits on more than one", () => {
    const messages = [
      asking("m-1", call("c-1", "askChoice", CHOICE)),
      asking("m-2", call("c-2", "askChoice", CHOICE)),
    ];
    expect(openChoiceCall(messages, ["c-1", "c-2"])).toBe("c-2");
  });

  test("is not one the turn is no longer waiting on", () => {
    const messages = [asking("m-1", call("c-1", "askChoice", CHOICE))];
    expect(openChoiceCall(messages, [])).toBeNull();
    expect(openChoiceCall(messages, ["c-other"])).toBeNull();
  });

  test("is not a yes-or-no card: words must never be taken for a yes", () => {
    const messages = [
      asking("m-1", call("c-1", "askApproval", { title: "메일 보내기" })),
    ];
    expect(openChoiceCall(messages, ["c-1"])).toBeNull();
  });

  test("is not a connect card", () => {
    const messages = [asking("m-1", call("c-1", "showConnection", {}))];
    expect(openChoiceCall(messages, ["c-1"])).toBeNull();
  });

  test("is not the choice that saves who the person is: that one is a press", () => {
    const messages = [
      asking(
        "m-1",
        call("c-1", "askChoice", { title: "누구세요?", saves: "persona" }),
      ),
    ];
    expect(openChoiceCall(messages, ["c-1"])).toBeNull();
  });

  /*
   * The server keeps what waits by the call's id alone, and a provider's ids are its own to mint.
   * Scanning on past a waiting yes-or-no card to an older choice that carries the same id would
   * hand the approval the person's words: "응", filed as its result, reads as a yes.
   */
  test("is decided by the newest call under a waiting id, never by an older one with the same id", () => {
    const messages = [
      asking("m-1", call("c-1", "askChoice", CHOICE)),
      asking("m-2", call("c-1", "askApproval", { title: "메일 보내기" })),
    ];
    expect(openChoiceCall(messages, ["c-1"])).toBeNull();
    // And the other way round: the newer choice is the one that waits.
    expect(openChoiceCall([...messages].reverse(), ["c-1"])).toBe("c-1");
  });

  test("is a choice whose `saves` says nothing: words are taken where the card says they are", () => {
    for (const saves of [undefined, null]) {
      const messages = [
        asking("m-1", call("c-1", "askChoice", { ...CHOICE, saves })),
      ];
      expect(openChoiceCall(messages, ["c-1"])).toBe("c-1");
      expect(isSavedByPress(saves)).toBe(false);
    }
    expect(isSavedByPress("persona")).toBe(true);
  });

  test("is not a choice whose arguments cannot be read", () => {
    const broken = {
      id: "m-1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "c-1",
          type: "function",
          function: { name: "askChoice", arguments: "{" },
        },
      ],
    } as Message;
    expect(openChoiceCall([broken], ["c-1"])).toBeNull();
  });
});

describe("what the Bot is answered with", () => {
  test("is the person's words, and they are read back as written", () => {
    const sent = typedAnswer("둘 다 말고 냉면");
    expect(sent).toEqual({ answer: "둘 다 말고 냉면" });
    expect(typedAnswerIn(sent)).toBe("둘 다 말고 냉면");
  });

  test("a pressed option, a code, or nothing is not a typed answer", () => {
    expect(typedAnswerIn({ choice: "korean", label: "한식" })).toBeUndefined();
    expect(typedAnswerIn({ answer: "   " })).toBeUndefined();
    expect(typedAnswerIn(undefined)).toBeUndefined();
  });
});

describe("the words a card was answered with, read off the conversation", () => {
  const result = (toolCallId: string, content: string) =>
    ({ id: `r-${toolCallId}`, role: "tool", toolCallId, content }) as Message;
  const question = asking("m-1", call("c-1", "askChoice", CHOICE));

  test("are the call's result, where it is a typed answer", () => {
    const messages = [question, result("c-1", '{"answer":"둘 다 말고 냉면"}')];
    expect(answeredInWords(messages, "c-1")).toBe("둘 다 말고 냉면");
  });

  test("are nothing while the call has no result, or for another call's", () => {
    expect(answeredInWords([question], "c-1")).toBeUndefined();
    const messages = [question, result("c-2", '{"answer":"냉면"}')];
    expect(answeredInWords(messages, "c-1")).toBeUndefined();
  });

  test("and whether its question is over at all is whether the call has a result", () => {
    expect(hasResult([question], "c-1")).toBe(false);
    expect(hasResult([question, result("c-2", "x")], "c-1")).toBe(false);
    expect(hasResult([question, result("c-1", "laf:stopped")], "c-1")).toBe(
      true,
    );
  });

  // An id is decided by its newest call here too: an older call's result is not this one's.
  test("are the newest call's under that id, never an older call's that carried the same one", () => {
    const older = [question, result("c-1", '{"answer":"예전 답"}')];
    const again = asking("m-2", call("c-1", "askChoice", CHOICE));
    expect(answeredInWords([...older, again], "c-1")).toBeUndefined();
    expect(hasResult([...older, again], "c-1")).toBe(false);
    const answered = [...older, again, result("c-1", '{"answer":"이번 답"}')];
    expect(answeredInWords(answered, "c-1")).toBe("이번 답");
    expect(hasResult(answered, "c-1")).toBe(true);
  });

  test("are nothing for any other result: an option pressed, a wait that ran out, a sentence", () => {
    for (const content of [
      '{"choice":"korean","label":"한식"}',
      '{"code":"laf:nobody_answered"}',
      "답이 없었어요",
      '"냉면"',
    ]) {
      const messages = [question, result("c-1", content)];
      expect(answeredInWords(messages, "c-1")).toBeUndefined();
    }
  });
});
