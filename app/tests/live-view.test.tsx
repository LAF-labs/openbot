import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import { createElement } from "react";
import { SCREEN_STALL_MS } from "../src/components/computer/live-screen";
import { ko } from "../src/lib/i18n-ko";
import { stubFetch } from "./support/fetch";

/**
 * THE BOT'S SCREEN AS A PERSON SEES IT: THE PANE, NOT THE SOCKET UNDER IT.
 *
 * `live-screen.test.tsx` holds the socket. This holds what the pane draws around it — the words over
 * the black frame when there is no picture — because that is where the 0.5.3 audit found it failing
 * with every test green (`~/laf/docs/uiux-audit-0.5.3.md` §2, item 15).
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
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url) => {
    const path = String(url);
    if (path.includes("/demonstration")) {
      return Response.json({ demonstration: null });
    }
    if (path.includes("/control")) return Response.json(control);
    return new Response(null, { status: 404 });
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  sockets = [];
  control = {
    holder: "bot",
    since: "2026-09-24T00:00:00Z",
    requested: false,
  };
});

async function mountedView() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LiveView } = await import("../src/components/computer/live-view");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(LiveView, { botId: "bot-1" }));
  });
  return {
    host,
    act: async (body: () => void | Promise<void>) => {
      await act(async () => {
        await body();
      });
    },
    /** The sentence as drawn, not the screen reader's hidden copy of it. */
    drawn: (sentence: string) =>
      [...host.querySelectorAll("span, p")].find(
        (node) =>
          node.textContent === sentence &&
          !node.closest(".sr-only") &&
          !node.classList.contains("sr-only"),
      ) as HTMLElement | undefined,
    unmount: async () => {
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
