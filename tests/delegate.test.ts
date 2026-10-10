import { describe, expect, test } from "bun:test";
import { modeText, promptModeOf, staticPrompt } from "../shared/prompt/index";
import { BROWSE_KO } from "../shared/prompt/mode/browse.ko";
import { CORE_TOOL_NAMES } from "../shared/tools/bridge";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
import {
  DELEGATE,
  DELEGATE_TARGETS,
  delegateTargetOf,
  isDelegated,
} from "../shared/tools/delegate";

/**
 * THE HAND-OVER, AS BOTH SIDES READ IT (piece 6-2, `docs/laf/redesign-2026-10.md` §4).
 *
 * The tool a conversation's Bot is to hold in place of the browser's own, the mark on what the
 * run it hands to leaves in the conversation, and the mode that run is told about itself in.
 */
describe("the tool a conversation hands its browsing over with", () => {
  test("asks for who and what, and both are required", () => {
    expect(DELEGATE.name).toBe("delegate");
    expect(DELEGATE.parameters).toMatchObject({
      type: "object",
      required: ["to", "task"],
      properties: {
        to: { type: "string", enum: [...DELEGATE_TARGETS] },
        task: { type: "string" },
      },
    });
  });

  test.each([
    ["browser", "browser"],
    ["Browser", undefined],
    ["printer", undefined],
    ["", undefined],
    [undefined, undefined],
    [1, undefined],
    [["browser"], undefined],
  ])("who it is handed to: %p is %p", (said, read) => {
    expect(delegateTargetOf(said)).toBe(read as never);
  });

  test("its words name no tool of the browser's: the Bot holding it holds none of them", () => {
    for (const tool of COMPUTER_TOOLS) {
      expect(DELEGATE.description).not.toContain(tool.name);
    }
  });

  /*
   * NOT YET AT THE HEAD OF ANY PROMPT. A core name is in every conversation's schema and in the
   * harness's version, so adding one opens an epoch in every conversation there is. That is the
   * second half's, with the turn that first offers it — until then nothing a deployment runs has
   * changed, and this is what says so.
   */
  test("is not a core name until a turn is offered it", () => {
    expect(CORE_TOOL_NAMES.has(DELEGATE.name)).toBe(false);
  });
});

describe("the mark on what a delegated run leaves in the conversation", () => {
  test.each([
    [{ id: "m1", role: "assistant", lafDelegated: "call-1" }, true],
    [{ id: "m2", role: "tool", lafDelegated: "call-1" }, true],
    [{ id: "m3", role: "assistant" }, false],
    [{ id: "m4", role: "assistant", lafDelegated: true }, false],
    [{ id: "m5", role: "assistant", lafDelegated: null }, false],
  ])("%p → %p", (message, marked) => {
    expect(isDelegated(message)).toBe(marked);
  });
});

describe("the mode a delegated run is told about itself in", () => {
  test("is named by the run, and is none of the others", () => {
    expect(promptModeOf({ mode: "browse" })).toBe("browse");
    expect(modeText("browse")).toBe(BROWSE_KO);
    expect(modeText("browse")).not.toBe(modeText("chat"));
    expect(modeText("browse")).not.toBe(modeText("routine"));
    expect(staticPrompt("browse").endsWith(BROWSE_KO)).toBe(true);
  });

  test("names only tools it is handed, and both of the ones that call a person", () => {
    const named = BROWSE_KO.match(/[a-z]+(?:_[a-z]+)+/g) ?? [];
    const offered = new Set(COMPUTER_TOOLS.map((tool) => tool.name));
    for (const name of named) expect(offered.has(name)).toBe(true);
    // A person is in front of the screen, as in a conversation: it may ask for a value or for help.
    expect(new Set(named)).toEqual(
      new Set(
        COMPUTER_TOOLS.filter((tool) => tool.needsPerson).map(
          (tool) => tool.name,
        ),
      ),
    );
  });

  test("says who reads its answer, and tells it nothing a conversation's Bot is told to do for a person", () => {
    expect(BROWSE_KO).toContain("맡긴 쪽이 읽는다");
    // The tools those sentences name are not among the fourteen.
    for (const name of ["update_profile", "remember", "manage_routine"]) {
      expect(staticPrompt("browse")).not.toContain(name);
    }
  });
});
