/**
 * A QUESTION THAT WAS NEVER ASKED IS NOT DRAWN (`toVisibleChatItems`).
 *
 * Pressed on the running app, 2026-10-03: the fleet's model called `askChoice` with `{}`, and a card
 * with no title and no options was drawn and waited on. The server refuses such a call before the
 * turn waits now (`isAskable`, `@shared/tools/gallery`) and the Bot calls again — that one is the
 * card. The refused call, drawn too, is an empty frame above it.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GALLERY_DECISIONS, isAskable } from "@shared/tools/gallery";
import { toVisibleChatItems } from "../src/components/channels/chat-messages";

/** What the server answers a call whose arguments do not fit, as the page receives it. */
const REFUSED = JSON.stringify({
  ok: false,
  code: "laf:tool_arguments_invalid",
  reason: "호출 인자가 그 툴의 정의와 맞지 않는다",
});

const asked = (id: string, name: string, args: unknown, result?: string) => {
  const call = {
    id: `m-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  } as Message;
  return result === undefined
    ? [call]
    : [
        call,
        {
          id: `r-${id}`,
          role: "tool",
          toolCallId: id,
          content: result,
        } as Message,
      ];
};
const drawn = (messages: Message[]) =>
  toVisibleChatItems(messages).map((item) =>
    item.kind === "tool" ? item.toolCall.function.name : item.kind,
  );

const CHOICE = { title: "어느 쪽?", options: [{ id: "a", label: "이쪽" }] };

describe("a question card the server refused for having nothing in it", () => {
  test("is not drawn, and the call the Bot makes again is", () => {
    expect(
      drawn([
        ...asked("c-1", "askChoice", {}, REFUSED),
        ...asked("c-2", "askChoice", CHOICE),
      ]),
    ).toEqual(["askChoice"]);
    expect(drawn(asked("c-1", "askApproval", {}, REFUSED))).toEqual([]);
  });

  test("is drawn until the server has answered: an empty call may be the first half of one arriving", () => {
    expect(drawn(asked("c-1", "askChoice", {}))).toEqual(["askChoice"]);
  });

  test("a question that passed any other way is still drawn: stopped, nobody answered, answered", () => {
    for (const result of [
      JSON.stringify({ ok: false, code: "laf:stopped" }),
      "laf:nobody_answered",
      JSON.stringify({ choice: "a" }),
    ]) {
      expect(drawn(asked("c-1", "askChoice", CHOICE, result))).toEqual([
        "askChoice",
      ]);
    }
  });

  test("only a question: any other call refused for its arguments keeps its line", () => {
    expect(drawn(asked("c-1", "manage_routine", {}, REFUSED))).toEqual([
      "manage_routine",
    ]);
  });
});

describe("what makes a question card askable", () => {
  const option = { id: "a", label: "이쪽" };

  test("a choice needs a question and at least one option with an id and a label", () => {
    expect(
      isAskable("askChoice", { title: "어느 쪽?", options: [option] }),
    ).toBe(true);
    for (const args of [
      {},
      { title: "어느 쪽?" },
      { title: "어느 쪽?", options: [] },
      { title: " ", options: [option] },
      { title: "어느 쪽?", options: [{ id: "a" }] },
      { title: "어느 쪽?", options: [{ id: "", label: "이쪽" }] },
      { title: "어느 쪽?", options: [option, null] },
      { title: "어느 쪽?", options: { a: "이쪽" } },
    ]) {
      expect(isAskable("askChoice", args)).toBe(false);
    }
  });

  test("the persona question needs no options of the Bot's: the card draws its four", () => {
    expect(
      isAskable("askChoice", { title: "어떤 분이세요?", saves: "persona" }),
    ).toBe(true);
    expect(isAskable("askChoice", { saves: "persona" })).toBe(false);
  });

  test("an approval needs its name and what is being agreed to", () => {
    expect(
      isAskable("askApproval", {
        title: "메일 보내기",
        summary: "이 메일을 보낼까요?",
      }),
    ).toBe(true);
    expect(isAskable("askApproval", { title: "메일 보내기" })).toBe(false);
    expect(isAskable("askApproval", { summary: "이 메일을 보낼까요?" })).toBe(
      false,
    );
  });

  test("every other card is not this rule's to refuse — the connect card among them", () => {
    for (const name of GALLERY_DECISIONS) {
      if (name === "askChoice" || name === "askApproval") continue;
      expect(isAskable(name, {})).toBe(true);
    }
    expect(isAskable("showBarChart", {})).toBe(true);
  });
});
