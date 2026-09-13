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
import { ko } from "../src/lib/i18n-ko";
import { stubFetch } from "./support/fetch";

/**
 * THE LIVE SCREEN COMES BACK ON ITS OWN, AND SAYS SO WHILE IT IS GONE.
 *
 * Audit A4 (2026-09-10), finding 6: `socket.onclose = () => setConnected(false)` and nothing else —
 * no reconnect, on the one socket that carries a person's own clicks and keystrokes into the Bot's
 * browser. Every upgrade restarts the front door (three seconds, measured), and a person who had
 * taken the wheel to get a Bot past a login was left with a frozen picture and `data-connected=false`
 * until they closed and reopened the pane. The roster's socket next door had backoff reconnection
 * all along; this is that, with a line under the picture while it is down.
 */

let sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  url: string;
  readyState = 0;
  isClosed = false;
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
    this.isClosed = true;
    this.readyState = 3;
    this.onclose?.();
  }
}

let originalFetch: typeof fetch;
let controlReads = 0;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url) => {
    if (String(url).includes("/control")) controlReads += 1;
    return Response.json({
      holder: "human",
      since: "2026-09-10T00:00:00Z",
      requested: false,
    });
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  sockets = [];
});

async function mountedScreen(driving: boolean) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LiveScreen } = await import("../src/components/computer/live-screen");
  const problems: (string | null)[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(LiveScreen, {
        computerId: "bot-1",
        driving,
        onProblem: (problem) => problems.push(problem),
      }),
    );
  });
  return {
    host,
    problems,
    act: async (body: () => void | Promise<void>) => {
      await act(async () => {
        await body();
      });
    },
    status: () => host.querySelector('[role="status"]')?.textContent ?? null,
    canvas: () => host.querySelector("canvas") as HTMLCanvasElement,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

const SAID = "The live picture was cut off. Reconnecting…";

describe("the live screen's socket", () => {
  test("reconnects after a drop, with a line on screen until it does", async () => {
    const screen = await mountedScreen(false);
    expect(sockets.length).toBe(1);
    expect(sockets[0]?.url).toContain("/api/computers/bot-1/stream");

    await screen.act(() => sockets[0]?.open());
    expect(screen.canvas().dataset.connected).toBe("true");
    expect(screen.status()).toBeNull();

    await screen.act(() => sockets[0]?.close());
    expect(screen.canvas().dataset.connected).toBe("false");
    expect(screen.status()).toBe(SAID);
    expect(ko[SAID]).toBe("실시간 화면이 끊겼습니다 — 다시 잇는 중");

    // Half a second, the same first step the roster's socket takes, then a new socket.
    await screen.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(sockets.length).toBe(2);
    await screen.act(() => sockets[1]?.open());
    expect(screen.canvas().dataset.connected).toBe("true");
    expect(screen.status()).toBeNull();
    await screen.unmount();
  });

  test("a drop while driving makes the control loop look again once it is back", async () => {
    const { pokeControl, watchControl } = await import(
      "../src/components/computer/control-poll"
    );
    // A card is watching this computer, as one always is while somebody drives.
    const stop = watchControl(
      "bot-1",
      { isLive: () => false, onState: () => {} },
      0,
    );
    const screen = await mountedScreen(true);
    await screen.act(() => sockets[0]?.open());
    await screen.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const before = controlReads;

    await screen.act(() => sockets[0]?.close());
    await screen.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    await screen.act(() => sockets[1]?.open());
    await screen.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    // The wheel may have changed hands while the stream was down; the loop was poked to find out.
    expect(controlReads).toBeGreaterThan(before);
    pokeControl("bot-1");
    stop();
    await screen.unmount();
  });

  test("a socket that never opened reports the screen unreachable, once, and keeps trying", async () => {
    const screen = await mountedScreen(false);
    await screen.act(() => sockets[0]?.onerror?.());
    await screen.act(() => sockets[0]?.close());
    expect(screen.problems).toEqual(["laf:screen_unreachable"]);
    // No line: nothing was ever on the picture to have been cut off.
    expect(screen.status()).toBeNull();
    await screen.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(sockets.length).toBe(2);
    await screen.unmount();
  });

  test("leaving the pane closes the socket and opens no other", async () => {
    const screen = await mountedScreen(false);
    await screen.act(() => sockets[0]?.open());
    await screen.unmount();
    expect(sockets[0]?.isClosed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(sockets.length).toBe(1);
  });
});
