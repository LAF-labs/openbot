import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement, StrictMode } from "react";
import { SCREEN_STALL_MS } from "../src/components/computer/live-screen";
import { forgetScreenPanelViewport } from "../src/lib/computer/screen-panel";
import { SCREEN_PROBLEM_SAID } from "../src/lib/computer/screen-problems";
import { ko } from "../src/lib/i18n-ko";
import { stubFetch } from "./support/fetch";

const COMPONENTS = join(import.meta.dir, "../src/components");

/**
 * THE BOT'S SCREEN AS A PERSON SEES IT: THE PANE, NOT THE SOCKET UNDER IT.
 *
 * `live-screen.test.tsx` holds the socket. This holds what the pane draws around it — the words over
 * the black frame when there is no picture, and the wait that has to end in a reason — because that
 * is where the 0.5.3 audit found it failing with every test green (`~/laf/docs/uiux-audit-0.5.3.md`
 * §2, items 14 and 15). And that nothing on it hands the Bot's browser to anybody (owner,
 * 2026-10-09).
 */

let sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send() {}
}

/** What the computer says about the wheel. The Bot's, unless a case says otherwise. */
let control: Record<string, unknown> = {
  holder: "bot",
  since: "2026-09-24T00:00:00Z",
  requested: false,
};

/** Every take and release the view asked for, in order — none, since 2026-10-09. */
let presses: string[] = [];

let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  // A PC-width window: every `min-width` question is answered yes.
  window.matchMedia = ((query: string) =>
    ({
      matches: query.startsWith("(min-width"),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  /*
   * The window `screen-panel.ts` keeps is module state, read once and then only on `resize`: a
   * file run earlier in this process leaves its own width behind, and a narrow one draws no size
   * buttons. Measured: cases that needed the wide pane failed in the whole suite and passed alone.
   * Forgotten again after this file, so this file's PC width is not left behind for the next one
   * either.
   */
  forgetScreenPanelViewport();
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url) => {
    const path = String(url);
    // Written down if ever asked: a press on this pane that reached the wheel would be one.
    if (path.endsWith("/control/take")) {
      presses.push("take");
      control = { ...control, holder: "human", requested: false };
      return Response.json(control);
    }
    if (path.endsWith("/control/release")) {
      presses.push("release");
      control = {
        holder: "bot",
        since: "2026-09-24T00:01:00Z",
        requested: false,
      };
      return Response.json(control);
    }
    if (path.includes("/control")) return Response.json(control);
    return new Response(null, { status: 404 });
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  forgetScreenPanelViewport();
  await GlobalRegistrator.unregister();
});

/**
 * Views a case left mounted because it failed before unmounting them. Left alone, their
 * subscriptions outlive this file's window, and the next file's first store write reaches a React
 * root with no `window` under it (measured: `screen-panel.test.ts` failed on `window.event`).
 */
const mounted = new Set<{ unmount: () => void }>();

afterEach(async () => {
  const { act } = await import("react");
  for (const root of mounted) {
    await act(async () => {
      root.unmount();
    });
  }
  mounted.clear();
  document.body.replaceChildren();
  sockets = [];
  presses = [];
  control = {
    holder: "bot",
    since: "2026-09-24T00:00:00Z",
    requested: false,
  };
  // What this tab last heard is module state (`take-the-wheel.ts`); each case starts from the Bot's.
  const { rememberControlState } = await import(
    "../src/components/computer/take-the-wheel"
  );
  rememberControlState("bot-1", {
    holder: "bot",
    since: "2026-09-24T00:00:00Z",
    requested: false,
  });
});

async function mountedView({ strict = false }: { strict?: boolean } = {}) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LiveView } = await import("../src/components/computer/live-view");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    const view = createElement(LiveView, { botId: "bot-1" });
    root.render(strict ? createElement(StrictMode, null, view) : view);
  });
  mounted.add(root);
  return {
    host,
    act: async (body: () => void | Promise<void>) => {
      await act(async () => {
        await body();
      });
    },
    /** The whole-window sheet, which is portalled to `<body>` and so is not inside `host`. */
    sheet: () =>
      document.body.querySelector('[role="dialog"]') as HTMLElement | null,
    /** A button anywhere on the page, by its words. */
    button: (words: string) =>
      [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === words,
      ),
    /** The sentence as drawn, not the screen reader's hidden copy of it. */
    drawn: (sentence: string) =>
      [...host.querySelectorAll("span, p")].find(
        (node) =>
          node.textContent === sentence &&
          !node.closest(".sr-only") &&
          !node.classList.contains("sr-only"),
      ) as HTMLElement | undefined,
    unmount: async () => {
      mounted.delete(root);
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/** The container's own error on the socket, as `agent-computer` sends one when a cast will not start. */
const NOT_STARTED = JSON.stringify({
  type: "error",
  code: "laf:screen_not_started",
  error: "laf:screen_not_started",
});

describe("a screen problem over the black frame", () => {
  test("is said in light words, whatever the theme", async () => {
    const view = await mountedView();
    await view.act(() => sockets[0]?.open());
    await view.act(() => sockets[0]?.onmessage?.({ data: NOT_STARTED }));

    const said = view.drawn("The live picture could not be started.");
    expect(said).toBeDefined();
    /*
     * The frame is `bg-black` in both themes, so its words are white in both. Measured 2026-09-24
     * before this: `text-muted-foreground` on a `bg-muted` veil drew rgba(20,20,20,.6) over black in
     * the light theme.
     */
    expect(said?.className).toContain("text-white");
    const between: string[] = [];
    for (
      let node: HTMLElement | null | undefined = said;
      node && !node.className.includes("bg-black");
      node = node.parentElement
    ) {
      between.push(node.className);
    }
    expect(between.join(" ")).not.toMatch(/text-muted-foreground|bg-muted/);
    await view.unmount();
  });
});

describe("a picture that does not come (0.5.3 audit, item 14)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("stops being 'connecting' after five seconds: it says why, and 다시 연결 opens a new socket", async () => {
    jest.useFakeTimers();
    const view = await mountedView();
    await view.act(() => sockets[0]?.open());
    expect(view.host.textContent).toContain("Connecting to the screen…");

    await view.act(() => {
      jest.advanceTimersByTime(SCREEN_STALL_MS + 10);
    });
    const reason = "The picture has not come through for five seconds.";
    expect(view.drawn(reason)).toBeDefined();
    expect(ko[reason]).toBe("화면이 5초 넘게 오지 않고 있어요.");
    expect(view.host.textContent).not.toContain("Connecting to the screen…");

    const reconnect = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Reconnect",
    );
    expect(reconnect).toBeDefined();
    const opened = sockets.length;
    await view.act(() => {
      reconnect?.click();
    });
    // A new stream, at once: the computer casts to the newest socket.
    expect(sockets.length).toBe(opened + 1);
    expect(view.drawn(reason)).toBeUndefined();
    await view.unmount();
  });
});

