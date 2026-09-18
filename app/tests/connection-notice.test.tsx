import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

/**
 * WHILE THE SERVER IS GONE, THE SCREEN SAYS SO.
 *
 * MEASURED 2026-09-10 (audit A4, finding 3): the API was stopped for fifteen seconds and nothing on
 * the screen changed — sidebar, header, composer all as they were — while the console filled with
 * eighteen errors. The account's socket knew within half a second and told nobody. This closes the
 * socket under the shell and reads what a person would see.
 */

let sockets: FakeSocket[] = [];

class FakeSocket {
  url: string;
  isClosed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
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
});

async function mountedShell() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const events = await import("../src/lib/channels/use-channel-events");
  const { ConnectionNotice } = await import(
    "../src/components/layout/connection-notice"
  );

  const Shell = () => {
    events.useChannelEvents();
    return createElement(ConnectionNotice);
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Shell)),
    );
  });
  return {
    host,
    events,
    act: async (body: () => void | Promise<void>) => {
      await act(async () => {
        await body();
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    },
  };
}

const SAID = "The connection to the server was lost. Reconnecting…";

describe("the connection notice", () => {
  test("appears when a socket that was up goes down, and leaves when it is back", async () => {
    const shell = await mountedShell();
    expect(shell.host.textContent).toBe("");

    await shell.act(() => sockets[0]?.onopen?.());
    expect(shell.host.textContent).toBe("");
    expect(shell.events.isSocketLost()).toBe(false);
    // Mounted, empty, before there is anything to say: a region that arrives with its words is not
    // announced, and this is the line somebody who cannot see the pill hears.
    const region = shell.host.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");

    await shell.act(() => sockets[0]?.close());
    expect(shell.events.isSocketLost()).toBe(true);
    const notice = shell.host.querySelector('[role="status"]');
    expect(notice).toBe(region);
    expect(notice?.textContent).toBe(SAID);
    // And the pill is drawn, with its one thing to press.
    expect(shell.host.textContent).toContain("Connection check");
    expect(ko[SAID]).toBe("서버와 연결이 끊겼습니다 — 다시 잇는 중");

    // The reconnect is the socket's own backoff: half a second, then the next socket.
    await shell.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(sockets.length).toBe(2);
    await shell.act(() => sockets[1]?.onopen?.());
    expect(shell.events.isSocketLost()).toBe(false);
    // The pill is gone and the region is quiet again, still there for the next drop.
    expect(shell.host.textContent).toBe("");
    expect(shell.host.querySelector('[role="status"]')).toBe(region);
    await shell.unmount();
  });

  test("tries again the moment the window is looked at, rather than waiting out its backoff", async () => {
    const shell = await mountedShell();
    await shell.act(() => sockets[0]?.onopen?.());
    await shell.act(() => sockets[0]?.close());
    expect(sockets.length).toBe(1);

    // The first wait is half a second; the person comes back sooner than that.
    await shell.act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(sockets.length).toBe(2);
    // Once, not once per event: the attempt that is out is not started again.
    await shell.act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sockets.length).toBe(2);
    await shell.act(() => sockets[1]?.onopen?.());
    expect(shell.events.isSocketLost()).toBe(false);
    await shell.unmount();
  });

  test("says nothing for a socket that never connected in the first place", async () => {
    // That is the /unreachable screen's case: the first load could not reach the server at all.
    const shell = await mountedShell();
    await shell.act(() => sockets[0]?.close());
    expect(shell.events.isSocketLost()).toBe(false);
    expect(shell.host.textContent).toBe("");
    await shell.unmount();
  });
});
