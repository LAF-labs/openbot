import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  agentFixture,
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE BOX ON HOME TAKES TYPING BEFORE THE ROSTER ANSWERS.
 *
 * Reported by the owner as "the first Korean letter I type does not stick — 오 comes out ㅇㅗ", and
 * measured 2026-09-21 against the built app with 300 ms on the API calls, which is what a
 * deployment over a network looks like: the message box appeared with `contenteditable="false"`
 * and turned editable, and took the caret, only once `/api/agents` had answered. Typed into in
 * that window the first keystroke is lost; with a Korean input method it is worse than lost,
 * because the composition has no editable to live in and the jamo arrive as separate characters.
 *
 * The cause was `disabled={!selected}` reading "there is nobody to send to" when the truthful
 * sentence was "there is nobody to send to YET". Home is the screen every launch opens on, so that
 * window was in front of every first message anybody ever typed.
 *
 * What the box must do while the roster is still in flight is take the message — and then actually
 * send it, which is the second half here: the composer clears the box before awaiting `onSubmit`
 * and only puts it back if that throws, so a submit that quietly returned because the roster had
 * not arrived would eat the message.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const BOT = agentFixture({ id: "agent_navigator", name: "나침반" });

const editorOf = (host: HTMLElement): HTMLElement => {
  const editor = host.querySelector<HTMLElement>('[role="textbox"]');
  if (!editor) throw new Error("no message box on Home");
  return editor;
};

describe("Home's message box", () => {
  test("is editable from the moment it is drawn, before the roster answers", async () => {
    /** Held open, so the screen stays in the state a slow network puts it in. */
    const { promise: held, resolve: answerRoster } =
      Promise.withResolvers<Response>();

    const view = await mountApp({
      path: "/",
      api: (request) =>
        request.pathname === "/api/agents" && request.method === "GET"
          ? held
          : undefined,
    });
    try {
      const editor = editorOf(view.host);
      expect(editor.getAttribute("contenteditable")).toBe("true");
      expect(editor.getAttribute("aria-disabled")).toBeNull();

      answerRoster(json({ agents: [BOT] }));
      await view.waitFor(
        () => view.host.textContent?.includes("나침반") === true,
        "the roster to arrive",
      );

      // And it never stopped being editable on the way: no flip under anybody's hands.
      expect(editorOf(view.host).getAttribute("contenteditable")).toBe("true");
    } finally {
      answerRoster(json({ agents: [BOT] }));
      await view.unmount();
    }
  });

  test("is disabled only once the roster has answered with nobody in it", async () => {
    const view = await mountApp({ path: "/" });
    try {
      await view.waitFor(
        () =>
          view.host.textContent?.includes("No Bots on your team yet.") ===
            true ||
          view.host.textContent?.includes("아직 봇이 없습니다.") === true,
        "the empty-team line",
      );
      expect(editorOf(view.host).getAttribute("contenteditable")).toBe("false");
    } finally {
      await view.unmount();
    }
  });
});
