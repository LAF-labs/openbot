import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, StrictMode } from "react";

/**
 * ONE SOCKET PER PAGE LOAD, COUNTED.
 *
 * The roster's socket used to be built inside a bare `useEffect`. StrictMode mounts an effect, tears
 * it down and mounts it again inside a single commit, so the app opened TWO sockets on every load
 * and aborted the first — measured in the browser as one
 * "WebSocket is closed before the connection is established" per reload, against
 * ws://localhost:3110/api/channels/events.
 *
 * A green typecheck could never have shown that, and neither could a test that mounted without
 * StrictMode: the second socket only exists because React deliberately runs the effect twice. So
 * this renders under `StrictMode`, exactly as `main.tsx` does, and counts constructions.
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
  // A real origin, not happy-dom's `about:blank`: the hook resolves its socket URL against
  // `window.location`, and `new URL("/api/channels/events", "about:blank")` throws.
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Installed over happy-dom's own, which would try to reach a server that is not there.
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  sockets = [];
});

/** Mounts a probe that calls the hook, and hands back a way to take it down again. */
async function mountedProbe(children: number) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useChannelEvents } = await import(
    "../src/lib/channels/use-channel-events"
  );

  const Probe = () => {
    useChannelEvents();
    return null;
  };

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          QueryClientProvider,
          { client },
          ...Array.from({ length: children }, (_unused, index) =>
            createElement(Probe, { key: index }),
          ),
        ),
      ),
    );
  });

  return {
    client,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      // The release is deferred by a turn on purpose — that deferral is what lets StrictMode's
      // remount reclaim the live socket. Wait past it before asserting the close happened.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    },
  };
}

describe("the roster's channel-events socket", () => {
  /*
   * THE GUARD ON EVERY OTHER TEST IN THIS FILE. If React's StrictMode did not double-invoke effects
   * under this runner, "one socket" would be true for a reason that has nothing to do with the fix,
   * and the whole file would go green against the exact bug it exists to catch.
   */
  test("StrictMode does run an effect twice here", async () => {
    const { act, useEffect } = await import("react");
    const { createRoot } = await import("react-dom/client");
    let mounts = 0;

    const Probe = () => {
      useEffect(() => {
        mounts += 1;
      }, []);
      return null;
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
    await act(async () => {
      root.unmount();
    });
    host.remove();

    expect(mounts).toBe(2);
  });

  test("opens exactly once under StrictMode's double-invoked effect", async () => {
    const probe = await mountedProbe(1);

    expect(sockets.length).toBe(1);
    expect(sockets[0]?.url).toContain("/api/channels/events");
    expect(sockets[0]?.url.startsWith("ws:")).toBe(true);
    expect(sockets[0]?.isClosed).toBe(false);

    await probe.unmount();
  });

  test("two screens holding the hook still share one socket", async () => {
    const probe = await mountedProbe(2);

    expect(sockets.length).toBe(1);

    await probe.unmount();
  });

  test("closes the socket once the last holder is gone", async () => {
    const probe = await mountedProbe(1);
    const opened = sockets[0];

    await probe.unmount();

    expect(opened?.isClosed).toBe(true);
  });

  test("a later mount opens a fresh socket rather than reusing a closed one", async () => {
    const first = await mountedProbe(1);
    await first.unmount();
    expect(sockets.length).toBe(1);

    const second = await mountedProbe(1);
    expect(sockets.length).toBe(2);
    expect(sockets[1]?.isClosed).toBe(false);

    await second.unmount();
  });

  /*
   * A PICTURE KEPT IN ANOTHER WINDOW (0.5.4 final QA): only the window that ran a task keeps its
   * picture, and every other one drew the card from a list read before it existed — a placeholder
   * until a reload. The server's `frame_kept` frame makes that conversation's list stale, and only
   * that one's.
   */
  test("a picture kept elsewhere makes its conversation's list of pictures stale", async () => {
    const { channelKeys } = await import("../src/lib/channels/queries");
    const probe = await mountedProbe(1);
    probe.client.setQueryData(channelKeys.framedCalls("ch-1"), new Set());
    probe.client.setQueryData(channelKeys.framedCalls("ch-2"), new Set());
    sockets.at(-1)?.onmessage?.({
      data: JSON.stringify({
        kind: "frame_kept",
        memberIds: ["user-1"],
        channelId: "ch-1",
        toolCallId: "call-1",
      }),
    });
    expect(
      probe.client.getQueryState(channelKeys.framedCalls("ch-1"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      probe.client.getQueryState(channelKeys.framedCalls("ch-2"))
        ?.isInvalidated,
    ).toBe(false);
    await probe.unmount();
  });
});
