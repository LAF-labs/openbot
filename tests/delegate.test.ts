import { describe, expect, test } from "bun:test";
import { modeText, promptModeOf, staticPrompt } from "../shared/prompt/index";
import { BROWSE_KO } from "../shared/prompt/mode/browse.ko";
import { THINK_KO } from "../shared/prompt/mode/think.ko";
import { CORE_TOOL_NAMES } from "../shared/tools/bridge";
import { COMPUTER_TOOLS, drivesTheBrowser } from "../shared/tools/computer";
import {
  DELEGATE,
  DELEGATE_TARGETS,
  DELEGATED_MODES,
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
    ["think", "think"],
    ["Think", undefined],
    ["background", undefined],
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
   * AT THE HEAD OF THE PROMPT, NOT BEHIND THE BRIDGE. A name that is not core is reached through
   * `tool_search`, and the conversation's Bot would have to look for the one way it has of
   * opening a page.
   */
  test("is a core name: the Bot of a conversation is handed it outright", () => {
    expect(CORE_TOOL_NAMES.has(DELEGATE.name)).toBe(true);
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

/*
 * WHAT A CONVERSATION'S BOT IS TOLD, NOW THAT IT HOLDS NO TOOL OF THE BROWSER'S. The chat mode
 * named the two tools that call a person, because it was the only mode with a person to call. They
 * are the delegated run's now. A mode that names a tool its Bot is not handed has the model
 * knocking on a door that is not there — the mistake `routine.ko.ts` records at its head.
 */
describe("the chat mode, for a Bot that hands its browsing over", () => {
  const BROWSER = COMPUTER_TOOLS.map((tool) => tool.name).filter(
    drivesTheBrowser,
  );

  test("there are eleven such tools, and the folder's three are not among them", () => {
    expect(BROWSER).toHaveLength(COMPUTER_TOOLS.length - 3);
  });

  test.each(COMPUTER_TOOLS.map((tool) => tool.name).filter(drivesTheBrowser))(
    "names no %s",
    (name) => {
      expect(staticPrompt("chat")).not.toContain(name);
    },
  );

  test("names the hand-over, and says a value for a page is not its to ask a person for", () => {
    expect(modeText("chat")).toContain(DELEGATE.name);
    expect(modeText("chat")).toContain("네가 사람에게 묻지 않는다");
    // The delegated run is told the other half: it asks, through the masked box.
    expect(modeText("browse")).toContain("computer_request_secret");
  });

  test("a routine's mode is as it was: nobody to hand anything to", () => {
    expect(modeText("routine")).not.toContain(DELEGATE.name);
  });
});

/*
 * THINKING, HANDED OVER (piece 6-3). The second thing a conversation's Bot can hand to a run of
 * its own: a problem to be worked through, by the same Bot in a conversation that holds no tool.
 */
describe("the one handed thinking", () => {
  test("each kind of work is done in a mode of its own, which a run can name", () => {
    expect(DELEGATED_MODES).toEqual({ browser: "browse", think: "think" });
    expect(Object.keys(DELEGATED_MODES)).toEqual([...DELEGATE_TARGETS]);
    for (const mode of Object.values(DELEGATED_MODES)) {
      expect(promptModeOf({ mode })).toBe(mode);
    }
    expect(modeText("think")).toBe(THINK_KO);
    expect(staticPrompt("think")).toContain(THINK_KO);
    expect(modeText("think")).not.toBe(modeText("browse"));
    expect(modeText("think")).not.toBe(modeText("chat"));
  });

  test("the tool says what each is for — and when thinking is not to be handed over", () => {
    expect(DELEGATE.description).toContain("browser:");
    expect(DELEGATE.description).toContain("think:");
    // Handing over what could be answered outright makes every answer two requests.
    expect(DELEGATE.description).toContain(
      "바로 답할 수 있는 것은 맡기지 않는다",
    );
    // The run it is handed to can look nothing up: what is not in the task is not known.
    expect(DELEGATE.description).toContain("먼저 알아본 뒤에 맡긴다");
    expect(
      (
        DELEGATE.parameters as unknown as {
          properties: { to: { description: string } };
        }
      ).properties.to.description,
    ).toContain("think");
  });

  test("its mode names no tool at all: it holds none", () => {
    for (const tool of COMPUTER_TOOLS) {
      expect(THINK_KO).not.toContain(tool.name);
    }
    for (const name of [
      DELEGATE.name,
      "remember",
      "tool_search",
      "tool_call",
    ]) {
      expect(THINK_KO).not.toContain(name);
    }
  });

  test("it is told the task is all there is, that it can ask nobody, and who reads its answer", () => {
    expect(THINK_KO).toContain("아래 메시지가 그 일의 전부");
    expect(THINK_KO).toContain("적혀 있지 않은 것을 지어내지 않는다");
    expect(THINK_KO).toContain("사람에게 물을 수도 없다");
    expect(THINK_KO).toContain(
      "마지막 답은 사람이 아니라 일을 맡긴 쪽이 읽는다",
    );
  });

  test("a routine's mode and a browsing run's are as they were: neither is told of thinking", () => {
    expect(modeText("routine")).not.toContain("think");
    expect(modeText("browse")).toBe(BROWSE_KO);
    expect(BROWSE_KO).not.toContain("think");
  });
});
