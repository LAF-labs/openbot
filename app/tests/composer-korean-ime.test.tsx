import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";
import type {
  CommandOption,
  ComposerDraft,
} from "../src/components/channels/composer";

/**
 * A KOREAN SYLLABLE BEING ASSEMBLED IS A LIVE THING IN THE DOM, AND THE COMPOSER MUST NOT TOUCH IT.
 *
 * Reported by the owner and reproduced 2026-09-21 against the built app, driven with a real
 * composition through CDP (`Input.imeSetComposition` → `Input.insertText`): "오" arrived as the two
 * jamo "ㅇㅗ". Two things do that and nothing else measured did —
 *
 *   - the editor's nodes being replaced while the composition is live, which is what the editor
 *     does whenever the value handed back differs from its own record of the DOM
 *     (`prompt-area`: `renderSegmentsToDOM`), and
 *   - the box being disabled and re-enabled under the person's hands, which is `contenteditable`
 *     going away and coming back. On Home that used to happen on every cold open: `disabled` was
 *     `!selected`, and there is nobody selected until the roster answers.
 *
 * Both are ours. This file holds the first: every keystroke in a composition, including the one
 * that adds a second `@` mention — the one case where the composer used to rewrite the segments —
 * leaves the editor's own nodes alone. The second is `home-composer-ready.test.tsx`.
 *
 * happy-dom has no input method, so the composition is delivered the way a browser delivers one:
 * `compositionstart`, then `compositionupdate` + `beforeinput` + `input` per jamo with
 * `isComposing` true, then `compositionend`. What is asserted is not the text — happy-dom would
 * agree with anything — but that the node the caret lives in is still the same node afterwards,
 * which is the fact a browser turns into a broken syllable.
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

const COMMANDS: readonly CommandOption[] = [
  { id: "daily-report", name: "daily-report", kind: "chip" },
];

const editorOf = (host: HTMLElement): HTMLElement => {
  const editor = host.querySelector<HTMLElement>('[role="textbox"]');
  if (!editor) throw new Error("no editor on screen");
  return editor;
};

/** The text node the caret is in, made if the box is still empty — as a browser makes one. */
function caretNode(editor: HTMLElement): Text {
  const existing = [...editor.childNodes].find(
    (node): node is Text => node.nodeType === Node.TEXT_NODE,
  );
  if (existing) return existing;
  const fresh = document.createTextNode("");
  editor.append(fresh);
  const range = document.createRange();
  range.setStart(fresh, 0);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return fresh;
}

/**
 * One syllable, assembled and then committed, with the DOM changed at each step the way the
 * browser changes it for `insertCompositionText`.
 */
function composeSyllable(editor: HTMLElement, steps: string[], commit: string) {
  const node = caretNode(editor);
  const before = node.textContent ?? "";
  editor.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
  );
  for (const marked of steps) {
    editor.dispatchEvent(
      new CompositionEvent("compositionupdate", {
        bubbles: true,
        data: marked,
      }),
    );
    editor.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: marked,
        inputType: "insertCompositionText",
      }),
    );
    node.textContent = before + marked;
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: marked,
        inputType: "insertCompositionText",
      }),
    );
  }
  node.textContent = before + commit;
  editor.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true, data: commit }),
  );
  return node;
}

/** What a screen hands down, before and after its queries answer. */
type Sources = {
  commands: readonly CommandOption[];
};

const NOTHING_YET: Sources = { commands: [] };
const ARRIVED: Sources = { commands: COMMANDS };

async function mounted() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Composer } = await import("../src/components/channels/composer");

  const sent: ComposerDraft[] = [];
  const Screen = ({ sources }: { sources: Sources }) =>
    createElement(
      "div",
      null,
      createElement(Composer, {
        // New arrays every render, the way a screen that maps a query result hands them down.
        commands: sources.commands.map((command) => ({ ...command })),
        compact: true,
        onSubmit: (draft: ComposerDraft) => {
          sent.push(draft);
        },
      }),
    );

  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const show = async (sources: Sources) => {
    await act(async () => {
      root.render(createElement(Screen, { sources }));
    });
  };
  await show(NOTHING_YET);
  return { host, root, sent, show };
}

