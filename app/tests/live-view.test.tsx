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
 * the black frame when there is no picture, the wait that has to end in a reason, and the sheet a
 * person drives on — because that is where the 0.5.3 audit found it failing with every test green
 * (`~/laf/docs/uiux-audit-0.5.3.md` §2, items 4, 14 and 15).
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

/** Every take and release the view asked for, in order. */
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
   * file run earlier in this process leaves its own width behind, and a narrow one offers no 직접
   * 하기. Measured: both driving cases failed in the whole suite and passed alone. Forgotten again
   * after this file, so this file's PC width is not left behind for the next one either.
   */
  forgetScreenPanelViewport();
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url) => {
    const path = String(url);
    if (path.includes("/demonstration")) {
      return Response.json({ demonstration: null });
    }
    // A press answers with the state it made, as the computer's routes do.
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
 * 직접 하기 GIVES THE PAGE THE WHOLE WINDOW (0.5.3 audit, item 4).
 *
 * Measured 2026-09-24 in a 1280px window: taking over left the Bot's 1280px page in the side pane at
 * 43% — a login's boxes a few millimetres tall — while the 연결 screen's sign-in drew the same page
 * at 87% in an overlay of its own, and called the same act "제어 돌려주기". Both are one sheet now.
 */
describe("somebody driving on a wide window", () => {
  test("is given the whole window the moment the take is answered, and Escape is 다 했어요", async () => {
    const view = await mountedView();
    // Watching: the pane, with 직접 하기 in it, and no sheet.
    expect(view.sheet()).toBeNull();
    const take = view.button("Take over");
    expect(take).toBeDefined();

    // Pressed. The answer IS the new state: no waiting for the next read of the shared loop.
    await view.act(async () => {
      take?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(presses).toEqual(["take"]);
    const sheet = view.sheet();
    expect(sheet).not.toBeNull();
    expect(sheet?.getAttribute("aria-modal")).toBe("true");
    // Outside the pane, over everything: portalled to <body>, and the page is drawn inside it.
    expect(view.host.contains(sheet)).toBe(false);
    expect(sheet?.querySelector("canvas")).not.toBeNull();
    expect(view.host.querySelector("canvas")).toBeNull();
    expect(sheet?.textContent).toContain(
      "You have the browser. Press I'm done when you are finished.",
    );
    expect(view.button("I'm done")).toBeDefined();

    // Escape is the same press as 다 했어요, and the sheet goes once the wheel is back.
    await view.act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(presses).toEqual(["take", "release"]);
    expect(view.sheet()).toBeNull();
    // Back in the pane, watching.
    expect(view.host.querySelector("canvas")).not.toBeNull();
    await view.unmount();
  });

  /*
   * MEASURED 2026-09-25 (0.5.4 final QA, dev server): 직접 하기 on a help card took the wheel, the
   * screen mounted already driven, React's development double-mount ran the unmount cleanup, and
   * the wheel went back 67 ms after it was taken — the Bot carried on past a login nobody did.
   */
  test("a screen that only mounts again keeps the wheel; closing it hands the wheel back", async () => {
    const { rememberControlState } = await import(
      "../src/components/computer/take-the-wheel"
    );
    control = { ...control, holder: "human" };
    // The card's take was answered before the screen mounted, as 직접 하기 on a help card does.
    rememberControlState("bot-1", {
      holder: "human",
      since: "2026-09-24T00:00:00Z",
      requested: false,
    });
    const view = await mountedView({ strict: true });
    await view.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(presses).toEqual([]);
    expect(view.sheet()).not.toBeNull();

    await view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(presses).toEqual(["release"]);
  });

  test("does not offer to teach while the Bot is asking for help", async () => {
    // A captcha or a code sent to a phone is not a task anybody can show a Bot how to do.
    control = { ...control, requested: true, reason: "캡차를 풀어 주세요" };
    const asked = await mountedView();
    await asked.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(asked.button("Teach a task")).toBeUndefined();
    expect(asked.button("Take over")).toBeDefined();
    await asked.unmount();

    control = {
      holder: "bot",
      since: "2026-09-24T00:00:00Z",
      requested: false,
    };
    const quiet = await mountedView();
    await quiet.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(quiet.button("Teach a task")).toBeDefined();
    await quiet.unmount();
  });
});

/**
 * ONE PAIR OF WORDS FOR ONE ACT: 직접 하기, then 다 했어요.
 *
 * Walked over every sentence the Bot's screen, its sheet, the request for help, teaching and the
 * sign-in handoff say — the screen-problem table too, which is read through a variable — so "제어"
 * cannot come back on any of them through a new key.
 */
describe("the words for taking over", () => {
  test("no sentence on these screens says 제어", () => {
    const keys = [
      "computer/live-view.tsx",
      "computer/live-screen.tsx",
      "computer/help-card.tsx",
      "computer/teach-a-task.tsx",
      "sites/handoff.tsx",
    ].flatMap((file) =>
      [
        ...readFileSync(join(COMPONENTS, file), "utf8").matchAll(
          /\bt\(\s*"((?:[^"\\]|\\.)*)"/g,
        ),
      ].map((match) => match[1] as string),
    );
    expect(keys.length).toBeGreaterThan(20);
    const said = [...keys, ...Object.values(SCREEN_PROBLEM_SAID)].map(
      (key) => `${key} → ${ko[key] ?? "(no Korean)"}`,
    );
    expect(said.filter((line) => line.includes("(no Korean)"))).toEqual([]);
    expect(said.filter((line) => line.includes("제어"))).toEqual([]);
    expect(ko["I'm done"]).toBe("다 했어요");
    expect(ko["Take over"]).toBe("직접 하기");
    expect(ko["Do it myself"]).toBe("직접 하기");
  });
});
