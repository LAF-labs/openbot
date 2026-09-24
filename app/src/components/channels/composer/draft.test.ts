import { describe, expect, test } from "bun:test";
import { chip, type Segment, text } from "prompt-area/helpers";
import { applyCommandChips, type CommandOption, toDraft } from "./draft";

function command(id: string, name: string) {
  return chip({ trigger: "/", value: id, displayText: name });
}

describe("toDraft", () => {
  test("flattens chips back into the plain text sent to the runtime", () => {
    const draft = toDraft([
      command("search", "search"),
      text(" what changed last week?"),
    ]);

    expect(draft.text).toBe("/search what changed last week?");
    expect(draft.isEmpty).toBe(false);
  });

  /*
   * `@` names nobody since 2026-09-24: a person has one Bot. An `@` typed into a message is just a
   * character, and the draft has no list of Bots to carry.
   */
  test("carries no list of Bots, and an @ in the words is only a character", () => {
    const draft = toDraft([text("@초롱 이거 봐줘")]);
    expect(draft).toEqual({
      text: "@초롱 이거 봐줘",
      commandIds: [],
      isEmpty: false,
    });
  });

  test("collects command chips in the order they were typed", () => {
    const draft = toDraft([
      command("search", "search"),
      text(" "),
      command("summarize", "summarize"),
    ]);

    expect(draft.commandIds).toEqual(["search", "summarize"]);
  });

  test("treats whitespace-only content as empty", () => {
    expect(toDraft([text("   ")]).isEmpty).toBe(true);
    expect(toDraft([]).isEmpty).toBe(true);
  });
});

describe("applyCommandChips", () => {
  const commands: CommandOption[] = [
    { id: "search", name: "search", kind: "chip" },
    {
      id: "summarize",
      name: "summarize",
      kind: "prompt",
      prompt: "Summarize this channel.",
    },
    { id: "clear", name: "clear", kind: "action" },
  ];

  test("expands a prompt command into editable text", () => {
    const { segments, actions } = applyCommandChips(
      [command("summarize", "summarize")],
      commands,
    );

    expect(toDraft(segments).text).toBe("Summarize this channel.");
    expect(toDraft(segments).commandIds).toEqual([]);
    expect(actions).toHaveLength(0);
  });

  test("removes an action command and defers its side effect", () => {
    let ran = false;
    const { segments, actions } = applyCommandChips(
      [command("clear", "clear")],
      commands.map((entry) =>
        entry.id === "clear" ? { ...entry, run: () => (ran = true) } : entry,
      ),
    );

    expect(toDraft(segments).isEmpty).toBe(true);
    expect(actions).toHaveLength(1);
    expect(ran).toBe(false);

    for (const action of actions) {
      action();
    }
    expect(ran).toBe(true);
  });

  test("leaves chip commands alone and returns the same array", () => {
    const segments: Segment[] = [
      command("search", "search"),
      text(" invoices"),
    ];
    const result = applyCommandChips(segments, commands);

    expect(result.segments).toBe(segments);
    expect(result.actions).toHaveLength(0);
  });

  test("keeps a chip for a command that is no longer registered", () => {
    const { segments } = applyCommandChips([command("search", "search")], []);
    expect(toDraft(segments).commandIds).toEqual(["search"]);
  });
});
