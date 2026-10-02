import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createElement } from "react";
import type { ComposerDraft } from "../src/components/channels/composer";

/**
 * WHAT RETURN DOES IN THE COMPOSER: SENDS WITH A REAL KEYBOARD, A NEW LINE ON A PHONE.
 *
 * Pressed in phone emulation on the running app, 2026-10-02 (touch-first, 375px): "첫 줄" and Return
 * prevented the key and handed the words to the server. A screen keyboard has no Shift+Return, so a
 * second line could not be typed at all.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realMatchMedia = () => window.matchMedia;
let restoreMatchMedia: typeof window.matchMedia | undefined;
afterEach(() => {
  if (restoreMatchMedia) window.matchMedia = restoreMatchMedia;
  restoreMatchMedia = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
});

/** The device, as its media queries answer: a finger first, or a pointer that hovers. */
function device(kind: "phone" | "keyboard") {
  restoreMatchMedia = realMatchMedia();
  window.matchMedia = ((query: string) => ({
    matches:
      kind === "phone" &&
      query.includes("hover: none") &&
      query.includes("pointer: coarse"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function composer() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Composer } = await import("../src/components/channels/composer");
  const sent: ComposerDraft[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(Composer, {
        commands: [],
        compact: true,
        onSubmit: (draft: ComposerDraft) => {
          sent.push(draft);
        },
      }),
    );
  });
  const editor = host.querySelector<HTMLElement>('[role="textbox"]');
  if (!editor) throw new Error("no editor on screen");

  /** Typed as a browser types it: the text is in the box, then the box says so. */
  const type = async (words: string) => {
    await act(async () => {
      const node = document.createTextNode(words);
      editor.append(node);
      const range = document.createRange();
      range.setStart(node, words.length);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: words,
          inputType: "insertText",
        }),
      );
    });
  };
  /** Return, and whether the box took the key for itself. */
  const pressReturn = async () => {
    const key = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      editor.dispatchEvent(key);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    return key.defaultPrevented;
  };
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
  };
  return { host, editor, sent, type, pressReturn, unmount };
}

describe("Return in the composer", () => {
  test("with a real keyboard it sends, as it always has", async () => {
    device("keyboard");
    const box = await composer();
    await box.type("첫 줄");
    await box.pressReturn();
    expect(box.sent.map((draft) => draft.text)).toEqual(["첫 줄"]);
    await box.unmount();
  });

  test("on a phone it does not send: the words stay in the box for a second line", async () => {
    device("phone");
    const box = await composer();
    await box.type("첫 줄");
    await box.pressReturn();
    expect(box.sent).toEqual([]);
    expect(box.editor.textContent).toContain("첫 줄");
    // The send button is how it goes there.
    const send = box.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]',
    );
    if (!send) throw new Error("no send button");
    const { act } = await import("react");
    await act(async () => {
      send.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]?.text).toContain("첫 줄");
    await box.unmount();
  });
});
