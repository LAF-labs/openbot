import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement, useLayoutEffect } from "react";
import type {
  AgentOption,
  CommandOption,
  ComposerDraft,
} from "../src/components/channels/composer";

/**
 * THE FIRST KEYSTROKES IN A CONVERSATION THAT HAS JUST OPENED.
 *
 * Measured 2026-09-06: a character typed within about half a second of the screen opening ended
 * up at the END of everything typed after it — "안녕하세요" came out as "녕하세요안". One try in
 * three at 0 ms, none once the screen had settled. Two things were wrong, and a green gate saw
 * neither:
 *
 * 1. Nothing focused the editor when the screen opened, so what was typed before the person
 *    clicked into it went to the body.
 * 2. The screen's sources — the roster for `@`, the granted skills for `/` — arrive a moment after
 *    the composer mounts, and every render that carried them rebuilt the editor's trigger list and
 *    its `onChange`. The editor's DOM-sync effect is keyed on both, so each of those renders
 *    re-ran it — and a keystroke that landed between that render's commit and its effects was
 *    compared against the value the render had closed over, judged foreign, and rendered over.
 *    The rebuild dropped the caret at the start of the box, and everything after was typed in
 *    front of the character that had been there.
 *
 * The editor here is the real one, driven the way a browser drives a contenteditable: keydown,
 * beforeinput, the DOM changed at the caret, the caret moved past it, input. The one thing
 * happy-dom does not do that a browser does is move a live range when the node it points into is
 * removed; `caretIn` applies that rule by hand, and says so.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** What the screen passes once its queries have answered. */
type Sources = {
  agents: readonly AgentOption[];
  commands: readonly CommandOption[];
  disabled: boolean;
};

const NOTHING_YET: Sources = { agents: [], commands: [], disabled: false };
const ARRIVED: Sources = {
  agents: [{ id: "bot-1", name: "초롱", description: "가게 비서" }],
  commands: [{ id: "daily-report", name: "daily-report", kind: "chip" }],
  disabled: false,
};

const editorOf = (host: HTMLElement): HTMLElement => {
  const editor = host.querySelector<HTMLElement>('[role="textbox"]');
  if (!editor) throw new Error("no editor on screen");
  return editor;
};

/** What holds the caret, in words a failure can be read from — "textbox", or "body". */
const focused = (): string => {
  const active = document.activeElement;
  if (!active) return "nothing";
  return active.getAttribute("role") ?? active.tagName.toLowerCase();
};

/**
 * Where the next character goes, as a browser would answer it.
 *
 * A browser that removes the node a live range points into collapses the range to the parent at
 * the removal index; happy-dom leaves the range on the detached node. The editor rebuilds by
 * removing every child from the first, so the browser's answer in that case is always the start of
 * the box — which is exactly the position the bug typed into.
 */
const caretIn = (editor: HTMLElement): Range | null => {
  const selection = window.getSelection();
  if (!selection) return null;
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (range && editor.contains(range.startContainer)) return range;
  if (document.activeElement !== editor) return null;
  const collapsed = document.createRange();
  collapsed.setStart(editor, 0);
  collapsed.collapse(true);
  selection.removeAllRanges();
  selection.addRange(collapsed);
  return collapsed;
};

/**
 * One keystroke, delivered the way a browser delivers it to a contenteditable. A character with
 * nowhere to go — no caret in the box — is recorded in `lost` rather than typed anywhere else,
 * which is what a browser does with a keystroke aimed at the body.
 */
const press = (editor: HTMLElement, character: string, lost: string[]) => {
  editor.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: character,
    }),
  );
  const range = caretIn(editor);
  if (!range) {
    lost.push(character);
    return;
  }
  editor.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: character,
      inputType: "insertText",
    }),
  );

  let node: Node = range.startContainer;
  let offset = range.startOffset;
  if (node === editor) {
    const after = editor.childNodes[offset];
    const before = offset > 0 ? editor.childNodes[offset - 1] : undefined;
    if (after?.nodeType === Node.TEXT_NODE) {
      node = after;
      offset = 0;
    } else if (before?.nodeType === Node.TEXT_NODE) {
      node = before;
      offset = (before.textContent ?? "").length;
    } else {
      const fresh = document.createTextNode("");
      editor.insertBefore(fresh, after ?? null);
      node = fresh;
      offset = 0;
    }
  }
  const text = node.textContent ?? "";
  node.textContent = text.slice(0, offset) + character + text.slice(offset);

  const moved = document.createRange();
  moved.setStart(node, offset + character.length);
  moved.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(moved);

  editor.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: character,
      inputType: "insertText",
    }),
  );
};