describe("a Korean syllable being assembled in the composer", () => {
  test("keeps the node the caret is in, from the first keystroke in an empty box", async () => {
    const { host, root } = await mounted();
    const { act } = await import("react");
    const editor = editorOf(host);

    let node: Text | null = null;
    await act(async () => {
      node = composeSyllable(editor, ["ㅇ", "오"], "오");
    });

    expect(node).not.toBeNull();
    // The node the syllable was assembled in is still in the box: nothing rebuilt it underneath.
    expect(editor.contains(node as unknown as Node)).toBe(true);
    expect(editor.textContent).toBe("오");
    // And the box is still editable: `contenteditable` going away is the other way to lose one.
    expect(editor.getAttribute("contenteditable")).toBe("true");

    await act(async () => {
      root.unmount();
    });
  });

  test("survives the screen's own sources arriving in the middle of it", async () => {
    // The roster for `@` and the granted skills for `/` land a moment after the composer mounts —
    // the render that carries them is the one the 2026-09-06 first-keystroke bug lived in, and a
    // render that rebuilds the editor is a render that throws away a syllable in progress.
    const { host, root, show } = await mounted();
    const { act } = await import("react");
    const editor = editorOf(host);

    const node = caretNode(editor);
    const before = node.textContent ?? "";
    await act(async () => {
      editor.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
      );
      node.textContent = `${before}ㅇ`;
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: "ㅇ",
          inputType: "insertCompositionText",
        }),
      );
    });

    await show(ARRIVED);

    await act(async () => {
      node.textContent = `${before}오`;
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: "오",
          inputType: "insertCompositionText",
        }),
      );
      editor.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "오" }),
      );
    });

    expect(editorOf(host)).toBe(editor);
    expect(editor.contains(node)).toBe(true);
    expect(editor.textContent).toBe("오");

    await act(async () => {
      root.unmount();
    });
  });
});

/** The text at the end of the box, with the caret after it, as a person's typing leaves it. */
function typed(editor: HTMLElement, text: string): Text {
  const node = caretNode(editor);
  node.textContent = text;
  const range = document.createRange();
  range.setStart(node, text.length);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return node;
}

/**
 * The `/` menu takes Enter and Tab as "pick this command" and never asked whether a syllable was
 * still being assembled. MEASURED 2026-09-26: `/리뷰답` with 답 in composition, and the Enter that
 * accepts it picked 리뷰답장 and rebuilt the box under the syllable — `[리뷰답장] 답`, the caret's
 * node gone — and the next Enter sent "/리뷰답장 답" to the Bot.
 */
describe("the / menu while a Korean syllable is being assembled", () => {
  const KOREAN_SKILL: Sources = {
    commands: [{ id: "리뷰답장", name: "리뷰답장", kind: "chip" }],
  };

  async function menuOpenOnReview() {
    const screen = await mounted();
    const { act } = await import("react");
    await screen.show(KOREAN_SKILL);
    const editor = editorOf(screen.host);
    await act(async () => {
      typed(editor, "/리뷰");
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: "뷰",
          inputType: "insertText",
        }),
      );
    });
    let node: Text | null = null;
    await act(async () => {
      editor.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
      );
      node = typed(editor, "/리뷰답");
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: "답",
          inputType: "insertCompositionText",
        }),
      );
    });
    return { ...screen, act, editor, node: node as unknown as Text };
  }

  for (const key of ["Enter", "Tab"]) {
    test(`the ${key} that accepts the syllable picks nothing and rebuilds nothing`, async () => {
      const { act, editor, node, root, sent } = await menuOpenOnReview();

      await act(async () => {
        editor.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key,
            isComposing: true,
          }),
        );
      });

      expect(editor.querySelector("[data-chip-trigger]")).toBeNull();
      expect(editor.contains(node)).toBe(true);
      expect(editor.textContent).toBe("/리뷰답");
      expect(sent).toEqual([]);

      await act(async () => {
        root.unmount();
      });
    });
  }

  test("the Enter after it is the person's own, and picks the command whole", async () => {
    const { act, editor, root, sent } = await menuOpenOnReview();

    await act(async () => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
          isComposing: true,
        }),
      );
      editor.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "답" }),
      );
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: "답",
          inputType: "insertText",
        }),
      );
    });
    await act(async () => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
    });

    expect(
      editor
        .querySelector("[data-chip-trigger]")
        ?.getAttribute("data-chip-value"),
    ).toBe("리뷰답장");
    // No stray half of the name beside the chip, and nothing sent yet.
    expect(editor.textContent?.replace("/리뷰답장", "").trim()).toBe("");
    expect(sent).toEqual([]);

    await act(async () => {
      root.unmount();
    });
  });
});
