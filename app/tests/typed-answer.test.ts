/**
 * Which question words can answer (`lib/turns/typed-answer.ts`).
 *
 * The mounted half is `choice-answer.test.tsx`; this is the rule by itself, with the cards a turn
 * can be stopped on side by side.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
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
