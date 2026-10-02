import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";

/**
 * 수첩's line editor and a Korean keyboard.
 *
 * The Enter that accepts a syllable is the input method's, not the person's (`lib/ime.ts`). Every
 * other keydown handler in the app had the check; this one saved on that keystroke — a line being
 * written in Korean was filed as whatever had been assembled so far. Found 2026-10-02 by reading
 * what upstream OpenBot had fixed for composed characters (#576) and looking for the same in ours.
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

async function editor(onCancel?: () => void) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LineEditor } = await import("../src/components/notebook/notebook");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const saved: string[] = [];
  await act(async () => {
    root.render(
      createElement(LineEditor, {
        initial: "",
        isBusy: false,
        label: "기억",
        onSave: async (content: string) => {
          saved.push(content);
          return true;
        },
        placeholder: "",
        saveLabel: "저장",
        ...(onCancel ? { onCancel } : {}),
      }),
    );
  });
  const box = host.querySelector("textarea");
  if (!box) throw new Error("no text box on screen");
  const type = async (value: string) => {
    await act(async () => {
      // React reads a controlled field through the native setter, as a browser's typing does.
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = async (init: KeyboardEventInit & { keyCode?: number }) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      box.dispatchEvent(event);
    });
    return event;
  };
  const close = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { saved, type, press, close };
}

describe("수첩's line editor on a Korean keyboard", () => {
  test("the Enter that accepts a syllable does not save; the next one does", async () => {
    const { saved, type, press, close } = await editor();
    await type("가게는 화요일에 쉰");
    // The input method's Enter: still composing the last syllable.
    const composing = await press({ key: "Enter", isComposing: true });
    expect(saved).toEqual([]);
    // Left to the input method, which is what turns the keystroke into the syllable.
    expect(composing.defaultPrevented).toBe(false);
    // The very first keystroke of a composition arrives as "Process", before any composition event.
    await press({ key: "Process", keyCode: 229 });
    expect(saved).toEqual([]);

    await type("가게는 화요일에 쉰다");
    const own = await press({ key: "Enter" });
    expect(own.defaultPrevented).toBe(true);
    expect(saved).toEqual(["가게는 화요일에 쉰다"]);
    await close();
  });

  test("Shift+Enter is a new line, composing or not", async () => {
    const { saved, type, press, close } = await editor();
    await type("첫 줄");
    const event = await press({ key: "Enter", shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(saved).toEqual([]);
    await close();
  });

  test("the Escape that abandons a syllable does not close the editor", async () => {
    let cancelled = 0;
    const { type, press, close } = await editor(() => {
      cancelled += 1;
    });
    await type("고치는 중");
    await press({ key: "Escape", isComposing: true });
    expect(cancelled).toBe(0);
    await press({ key: "Escape" });
    expect(cancelled).toBe(1);
    await close();
  });
});
