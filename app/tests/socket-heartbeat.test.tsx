import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { PING_FRAME, PONG_FRAME } from "../../shared/channel-socket";

/**
 * A DEAD SOCKET MUST NEVER LOOK ALIVE (P1, G4).
 *
 * A laptop that slept or a Wi-Fi network that changed leaves the account's socket half-open: no
 * `close` event, no frames, and a window that looks connected while it hears nothing. These drive
 * the page's half of the heartbeat on a fake clock and a fake socket that answers, or does not.
 */

let sockets: FakeSocket[] = [];

class FakeSocket {
  url: string;
  sent: string[] = [];
  isClosed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  send(frame: string) {
    this.sent.push(frame);
  }

  /** What the server says down it. */
  say(frame: string) {
    this.onmessage?.({ data: frame });
  }

  close() {
    this.isClosed = true;
    this.onclose?.();
  }
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  sockets = [];
  jest.useRealTimers();
});

async function mountedSocket() {
  jest.useFakeTimers();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const events = await import("../src/lib/channels/use-channel-events");
  const Probe = () => {
    events.useChannelEvents();
    return null;
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(Probe),
      ),
    );
  });
  const step = async (body: () => void) => {
    await act(async () => {
      body();
    });
  };
  return {
    events,
    step,
    advance: (ms: number) => step(() => jest.advanceTimersByTime(ms)),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      await step(() => jest.advanceTimersByTime(10));
    },
  };
}

describe("the page's half of the heartbeat", () => {
  test("opens the feed saying it pings, so the server judges it by that", async () => {
    const page = await mountedSocket();
    expect(new URL(sockets[0]?.url ?? "").searchParams.get("heartbeat")).toBe(
      "1",
    );
    await page.unmount();
  });

  test("pings every ten seconds, and a socket that answers is kept", async () => {
    const page = await mountedSocket();
    await page.step(() => sockets[0]?.onopen?.());

    await page.advance(10_000);
    expect(sockets[0]?.sent).toEqual([PING_FRAME]);
    await page.step(() => sockets[0]?.say(PONG_FRAME));

    await page.advance(9_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.isClosed).toBe(false);
    expect(page.events.isSocketLost()).toBe(false);
    await page.unmount();
  });

  test("gives a socket that has gone silent up within fifteen seconds, and opens another", async () => {
    const page = await mountedSocket();
    await page.step(() => sockets[0]?.onopen?.());

    // Cut: the ping at ten seconds goes out and nothing comes back.
    await page.advance(10_000);
    expect(sockets[0]?.sent).toEqual([PING_FRAME]);
    expect(page.events.isSocketLost()).toBe(false);

    await page.advance(5_000);
    expect(sockets[0]?.isClosed).toBe(true);
    expect(page.events.isSocketLost()).toBe(true);

    await page.advance(500);
    expect(sockets).toHaveLength(2);
    await page.step(() => sockets[1]?.onopen?.());
    expect(page.events.isSocketLost()).toBe(false);
    await page.unmount();
  });

  test("answers the server's ping, and hands it to nobody else", async () => {
    const page = await mountedSocket();
    await page.step(() => sockets[0]?.onopen?.());
    const heard: unknown[] = [];
    const onActivity = (event: Event) =>
      heard.push((event as CustomEvent).detail);
    page.events.channelActivity.addEventListener(
      page.events.CHANNEL_ACTIVITY,
      onActivity,
    );

    await page.step(() => sockets[0]?.say(PING_FRAME));
    expect(sockets[0]?.sent).toEqual([PONG_FRAME]);
    expect(heard).toEqual([]);

    page.events.channelActivity.removeEventListener(
      page.events.CHANNEL_ACTIVITY,
      onActivity,
    );
    await page.unmount();
  });

  test("asks at once when the window is looked at again, and waits only three seconds", async () => {
    const page = await mountedSocket();
    await page.step(() => sockets[0]?.onopen?.());
    await page.advance(4_000);
    expect(sockets[0]?.sent).toEqual([]);

    // Back from a sleep: the window comes forward.
    await page.step(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sockets[0]?.sent).toEqual([PING_FRAME]);
    // Once, however many ways the window says it is back.
    await page.step(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(sockets[0]?.sent).toEqual([PING_FRAME]);

    await page.advance(3_000);
    expect(sockets[0]?.isClosed).toBe(true);
    expect(page.events.isSocketLost()).toBe(true);
    await page.unmount();
  });

  test("gives up on a socket that does not open within fifteen seconds", async () => {
    // A network that swallows packets leaves a socket connecting for over a minute.
    const page = await mountedSocket();
    await page.advance(14_000);
    expect(sockets).toHaveLength(1);
    await page.advance(1_000);
    expect(sockets[0]?.isClosed).toBe(true);
    await page.advance(500);
    expect(sockets).toHaveLength(2);
    await page.unmount();
  });

  test("starts the backoff again only after a minute of staying up", async () => {
    const page = await mountedSocket();
    await page.step(() => sockets[0]?.onopen?.());
    await page.step(() => sockets[0]?.close());
    await page.advance(500);
    expect(sockets).toHaveLength(2);

    // Up, and down again at once: the next wait is longer, not half a second again.
    await page.step(() => sockets[1]?.onopen?.());
    await page.step(() => sockets[1]?.close());
    await page.advance(500);
    expect(sockets).toHaveLength(2);
    await page.advance(500);
    expect(sockets).toHaveLength(3);

    // Up for a minute, answering its pings: now the backoff starts from the beginning.
    await page.step(() => sockets[2]?.onopen?.());
    for (let second = 0; second < 60; second += 10) {
      await page.advance(10_000);
      await page.step(() => sockets[2]?.say(PONG_FRAME));
    }
    await page.step(() => sockets[2]?.close());
    await page.advance(500);
    expect(sockets).toHaveLength(4);
    await page.unmount();
  });
});