/**
 * NOBODY DRIVES IT (owner, 2026-10-09).
 *
 * The pane offered 직접 하기, which took the wheel and laid the Bot's page over the whole window for
 * a person's clicks and keys, and closing it handed the wheel back. Nobody drives the Bot's browser
 * now, on any surface: what is held here is that the pane draws nothing that would, and asks the
 * computer for nothing, whether or not the Bot is asking for a hand.
 */
describe("nobody drives the Bot's browser from the pane", () => {
  test("it offers only its sizes, even while the Bot is asking for help", async () => {
    control = { ...control, requested: true, reason: "캡차를 풀어 주세요" };
    const view = await mountedView();
    await view.act(() => sockets[0]?.open());
    await view.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      [...document.body.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Small", "Medium", "Large"]);
    expect(view.sheet()).toBeNull();
    expect(presses).toEqual([]);
    await view.unmount();
  });

  /*
   * MEASURED 2026-09-25 (0.5.4 final QA, dev server): the pane handed the wheel back on unmount, and
   * React's development double-mount ran that cleanup 67 ms after a take. There is no wheel to hand
   * back now, and a mount, a remount and a close ask the computer for nothing.
   */
  test("mounting it twice and closing it asks the computer for nothing", async () => {
    const view = await mountedView({ strict: true });
    await view.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(presses).toEqual([]);
  });
});

/**
 * NO "제어" ON THE BOT'S SCREEN.
 *
 * Walked over every sentence the Bot's screen and the request for help say — the screen-problem table
 * too, which is read through a variable — so "제어" cannot come back on any of them through a new key.
 * It was the word for the wheel when a person could take it; nobody can now, and a sentence that
 * says it promises a control that is not there.
 */
describe("the words on the Bot's screen", () => {
  test("no sentence on these screens says 제어", () => {
    const keys = [
      "computer/live-view.tsx",
      "computer/live-screen.tsx",
      "computer/help-card.tsx",
    ].flatMap((file) =>
      [
        ...readFileSync(join(COMPONENTS, file), "utf8").matchAll(
          /\bt\(\s*"((?:[^"\\]|\\.)*)"/g,
        ),
      ].map((match) => match[1] as string),
    );
    expect(keys.length).toBeGreaterThan(10);
    const said = [...keys, ...Object.values(SCREEN_PROBLEM_SAID)].map(
      (key) => `${key} → ${ko[key] ?? "(no Korean)"}`,
    );
    expect(said.filter((line) => line.includes("(no Korean)"))).toEqual([]);
    expect(said.filter((line) => line.includes("제어"))).toEqual([]);
    expect(ko["I'm done"]).toBe("다 했어요");
  });
});
