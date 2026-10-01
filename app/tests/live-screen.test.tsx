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
import {
  LIVE_SCREEN_RETRY,
  SCREEN_STALL_MS,
} from "../src/components/computer/live-screen";
import { encodeScreenFrame } from "../../shared/screen-frame";
import { SCREEN_STALLED } from "../src/lib/computer/screen-problems";
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
    const screen = await mountedScreen(false);
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
    const screen = await mountedScreen(false);
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

  test("a socket let go of while it was opening says nothing more", async () => {
    /*
     * React mounts every effect twice in development, and the pane does the same by hand when it is
     * closed and opened again: the first socket is closed before it has opened, and a browser then
     * fires its `error`. Only `onclose` used to be cleared, so that error reached the pane as "the
     * live screen could not be reached" over the socket that had replaced it (measured 2026-09-24).
     */
    const screen = await mountedScreen(false);
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
    const before = await mountedScreen(false);
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
    const after = await mountedScreen(false);
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
    const screen = await mountedScreen(false);
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
    const screen = await mountedScreen(false);
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
    const screen = await mountedScreen(false);
    await screen.act(() => sockets[0]?.onerror?.());
    await screen.act(() => {
      jest.advanceTimersByTime(SCREEN_STALL_MS + 100);
    });
    expect(screen.problems).toEqual(["laf:screen_unreachable"]);
    await screen.unmount();
  });

  test("a picture cut off for five seconds offers 다시 연결, which asks at once", async () => {
    jest.useFakeTimers();
    const screen = await mountedScreen(false);
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
 * WHAT IS HELD ON THE BOT'S PAGE IS WHAT A PERSON IS HOLDING — NO MORE, AND NEVER LEFT BEHIND.
 *
 * Found 2026-10-01 by reading another project's live view beside this one and measuring ours against
 * Chromium 151: every hover went up as `button: "left"` (a `mousemove`'s `button` is 0, which is
 * also the left button's number) and the page saw a drag; a button let go of outside the picture was
 * never released on the page, because `onMouseUp` lived on the canvas with no capture; and a key
 * held when focus left was never released at all. What the page makes of each message is measured
 * against Chrome in `agent-computer/tests/held-input.test.ts`; what is held here is what this pane
 * sends, and when.
 */
describe("a person's mouse and keys on the live screen", () => {
  async function driven() {
    const screen = await mountedScreen(true);
    await screen.act(() => sockets[0]?.open());
    await screen.act(() =>
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          type: "frame",
          data: "bm90LWEtanBlZw==",
          width: 1280,
          height: 800,
        }),
      }),
    );
    const canvas = screen.canvas();
    // Half size on screen, so a point on the picture is twice as far into the page.
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 400 }) as DOMRect;
    const captured: number[] = [];
    let clock = 0;
    (
      canvas as unknown as { setPointerCapture: (id: number) => void }
    ).setPointerCapture = (id) => {
      captured.push(id);
    };
    const keyboard = screen.host.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    /** One pointer event as a browser would send it; happy-dom drops most of the init. */
    const pointer = async (
      type: string,
      at: {
        x: number;
        y: number;
        button: number;
        buttons: number;
        /** Milliseconds on the page's clock; a second apart unless a test says otherwise. */
        when?: number;
      },
    ) => {
      clock += 1_000;
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientX: { value: at.x },
        clientY: { value: at.y },
        button: { value: at.button },
        buttons: { value: at.buttons },
        timeStamp: { value: at.when ?? clock },
        pointerId: { value: 7 },
        altKey: { value: false },
        ctrlKey: { value: false },
        metaKey: { value: false },
        shiftKey: { value: false },
      });
      await screen.act(() => {
        canvas.dispatchEvent(event);
      });
    };
    const key = async (
      type: "keydown" | "keyup",
      init: { key: string; code: string; metaKey?: boolean },
    ) => {
      await screen.act(() => {
        keyboard.dispatchEvent(
          new KeyboardEvent(type, {
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
    };
    const sent = () => sockets[0]?.sent ?? [];
    /** The mouse messages only, as `event button @x`. */
    const mouse = () =>
      sent()
        .filter((message) => message.type === "mouse")
        .map((message) => `${message.event} ${message.button} @${message.x}`);
    return { screen, canvas, keyboard, captured, pointer, key, sent, mouse };
  }

  test("a pointer passing over the picture is a move with no button held", async () => {
    const { screen, pointer, sent } = await driven();
    await pointer("pointermove", { x: 100, y: 50, button: -1, buttons: 0 });
    expect(sent()).toEqual([
      {
        type: "mouse",
        event: "moved",
        x: 200,
        y: 100,
        button: "none",
        clickCount: 0,
        modifiers: 0,
      },
    ]);
    await screen.unmount();
  });

  test("a press captures the pointer, and its release is sent from outside the picture", async () => {
    const { screen, pointer, captured, mouse } = await driven();
    await pointer("pointerdown", { x: 100, y: 50, button: 0, buttons: 1 });
    expect(captured).toEqual([7]);
    // Dragged past the picture's right edge and let go of there: a slider pulled past its end.
    await pointer("pointermove", { x: 700, y: 50, button: -1, buttons: 1 });
    await pointer("pointerup", { x: 700, y: 50, button: 0, buttons: 0 });
    expect(mouse()).toEqual([
      "pressed left @200",
      "moved left @1400",
      "released left @1400",
    ]);
    await screen.unmount();
  });

  test("a release this pane never saw is sent on the next move, before the move", async () => {
    const { screen, pointer, mouse } = await driven();
    await pointer("pointerdown", { x: 100, y: 50, button: 0, buttons: 1 });
    // The window lost the pointer mid-press; it comes back with nothing down.
    await pointer("pointermove", { x: 120, y: 50, button: -1, buttons: 0 });
    expect(mouse()).toEqual([
      "pressed left @200",
      "released left @240",
      "moved none @240",
    ]);
    await screen.unmount();
  });

  test("a press that began outside the picture is not this pane's to end", async () => {
    const { screen, pointer, mouse } = await driven();
    await pointer("pointermove", { x: 100, y: 50, button: -1, buttons: 1 });
    await pointer("pointerup", { x: 100, y: 50, button: 0, buttons: 0 });
    // Moved over with a button the page was never told about: a hover, and no stray `mouseup`.
    expect(mouse()).toEqual(["moved none @200"]);
    await screen.unmount();
  });

  test("a second button while one is held arrives as a move, and the page is told of each", async () => {
    const { screen, pointer, mouse } = await driven();
    await pointer("pointerdown", { x: 100, y: 50, button: 0, buttons: 1 });
    await pointer("pointermove", { x: 100, y: 50, button: 2, buttons: 3 });
    await pointer("pointermove", { x: 100, y: 50, button: 0, buttons: 2 });
    await pointer("pointerup", { x: 100, y: 50, button: 2, buttons: 0 });
    expect(mouse()).toEqual([
      "pressed left @200",
      "pressed right @200",
      "released left @200",
      "released right @200",
    ]);
    await screen.unmount();
  });

  test("a pointer taken away mid-press lets go of what it held", async () => {
    const { screen, pointer, mouse } = await driven();
    await pointer("pointerdown", { x: 100, y: 50, button: 0, buttons: 1 });
    await pointer("pointercancel", { x: 100, y: 50, button: 0, buttons: 0 });
    // And the capture going afterwards has nothing left to release.
    await pointer("lostpointercapture", {
      x: 100,
      y: 50,
      button: -1,
      buttons: 0,
    });
    expect(mouse()).toEqual(["pressed left @200", "released left @200"]);
    await screen.unmount();
  });

  test("two presses in one place within half a second are a double-click, and its release says so too", async () => {
    const { screen, pointer, sent } = await driven();
    const click = async (x: number, when: number) => {
      await pointer("pointerdown", { x, y: 50, button: 0, buttons: 1, when });
      await pointer("pointerup", { x, y: 50, button: 0, buttons: 0, when });
    };
    await click(100, 1_000);
    await click(101, 1_300);
    // A third, but somewhere else: the first click of something new.
    await click(300, 1_500);
    // And one in the same place, long after.
    await click(300, 9_000);
    expect(
      sent().map((message) => `${message.event} x${message.clickCount}`),
    ).toEqual([
      "pressed x1",
      "released x1",
      "pressed x2",
      "released x2",
      "pressed x1",
      "released x1",
      "pressed x1",
      "released x1",
    ]);
    await screen.unmount();
  });

  test("keys still down when focus leaves the keyboard field come up", async () => {
    const { screen, keyboard, key, sent } = await driven();
    await key("keydown", { key: "Shift", code: "ShiftLeft" });
    await key("keydown", { key: "A", code: "KeyA" });
    await key("keyup", { key: "A", code: "KeyA" });
    await screen.act(() => {
      keyboard.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(sent().map((message) => `${message.event} ${message.key}`)).toEqual([
      "down Shift",
      "down A",
      "up A",
      "up Shift",
    ]);
    // Let go of once: a second blur has nothing to send.
    await screen.act(() => {
      keyboard.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(sent().length).toBe(4);
    await screen.unmount();
  });

  test("⌘ coming up brings up the key macOS never sent a keyup for", async () => {
    const { screen, key, sent } = await driven();
    await key("keydown", { key: "Meta", code: "MetaLeft", metaKey: true });
    await key("keydown", { key: "a", code: "KeyA", metaKey: true });
    await key("keyup", { key: "Meta", code: "MetaLeft" });
    expect(sent().map((message) => `${message.event} ${message.key}`)).toEqual([
      "down Meta",
      "down a",
      "up Meta",
      "up a",
    ]);
    await screen.unmount();
  });

  test("watching, not driving, nothing a pointer does is sent", async () => {
    const screen = await mountedScreen(false);
    await screen.act(() => sockets[0]?.open());
    const event = new Event("pointermove", { bubbles: true });
    Object.defineProperties(event, {
      clientX: { value: 10 },
      clientY: { value: 10 },
      button: { value: -1 },
      buttons: { value: 0 },
    });
    await screen.act(() => {
      screen.canvas().dispatchEvent(event);
    });
    expect(sockets[0]?.sent).toEqual([]);
    await screen.unmount();
  });
});

/**
 * THE WHEEL GOES TO THE BOT'S PAGE, AND ONLY THERE.
 *
 * It was React's `onWheel`, which React registers as passive: its `preventDefault` did nothing but
 * log an error, and a notch over the Bot's screen scrolled the app under the overlay as well. What
 * is held here is the registration itself — on the canvas, not passive — and what one notch sends;
 * that the app stays still was measured in Chrome, where passive means something.
 */
describe("the wheel over the live screen", () => {
  async function drivenWithFrame() {
    const registered: { type: string; passive: unknown }[] = [];
    const add = HTMLCanvasElement.prototype.addEventListener;
    HTMLCanvasElement.prototype.addEventListener = function (
      this: HTMLCanvasElement,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      registered.push({
        type,
        passive: typeof options === "object" ? options.passive : undefined,
      });
      add.call(this, type, listener, options);
    } as typeof add;
    const screen = await mountedScreen(true);
    HTMLCanvasElement.prototype.addEventListener = add;
    await screen.act(() => sockets[0]?.open());
    /*
     * The frame says how big the page is; the wheel's position is measured against it. Its picture
     * does not decode here, which is fine: the size is kept before the decode is tried.
     */
    await screen.act(() =>
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          type: "frame",
          data: "bm90LWEtanBlZw==",
          width: 1280,
          height: 800,
        }),
      }),
    );
    const canvas = screen.canvas();
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 400 }) as DOMRect;
    return { screen, canvas, registered };
  }

  test("is listened for on the canvas itself, and not passively", async () => {
    const { screen, registered } = await drivenWithFrame();
    expect(registered.filter((entry) => entry.type === "wheel")).toEqual([
      { type: "wheel", passive: false },
    ]);
    await screen.unmount();
  });

  test("a notch is refused to the app and sent to the Bot's page, where it was over it", async () => {
    const { screen, canvas } = await drivenWithFrame();
    const notch = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    // happy-dom's WheelEvent drops the pointer's position from its init; a browser's carries it.
    Object.defineProperties(notch, {
      clientX: { value: 320 },
      clientY: { value: 100 },
    });
    await screen.act(() => {
      canvas.dispatchEvent(notch);
    });
    expect(notch.defaultPrevented).toBe(true);
    expect(sockets[0]?.sent).toEqual([
      {
        type: "wheel",
        x: 640,
        y: 200,
        deltaX: 0,
        deltaY: 120,
        modifiers: 0,
      },
    ]);
    await screen.unmount();
  });

  test("watching, not driving, the wheel is the app's to scroll with", async () => {
    const screen = await mountedScreen(false);
    await screen.act(() => sockets[0]?.open());
    const notch = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    await screen.act(() => {
      screen.canvas().dispatchEvent(notch);
    });
    expect(notch.defaultPrevented).toBe(false);
    expect(sockets[0]?.sent).toEqual([]);
    await screen.unmount();
  });
});
