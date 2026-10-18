import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { DocDoors } from "../src/components/docs/doc-controller";
import type { DocBlock } from "../src/lib/hub/docs";

/**
 * A KOREAN SYLLABLE BEING ASSEMBLED IN A DOCUMENT'S BLOCK IS NEVER WRITTEN OVER.
 *
 * A block's box (`components/docs/block-textarea.tsx`) is uncontrolled: React gives it its text when
 * it opens and never again on a render, because a value written into a box mid-syllable breaks the
 * syllable into jamo (measured on the composer, `composer-korean-ime.test.tsx`). The one time the
 * page must change the text — a save a colleague beat, reopened with theirs — waits for
 * `compositionend`. And an Enter that finishes a syllable is the syllable's, never a new block.
 *
 * happy-dom has no input method, so a composition is delivered as a browser delivers one, and what
 * is asserted is that nobody but the "input method" wrote the box's value while it was live — every
 * write to `value` is counted — and that the box is the same node throughout.
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

/** Counts what writes the box's value from outside, keeping whatever React put on the node. */
function countWrites(box: HTMLTextAreaElement) {
  const native = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(box),
    "value",
  );
  const own = Object.getOwnPropertyDescriptor(box, "value") ?? native;
  if (!own?.get || !own.set || !native?.set) {
    throw new Error("no value property");
  }
  const typed = native.set;
  const { get, set } = own;
  const counted = { writes: 0 };
  Object.defineProperty(box, "value", {
    configurable: true,
    get() {
      return get.call(this);
    },
    set(next: string) {
      counted.writes += 1;
      set.call(this, next);
    },
  });
  /** What the input method types: the browser's own write, under React's record of the value. */
  const type = (value: string) => typed.call(box, value);
  return { counted, type };
}

async function mountBox(props: { text: string; reset: number }) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { BlockTextarea } = await import(
    "../src/components/docs/block-textarea"
  );
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const texts: string[] = [];
  const render = async (next: { text: string; reset: number }) => {
    await act(async () => {
      root.render(
        createElement(BlockTextarea, {
          ariaLabel: "글",
          caret: "end",
          onBlur: () => {},
          onCompositionEnd: (value: string) => texts.push(`end:${value}`),
          onCompositionStart: () => {},
          onKeyDown: () => {},
          onText: (value: string) => texts.push(value),
          reset: next.reset,
          text: next.text,
        }),
      );
    });
  };
  await render(props);
  const box = host.querySelector("textarea");
  if (!box) throw new Error("no box");
  return { act, box, render, root, texts };
}

describe("a block's box and a syllable being assembled", () => {
  test("renders that carry newer text never write the box", async () => {
    const { act, box, render, root, texts } = await mountBox({
      text: "가",
      reset: 0,
    });
    const { counted, type } = countWrites(box);
    await act(async () => {
      box.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      type("가ㄴ");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ㄴ" }));
    });
    // The page draws again mid-syllable with text a step behind the box — as a render that lands
    // between a keystroke and its save does. A box that took its value from the page would lose
    // the jamo here.
    await render({ text: "가", reset: 0 });
    await act(async () => {
      type("가나");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, data: "나" }));
      box.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "나" }),
      );
    });
    expect(counted.writes).toBe(0);
    expect(box.value).toBe("가나");
    expect(texts).toEqual(["가ㄴ", "가나", "end:가나"]);
    await act(async () => root.unmount());
  });

  test("a colleague's text that arrives mid-syllable waits for the syllable's end", async () => {
    const { act, box, render, root } = await mountBox({
      text: "원래",
      reset: 0,
    });
    const node = box;
    const { counted, type } = countWrites(box);
    await act(async () => {
      box.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      type("원래ㅎ");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ㅎ" }));
    });
    await render({ text: "민수가 고친 글", reset: 1 });
    expect(counted.writes).toBe(0);
    expect(box.value).toBe("원래ㅎ");
    await act(async () => {
      type("원래하");
      box.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "하" }),
      );
    });
    expect(counted.writes).toBe(1);
    expect(box.value).toBe("민수가 고친 글");
    expect(document.querySelector("textarea")).toBe(node);
    await act(async () => root.unmount());
  });

  test("outside a syllable, a reopened block shows the colleague's text at once", async () => {
    const { act, box, render, root } = await mountBox({
      text: "원래",
      reset: 0,
    });
    await render({ text: "민수가 고친 글", reset: 1 });
    expect(box.value).toBe("민수가 고친 글");
    await act(async () => root.unmount());
  });
});

describe("Enter in a block being written in", () => {
  test("finishing a syllable makes no block; the person's own Enter makes one", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { DocBlockView } = await import("../src/components/docs/doc-block");
    const { createDocController } = await import(
      "../src/components/docs/doc-controller"
    );
    const block: DocBlock = {
      id: "b_1",
      kind: "paragraph",
      text: "한",
      attrs: {},
      version: 1,
      hash: "h",
    };
    const doors: DocDoors = {
      read: async () => ({
        doc: {
          id: "d",
          title: "",
          folder: "/",
          updatedAt: null,
          updatedBy: null,
        },
        blocks: [block],
        holds: [],
      }),
      readBlock: async () => block,
      save: async () => [],
      lock: async () => "held",
      unlock: async () => {},
    };
    const controller = createDocController({ doors });
    controller.load(await doors.read());
    controller.focus("b_1");
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const draw = async () => {
      const state = controller.snapshot();
      await act(async () => {
        root.render(
          createElement(
            "div",
            null,
            state.rows.map((row) =>
              createElement(DocBlockView, {
                caret: state.caret,
                controller,
                holderName: null,
                isActive: state.activeKey === row.key,
                key: row.key,
                row,
              }),
            ),
          ),
        );
      });
    };
    await draw();
    const box = host.querySelector("textarea");
    if (!box) throw new Error("no box");
    box.setSelectionRange(1, 1);
    await act(async () => {
      box.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
          isComposing: true,
        }),
      );
    });
    expect(controller.snapshot().rows).toHaveLength(1);
    await act(async () => {
      box.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      );
    });
    expect(controller.snapshot().rows.map((row) => row.block.text)).toEqual([
      "한",
      "",
    ]);
    controller.close();
    await act(async () => root.unmount());
  });
});
