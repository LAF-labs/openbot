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
import { createElement } from "react";
import { encodeScreenFrame } from "../../shared/screen-frame";
import {
  LIVE_SCREEN_RETRY,
  SCREEN_STALL_MS,
} from "../src/components/computer/live-screen";
import { SCREEN_STALLED } from "../src/lib/computer/screen-problems";
import { ko } from "../src/lib/i18n-ko";

/**
 * THE LIVE SCREEN COMES BACK ON ITS OWN, AND SAYS SO WHILE IT IS GONE.
 *
 * Audit A4 (2026-09-10), finding 6: `socket.onclose = () => setConnected(false)` and nothing else —
 * no reconnect. Every upgrade restarts the front door (three seconds, measured), and a person
 * watching the Bot get past a login was left with a frozen picture and `data-connected=false` until
 * they closed and reopened the pane. The roster's socket next door had backoff reconnection all
 * along; this is that, with a line under the picture while it is down.
 *
 * And it is watched, never driven (owner, 2026-10-09): nothing a person does on the picture goes
 * up the socket, on any surface.
 */

let sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly OPEN = 1;
  url: string;
  readyState = 0;
  isClosed = false;
  /** Everything the screen sent up the socket, parsed. */
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  binaryType = "blob";
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
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

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
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

async function mountedScreen() {
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
    // The line is always there, empty while there is nothing to say; its words are what is read.
    region: () => host.querySelector('[role="status"]'),
    status: () => host.querySelector('[role="status"]')?.textContent || null,
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

/**
 * One frame, as the computer sends it. Its picture does not decode here, which is fine: a frame is
 * counted as the stream working before it is decoded.
 */
const FRAME = JSON.stringify({
  type: "frame",
  data: "bm90LWEtanBlZw==",
  width: 1280,
  height: 800,
  site: "www.naver.com",
});

describe("the live screen's socket", () => {
  test("takes its pictures as bytes, and asks for them that way", async () => {
    const screen = await mountedScreen();
    await screen.act(() => sockets[0]?.open());
    expect(sockets[0]?.binaryType).toBe("arraybuffer");
    const bytes = encodeScreenFrame(
      { type: "frame", width: 1280, height: 800, site: "www.naver.com" },
      new Uint8Array([0xff, 0xd8, 0xff]),
    );
    const frame = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await screen.act(() => sockets[0]?.onmessage?.({ data: frame }));
    // Counted as the stream working before its picture is decoded, as a text frame always was.
    expect(screen.canvas().dataset.connected).toBe("true");
    expect(screen.status()).toBeNull();
    await screen.unmount();
  });

  test("reconnects after a drop, with a line on screen until the picture is back", async () => {
    const screen = await mountedScreen();
    expect(sockets.length).toBe(1);
    expect(sockets[0]?.url).toContain("/api/computers/bot-1/stream");

    await screen.act(() => sockets[0]?.open());
    await screen.act(() => sockets[0]?.onmessage?.({ data: FRAME }));
    expect(screen.canvas().dataset.connected).toBe("true");
    expect(screen.status()).toBeNull();
    // Mounted before it has anything to say, so the cut is announced when it comes.
    const region = screen.region();
    expect(region).not.toBeNull();

    await screen.act(() => sockets[0]?.close());
    expect(screen.canvas().dataset.connected).toBe("false");
    expect(screen.status()).toBe(SAID);
    expect(screen.region()).toBe(region);
    expect(ko[SAID]).toBe("실시간 화면이 끊겼어요 — 다시 잇는 중");

    // Half a second, the same first step the roster's socket takes, then a new socket.
    await screen.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(sockets.length).toBe(2);
    await screen.act(() => sockets[1]?.open());
    expect(screen.canvas().dataset.connected).toBe("true");
    /*
     * Still said: a socket that opens is not a picture. The audit's stuck screen was exactly a
     * socket that opened and sent nothing (item 14), so the line goes with the first frame.
     */
    expect(screen.status()).toBe(SAID);
    await screen.act(() => sockets[1]?.onmessage?.({ data: FRAME }));
    expect(screen.status()).toBeNull();
    await screen.unmount();
  });

  test("a socket that never opened reports the screen unreachable, once, and keeps trying", async () => {
    const screen = await mountedScreen();
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
    const screen = await mountedScreen();
    await screen.act(() => sockets[0]?.open());
    await screen.unmount();
    expect(sockets[0]?.isClosed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(sockets.length).toBe(1);
  });

  test("a socket let go of while it was opening says nothing more", async () => {
    /*
     * React mounts every effect twice in development, and the pane does the same by hand when it is
     * closed and opened again: the first socket is closed before it has opened, and a browser then
     * fires its `error`. Only `onclose` used to be cleared, so that error reached the pane as "the
     * live screen could not be reached" over the socket that had replaced it (measured 2026-09-24).
     */
    const screen = await mountedScreen();
    const first = sockets[0];
    await screen.unmount();
    expect(first?.onerror).toBeNull();
    expect(first?.onopen).toBeNull();
    expect(first?.onmessage).toBeNull();
    expect(screen.problems).toEqual([]);
  });

  test("opening the screen again starts from the first step of the schedule", async () => {
    // The audit's "패널을 열 때 재시도 대기 시간을 초기화한다": the wait lives with the pane that grew
    // it, so a pane opened after an outage asks at once, however long the last one had backed off.
    jest.useFakeTimers();
    const before = await mountedScreen();
    for (let failed = 0; failed < 5; failed += 1) {
      const socket = sockets.at(-1);
      await before.act(() => socket?.onerror?.());
      await before.act(() => socket?.close());
      await before.act(() => {
        jest.advanceTimersByTime(LIVE_SCREEN_RETRY.firstMs * 2 ** failed + 10);
      });
    }
    expect(sockets.length).toBe(6);
    await before.unmount();
    const after = await mountedScreen();
    expect(sockets.length).toBe(7);
    await after.unmount();
    jest.useRealTimers();
  });
});

/**
 * A PICTURE THAT DOES NOT COME IS SAID, WITH SOMETHING TO PRESS (0.5.3 audit, item 14).
 *
 * "화면에 연결하는 중…" stayed up for over twenty seconds on a socket that had opened and sent nothing
 * — two opens in three against the computer image from before `d1ad9e74` — and a picture cut off by
 * a server restart came back eleven seconds after the server did. Neither said anything a person
 * could act on.
 */
describe("a picture that does not come", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("is said as a code after five seconds of an open socket and no frame", async () => {
    jest.useFakeTimers();
    const screen = await mountedScreen();
    await screen.act(() => sockets[0]?.open());
    expect(screen.problems).toEqual([null]);
    await screen.act(() => {
      jest.advanceTimersByTime(SCREEN_STALL_MS - 100);
    });
    expect(screen.problems).toEqual([null]);
    await screen.act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.problems).toEqual([null, SCREEN_STALLED]);
    await screen.unmount();
  });

  test("and not when a frame came first", async () => {
    jest.useFakeTimers();
    const screen = await mountedScreen();
    await screen.act(() => sockets[0]?.open());
    await screen.act(() => sockets[0]?.onmessage?.({ data: FRAME }));
    await screen.act(() => {
      jest.advanceTimersByTime(SCREEN_STALL_MS * 2);
    });
    expect(screen.problems).toEqual([null]);
    await screen.unmount();
  });

  test("a socket that fails to open is said as that, not as a picture that is late", async () => {
    jest.useFakeTimers();
    const screen = await mountedScreen();
    await screen.act(() => sockets[0]?.onerror?.());
    await screen.act(() => {
      jest.advanceTimersByTime(SCREEN_STALL_MS + 100);
    });
    expect(screen.problems).toEqual(["laf:screen_unreachable"]);
    await screen.unmount();
  });

  test("a picture cut off for five seconds offers 다시 연결, which asks at once", async () => {
    jest.useFakeTimers();
    const screen = await mountedScreen();
    await screen.act(() => sockets[0]?.open());
    await screen.act(() => sockets[0]?.onmessage?.({ data: FRAME }));
    // The server goes away, and the schedule backs off while it is gone.
    await screen.act(() => sockets[0]?.close());
    for (let failed = 0; failed < 4; failed += 1) {
      await screen.act(() => {
        jest.advanceTimersByTime(LIVE_SCREEN_RETRY.firstMs * 2 ** failed + 10);
      });
      const socket = sockets.at(-1);
      await screen.act(() => socket?.close());
    }
    const reconnect = () =>
      [...screen.host.querySelectorAll("button")].find(
        (button) => button.textContent === "Reconnect",
      );
    expect(screen.status()).toBe(SAID);
    expect(reconnect()).toBeDefined();
    expect(ko.Reconnect).toBe("다시 연결");

    // Pressed, a socket opens now — not at the end of an eight-second wait.
    const opened = sockets.length;
    await screen.act(() => {
      reconnect()?.click();
    });
    expect(sockets.length).toBe(opened + 1);
    await screen.act(() => sockets.at(-1)?.open());
    await screen.act(() => sockets.at(-1)?.onmessage?.({ data: FRAME }));
    expect(screen.status()).toBeNull();
    expect(reconnect()).toBeUndefined();
    await screen.unmount();
  });
});