const typeInto = (editor: HTMLElement, text: string, lost: string[]) => {
  for (const character of text) press(editor, character, lost);
};

/** A click into the box: focus, and a caret at its start. */
const clickInto = (editor: HTMLElement) => {
  editor.focus();
  const range = document.createRange();
  range.setStart(editor, 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

/** Enter, which the editor turns into the composer's submit. */
const pressEnter = (editor: HTMLElement) => {
  editor.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    }),
  );
};

async function mounted() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Composer } = await import("../src/components/channels/composer");

  const sent: string[] = [];
  /**
   * The screen: the composer, and the moment its render has committed.
   *
   * `onCommitted` runs from a layout effect — after the composer's own layout work, before any
   * passive effect of the same render. A browser opens that same window between a render's commit
   * and its deferred effects; a keystroke delivered here lands in it, which is where the bug lived.
   */
  const Screen = ({
    sources,
    onCommitted,
  }: {
    sources: Sources;
    onCommitted?: () => void;
  }) => {
    useLayoutEffect(() => {
      onCommitted?.();
    });
    return createElement(Composer, {
      agents: sources.agents,
      commands: sources.commands,
      compact: true,
      disabled: sources.disabled,
      onSubmit: (draft: ComposerDraft) => {
        sent.push(draft.text);
      },
    });
  };

  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = async (sources: Sources, onCommitted?: () => void) => {
    await act(async () => {
      root.render(createElement(Screen, { onCommitted, sources }));
    });
  };
  return {
    host,
    sent,
    show,
    type: async (text: string, lost: string[]) => {
      await act(async () => {
        typeInto(editorOf(host), text, lost);
      });
    },
    submit: async () => {
      await act(async () => {
        pressEnter(editorOf(host));
      });
    },
  };
}

describe("the first keystrokes in a conversation that has just opened", () => {
  test("land in the box, in the order they were typed, from the moment it opens", async () => {
    const { host, sent, show, type, submit } = await mounted();
    const lost: string[] = [];

    // The screen opens, and the caret is already in the box; the first character goes straight in.
    await show(NOTHING_YET);
    expect(focused()).toBe("textbox");
    await type("안", lost);

    // The roster and the skills answer, and a character lands as that render commits.
    await show(ARRIVED, () => typeInto(editorOf(host), "녕", lost));
    // And the rest, on a settled screen.
    await type("하세요", lost);

    expect(lost).toEqual([]);
    expect(editorOf(host).textContent).toBe("안녕하세요");
    await submit();
    expect(sent).toEqual(["안녕하세요"]);
  });

  test("a keystroke that lands as the late sources are applied keeps its place", async () => {
    const { host, sent, show, type, submit } = await mounted();
    const lost: string[] = [];

    await show(NOTHING_YET);
    // Clicked into, the way a person who got there ahead of the sources would have.
    await (await import("react")).act(async () => {
      clickInto(editorOf(host));
    });

    // The sources arrive; the first character is typed as that render commits.
    await show(ARRIVED, () => typeInto(editorOf(host), "안", lost));
    await type("녕하세요", lost);

    expect(lost).toEqual([]);
    expect(editorOf(host).textContent).toBe("안녕하세요");
    await submit();
    expect(sent).toEqual(["안녕하세요"]);
  });

  test("the compose screen hands the caret over the moment a Bot is picked", async () => {
    const { host, show, type } = await mounted();
    const lost: string[] = [];

    // Nobody chosen yet: the box is disabled and must not take the caret.
    await show({ ...NOTHING_YET, disabled: true });
    expect(focused()).toBe("body");

    // A face is pressed, the box is enabled, and the caret is in it before anything else happens.
    await show(ARRIVED);
    expect(focused()).toBe("textbox");

    await type("안녕", lost);
    expect(lost).toEqual([]);
    expect(editorOf(host).textContent).toBe("안녕");
  });
});