/**
 * NOTHING A PERSON DOES ON THE PICTURE REACHES THE BOT'S PAGE (owner, 2026-10-09).
 *
 * This pane used to forward a pointer, keys, pastes, a wheel and a syllable being written to the
 * Bot's browser once a person had taken the wheel. Nobody takes it now, on any surface; what is held
 * here is that the socket carries nothing up, whatever is done on the picture, and that the page
 * around it scrolls as any page does. The server and the computer refuse input on their side too
 * (`server/tests/live-screen-input.test.ts`, `agent-computer/tests/live-screen-input.test.ts`).
 */
describe("the picture is watched, never driven", () => {
  function pointer(type: string) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: 10 },
      clientY: { value: 10 },
      button: { value: 0 },
      buttons: { value: type === "pointerup" ? 0 : 1 },
      pointerId: { value: 1 },
    });
    return event;
  }

  test("a press, a move, a key, a paste and a notch of the wheel send nothing", async () => {
    const screen = await mountedScreen();
    await screen.act(() => sockets[0]?.open());
    await screen.act(() => sockets[0]?.onmessage?.({ data: FRAME }));
    const canvas = screen.canvas();
    const notch = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    await screen.act(() => {
      canvas.dispatchEvent(pointer("pointerdown"));
      canvas.dispatchEvent(pointer("pointermove"));
      canvas.dispatchEvent(pointer("pointerup"));
      canvas.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "a" }),
      );
      canvas.dispatchEvent(new Event("paste", { bubbles: true }));
      canvas.dispatchEvent(notch);
    });
    expect(sockets[0]?.sent).toEqual([]);
    // The wheel is the app's: a notch over the picture scrolls whatever is around it.
    expect(notch.defaultPrevented).toBe(false);
    await screen.unmount();
  });

  test("there is nowhere on it to type, and nothing on it takes focus", async () => {
    const screen = await mountedScreen();
    await screen.act(() => sockets[0]?.open());
    // The hidden field a syllable used to be written in, and the canvas's own place in the Tab order.
    expect(screen.host.querySelector("input, textarea")).toBeNull();
    expect(screen.canvas().hasAttribute("tabindex")).toBe(false);
    expect(screen.canvas().getAttribute("aria-label")).toBe(
      "The assistant's screen, live",
    );
    expect(ko["The assistant's screen, live"]).toBeDefined();
    await screen.unmount();
  });
});
