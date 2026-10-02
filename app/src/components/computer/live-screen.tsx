import { useCallback, useEffect, useRef, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { Button } from "@/components/ui/button";
import {
  SCREEN_STALLED,
  SCREEN_UNAVAILABLE,
  SCREEN_UNREACHABLE,
} from "@/lib/computer/screen-problems";
import { t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";
import { pokeControl } from "./control-poll";
import { decodeScreenFrame } from "@shared/screen-frame";
import { decodeFrame, decodeFrameBytes, paintFrame } from "./frame-bitmap";
import { pageCoordinates } from "./take-the-wheel";

/** The reconnect schedule: the roster socket's, so the two come back at the same pace. */
export const LIVE_SCREEN_RETRY = { firstMs: 500, maxMs: 30_000 } as const;

/**
 * How long the screen waits for a picture before it says it has none and offers 다시 연결.
 *
 * WAITING WAS SILENT, AND THE SCHEDULE ABOVE MADE IT LONG. A socket that opened and then sent
 * nothing kept "화면에 연결하는 중…" up for as long as anybody looked — measured 2026-09-24 at over
 * twenty seconds in two opens of three, and the audit's own "닫았다 다시 열어도 같았다" — and a
 * picture cut off by a server restart came back 11 s after the server did, because the wait had
 * doubled its way up while the server was down. Chrome sends a cast's first frame as soon as the
 * cast starts (measured: 0.1 s after the socket opened, every time it worked), so five seconds of
 * nothing is not a slow page, it is a picture that is not coming.
 */
export const SCREEN_STALL_MS = 5_000;

/**
 * Low-latency screencast used while a human is driving the Bot's browser.
 *
 * The inline card keeps using cheap polling for passive watching. This view uses Chrome's
 * screencast socket so input and visual feedback stay synchronized during takeover.
 *
 * Follows Chrome DevTools' own `InputModel.ts` (BSD-3) for the event translation and
 * `steel-dev/steel-browser`'s casting handler (Apache-2.0) for the frame loop, because no maintained
 * library publishes this and every real implementation is one app-internal file.
 */

/**
 * CDP's modifier bitmask. Alt 1, Control 2, Meta 4, Shift 8.
 *
 * Needed or a capital letter typed with Shift arrives lower-case, and Ctrl+A selects nothing.
 */
function modifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/**
 * The letter a keystroke names, the way a shortcut is spelled.
 *
 * `key` first, because it follows the layout: on Dvorak the V of ⌘V is the key that writes a v,
 * wherever it sits. A layout that writes another script has no such key — Control and the V key say
 * `ㅍ` on a Korean keyboard and `м` on a Russian one, and `Process` while a syllable is being
 * written — and there the physical key in `code` is the only V there is. (Upstream OpenBot's
 * `keyOf`, #596, and the input method's case, which is ours.)
 */
function letterOf(event: { key: string; code: string }): string {
  const written = event.key.toLowerCase();
  if (written.length === 1 && written.charCodeAt(0) < 0x80) return written;
  return /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() ?? written;
}

/**
 * Whether a keystroke is the paste shortcut: ⌘V on a Mac, Control+V elsewhere, with or without
 * Shift (paste as plain text). Not with Alt — Control and Alt together are AltGr on a Windows
 * keyboard, which writes a character.
 */
function isPasteShortcut(event: {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return (
    (event.ctrlKey || event.metaKey) && !event.altKey && letterOf(event) === "v"
  );
}

/** A mouse button a person can hold, as CDP names it. */
type HeldButton = "left" | "middle" | "right";

/** `event.button`: 0 left, 1 middle, 2 right. Anything else (back, forward, a plain move's -1) is none of them. */
const BUTTON_NAMES: readonly HeldButton[] = ["left", "middle", "right"];
const buttonOf = (button: number): HeldButton | null =>
  BUTTON_NAMES[button] ?? null;

/** `event.buttons` is a bitmask in a different order from `event.button`: left 1, right 2, middle 4. */
const BUTTON_BITS: Record<HeldButton, number> = {
  left: 1,
  right: 2,
  middle: 4,
};

/**
 * The button a move is carried with: one the Bot's page was told is down, or `none`.
 *
 * `none` WHEN NOTHING IS — this used to be `event.button`, which is 0 on every `mousemove`, and 0
 * is also the left button's number: every hover went to the Bot's page as a move with the left
 * button held (`buttons: 1`, measured 2026-10-01), so a signature pad or a map drew or panned under
 * a pointer that was only passing over it.
 */
function heldOf(pressed: ReadonlyMap<HeldButton, number>): HeldButton | "none" {
  if (pressed.has("left")) return "left";
  if (pressed.has("right")) return "right";
  if (pressed.has("middle")) return "middle";
  return "none";
}

/**
 * How close two presses must be to be one double-click: the usual half second, and a few pixels of
 * the Bot's page. The operating system's own setting cannot be read from a web page.
 */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_DISTANCE = 5;

type Props = {
  /**
   * Computer identity is part of the stream URL so input and frames stay scoped to the active Bot.
   */
  computerId: string;
  /** Whether the user currently holds the wheel. Input is only sent when true. */
  driving: boolean;
  /**
   * Called with a fact code (`laf:…`) when the stream cannot be established, null once it is.
   *
   * A code and never a sentence: the container's `error` text used to be handed up here as it
   * came, and it came in English. `screenProblemText` turns the code into the person's words.
   */
  onProblem?: (problem: string | null) => void;
  /**
   * Called with each frame's site: a host, null for a browser with no page, or undefined from a
   * computer too old to say. The live view closes on null rather than draw a white box.
   */
  onSite?: (site: string | null | undefined) => void;
};

export function LiveScreen({ computerId, driving, onProblem, onSite }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * WHERE THE KEYBOARD ACTUALLY GOES, AND WHY IT IS NOT THE CANVAS.
   *
   * Measured inside the shipping image, driving Chrome's own IME path with
   * `Input.imeSetComposition`: with a focusable canvas focused, the page received NOTHING — no
   * composition events, no input, not even the text. With a textarea focused, the whole sequence
   * arrived and ended with `compositionend` carrying 한. Chrome turns the IME off entirely unless an
   * editable element has focus, so a Korean word typed at a canvas is not "split into jamo", it is
   * the Latin letters printed on those keys, or nothing at all.
   *
   * So the focus target while driving is a real editable element, kept out of sight, and the canvas
   * goes back to being a picture with a mouse over it. It is the same thing noVNC does for the same
   * reason. Nothing is ever read out of it: it is emptied on every keystroke, and what is sent is
   * the composed word from `compositionend` — one `Input.insertText`, the same door a paste uses,
   * and the same door the demonstration recorder counts without reading.
   */
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** The size of the frames Chrome is sending, which is what input coordinates are relative to. */
  const frameSize = useRef<{ width: number; height: number } | null>(null);
  /**
   * WHAT THE BOT'S PAGE HAS BEEN TOLD IS DOWN, so that it is always told when it comes up.
   *
   * The canvas had `onMouseDown`, `onMouseUp` and `onMouseMove` and nothing else. A button let go of
   * outside the picture — a slider dragged past its end, a drag that left the pane — was never
   * released on the page: `mousedown` and no `mouseup` until the next click (measured 2026-10-01),
   * with a page script still waiting on it. And a key held when focus left was never released at
   * all. Buttons are followed with pointer events and a capture, so the release comes here wherever
   * the pointer is; keys are let go of when the keyboard field loses focus. What neither can cover —
   * the socket closing, the wheel handed back mid-press — the computer lets go of itself
   * (`agent-computer/src/screencast.ts`, `letGo`).
   */
  const pressedRef = useRef(new Map<HeldButton, number>());
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * The last press, for counting clicks. A pointer event carries no click count (`detail` is 0), and
   * every press used to go up as the first: a double-click on the Bot's page was two single clicks,
   * so a word could not be selected by double-clicking it (measured 2026-10-02: two `mousedown`s
   * and no `dblclick`).
   */
  const lastPressRef = useRef<{
    button: HeldButton;
    at: number;
    x: number;
    y: number;
    count: number;
  } | null>(null);
  /** The keys the Bot's page has been told are down: physical code → the key it was sent as. */
  const heldKeysRef = useRef(
    new Map<string, { key: string; keyCode: number }>(),
  );
  /** Keys whose keydown was left to this browser — the paste shortcut's V — by physical code. */
  const localKeysRef = useRef(new Set<string>());
  const [connected, setConnected] = useState(false);
  /**
   * The stream had been showing a picture and then dropped. Drawn under the picture until a picture
   * is back — a frame, not the socket opening again: a socket can open and send nothing (see
   * `SCREEN_STALL_MS`).
   */
  const [lost, setLost] = useState(false);
  /** Lost for `SCREEN_STALL_MS`: the line under the picture offers 다시 연결 instead of only waiting. */
  const [isLostLong, setIsLostLong] = useState(false);
  /**
   * Drop whatever socket there is and open one now, from the first step of the schedule.
   *
   * Set and cleared by the socket's effect, which is where the socket lives; read only by a press.
   */
  const reconnectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Same origin, so the scheme follows the page: wss when the app is served over https.
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${window.location.host}/api/computers/${encodeURIComponent(computerId)}/stream`;
    let socket: WebSocket | undefined;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay: number = LIVE_SCREEN_RETRY.firstMs;
    /** Whether a socket has ever opened: a close after that is a loss, before it a failure to start. */
    let hadOpened = false;
    /** Whether any frame has arrived: before one, a wait is the pane's problem to say; after, the line's. */
    let hadFrame = false;
    let isShowingLoss = false;
    /** Runs out when a socket has gone `SCREEN_STALL_MS` without a first picture. */
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    /** Runs out when a lost picture has stayed lost for `SCREEN_STALL_MS`. */
    let lostTimer: ReturnType<typeof setTimeout> | undefined;

    const watchForPicture = () => {
      clearTimeout(stallTimer);
      if (hadFrame) return;
      stallTimer = setTimeout(() => {
        if (!closed && !hadFrame) onProblem?.(SCREEN_STALLED);
      }, SCREEN_STALL_MS);
    };

    const sawFrame = () => {
      hadFrame = true;
      clearTimeout(stallTimer);
      if (!isShowingLoss) return;
      isShowingLoss = false;
      clearTimeout(lostTimer);
      setLost(false);
      setIsLostLong(false);
    };

    /*
     * A SOCKET LET GO OF SAYS NOTHING MORE. Only `onclose` used to be cleared, so a socket closed
     * while it was still opening — React mounts every effect twice in development, and the pane
     * does the same by hand when it is closed and reopened — went on to fire `onerror`, and the
     * pane drew "실시간 화면에 닿지 못했습니다" over the socket that had replaced it (measured
     * 2026-09-24, on every open after a server restart).
     */
    const release = (old: WebSocket) => {
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      old.close();
    };

    /*
     * RECONNECTS, LIKE THE ROSTER'S SOCKET NEXT DOOR. Audit A4 (2026-09-10), finding 6: this used
     * to be one socket and `onclose = () => setConnected(false)`, so the front door's three-second
     * restart on every upgrade left a person who had taken the wheel with a frozen picture until
     * they closed and reopened the pane. Same schedule as `use-channel-events.ts`: half a second,
     * doubling, capped.
     */
    const connect = () => {
      if (closed) return;
      socket = new WebSocket(url);
      // Frames come as bytes (`shared/screen-frame.ts`); errors and the probe still come as text.
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      watchForPicture();

      socket.onopen = () => {
        retryDelay = LIVE_SCREEN_RETRY.firstMs;
        setConnected(true);
        onProblem?.(null);
        // From the open, not the attempt: a slow handshake is not the picture's wait.
        watchForPicture();
        // The wheel may have changed hands while the stream was down — the Bot's tool call gave
        // up waiting, say — so the shared control loop is asked to look again.
        if (hadOpened) pokeControl(computerId);
        hadOpened = true;
      };

      socket.onmessage = async (event) => {
        let message: {
          type: string;
          data?: string;
          width?: number;
          height?: number;
          /** The container's fact code. Its `error` sentence is for a log, never for this pane. */
          code?: string;
          /** The page's host only; null when there is no page (`agent-computer/src/screencast.ts`). */
          site?: string | null;
          /** The picture itself, for a frame that came as bytes. */
          jpeg?: Uint8Array;
        };
        if (event.data instanceof ArrayBuffer) {
          const frame = decodeScreenFrame(event.data);
          if (!frame) return;
          message = { ...frame.header, jpeg: frame.jpeg };
        } else {
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
        }
        if (message.type === "error") {
          onProblem?.(message.code ?? SCREEN_UNAVAILABLE);
          return;
        }
        if (message.type !== "frame" || !(message.jpeg || message.data)) return;
        // Counted before it is decoded: a frame is proof the stream works, whatever it shows.
        sawFrame();

        const canvas = canvasRef.current;
        if (!canvas || closed) return;

        /*
         * A BLANK PAGE IS SAID, NOT PAINTED. It is how a closed tab comes back — the computer opens a
         * fresh one — and painting it first would flash the white box the viewer is about to close
         * instead of showing.
         */
        if (message.site === null) {
          onSite?.(null);
          return;
        }

        frameSize.current = {
          width: message.width ?? 1280,
          height: message.height ?? 800,
        };

        // Drawn as a bitmap because input coordinates are measured against this canvas. The
        // decode itself moved into `frame-bitmap.ts`, which is also where the timings live.
        const bitmap = message.jpeg
          ? await decodeFrameBytes(message.jpeg, "image/jpeg")
          : await decodeFrame(message.data ?? "", "image/jpeg");
        // Ignore a single corrupt frame; the next frame replaces it.
        if (!bitmap) return;
        if (closed) {
          bitmap.close();
          return;
        }
        paintFrame(canvas, bitmap);
        bitmap.close();
        onSite?.(message.site);
      };

      // Only a stream that never started is a problem for the pane's own line; a stream that
      // dropped says so under the picture, and is about to be reopened.
      socket.onerror = () => {
        if (hadOpened) return;
        // Said as what it is. The wait for a picture is not the problem here, so it stops.
        clearTimeout(stallTimer);
        onProblem?.(SCREEN_UNREACHABLE);
      };
      socket.onclose = () => {
        if (closed) return;
        setConnected(false);
        // What was held went with the socket: the computer let go of it as the socket closed.
        pressedRef.current.clear();
        heldKeysRef.current.clear();
        // Cut off only once there was a picture to cut; before one, the wait above speaks.
        if (hadFrame && !isShowingLoss) {
          isShowingLoss = true;
          setLost(true);
          lostTimer = setTimeout(() => setIsLostLong(true), SCREEN_STALL_MS);
        }
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, LIVE_SCREEN_RETRY.maxMs);
      };
    };

    reconnectRef.current = () => {
      if (closed) return;
      clearTimeout(retryTimer);
      if (socket) release(socket);
      retryDelay = LIVE_SCREEN_RETRY.firstMs;
      connect();
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(stallTimer);
      clearTimeout(lostTimer);
      reconnectRef.current = null;
      // Its handlers cleared first: a pane that is gone must not be told anything, or reconnected.
      if (socket) release(socket);
      socketRef.current = null;
    };
    // The socket is per Bot; switching Bot must close this stream and open the next one.
  }, [computerId, onProblem, onSite]);

  const send = useCallback(
    (message: Record<string, unknown>) => {
      const socket = socketRef.current;
      if (!driving || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message));
    },
    [driving],
  );

  /**
   * Convert from displayed canvas coordinates to page coordinates with the shared, tested helper.
   * A screencast frame is the viewport, so its frame size stands in for natural image size.
   */
  const at = useCallback((event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const size = frameSize.current;
    if (!canvas || !size) return null;
    return pageCoordinates(
      { naturalWidth: size.width, naturalHeight: size.height },
      canvas.getBoundingClientRect(),
      event,
    );
  }, []);

  const sendMouse = useCallback(
    (
      kind: "pressed" | "released" | "moved",
      point: { x: number; y: number },
      button: HeldButton | "none",
      modifiers: number,
      clickCount = 0,
    ) => {
      send({
        type: "mouse",
        event: kind,
        ...point,
        button,
        clickCount,
        modifiers,
      });
    },
    [send],
  );

  const pressButton = (
    button: HeldButton,
    point: { x: number; y: number },
    event: { timeStamp: number } & Parameters<typeof modifierBits>[0],
  ) => {
    if (pressedRef.current.has(button)) return;
    const last = lastPressRef.current;
    const isRepeat =
      last !== null &&
      last.button === button &&
      event.timeStamp - last.at <= MULTI_CLICK_MS &&
      Math.abs(point.x - last.x) <= MULTI_CLICK_DISTANCE &&
      Math.abs(point.y - last.y) <= MULTI_CLICK_DISTANCE;
    const clickCount = isRepeat ? last.count + 1 : 1;
    lastPressRef.current = {
      button,
      at: event.timeStamp,
      ...point,
      count: clickCount,
    };
    pressedRef.current.set(button, clickCount);
    sendMouse("pressed", point, button, modifierBits(event), clickCount);
  };

  /** Only a button the page was told is down: a press that began outside the picture is not ours to end. */
  const releaseButton = (
    button: HeldButton,
    point: { x: number; y: number },
    modifiers: number,
  ) => {
    const clickCount = pressedRef.current.get(button);
    if (clickCount === undefined) return;
    pressedRef.current.delete(button);
    // The same count its press carried: Chrome pairs the two to decide what was clicked.
    sendMouse("released", point, button, modifiers, clickCount);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const button = buttonOf(event.button);
    const point = at(event);
    if (!button || !point) return;
    lastPointRef.current = point;
    /*
     * CAPTURED, so the moves and the release keep coming here once the pointer is off the picture.
     * Without it a release outside the canvas went to whatever was under it, and the page kept its
     * `mousedown`. A pointer that is already gone throws; the press still goes.
     */
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Nothing to capture: the release will come the ordinary way, or from the next move.
    }
    pressButton(button, point, event);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = at(event);
    if (!point) return;
    lastPointRef.current = point;
    const modifiers = modifierBits(event);
    /*
     * A SECOND BUTTON WHILE ONE IS HELD ARRIVES AS A MOVE. Pointer events fire `pointerdown` for the
     * first button and `pointerup` for the last; one pressed or released in between is a
     * `pointermove` whose `button` names it. The page is told of each.
     */
    const changed = buttonOf(event.button);
    if (changed && event.buttons & BUTTON_BITS[changed]) {
      pressButton(changed, point, event);
    }
    // And anything the browser says is no longer down is let go of now: a release this never saw.
    for (const button of [...pressedRef.current.keys()]) {
      if (!(event.buttons & BUTTON_BITS[button])) {
        releaseButton(button, point, modifiers);
      }
    }
    if (changed) return;
    sendMouse("moved", point, heldOf(pressedRef.current), modifiers);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const button = buttonOf(event.button);
    const point = at(event) ?? lastPointRef.current;
    if (!button || !point) return;
    lastPointRef.current = point;
    releaseButton(button, point, modifierBits(event));
  };

  /** The pointer was taken away mid-press (a cancelled touch, a capture lost): everything comes up. */
  const handlePointerLost = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = at(event) ?? lastPointRef.current;
    if (!point) return;
    for (const button of [...pressedRef.current.keys()]) {
      releaseButton(button, point, modifierBits(event));
    }
  };

  /** Every key still down on the Bot's page comes up. */
  const releaseKeys = () => {
    // `held` taken apart inside the loop: the React Compiler leaves the whole screen uncompiled for
    // a pattern nested in the loop's own header.
    for (const [code, held] of [...heldKeysRef.current]) {
      heldKeysRef.current.delete(code);
      send({
        type: "key",
        event: "up",
        key: held.key,
        code,
        windowsVirtualKeyCode: held.keyCode,
        modifiers: 0,
      });
    }
  };

  /*
   * A wheel handed back mid-press is let go of by the computer, which by then refuses this pane's
   * own releases. What is kept here is only forgotten, so the next takeover starts with nothing held.
   */
  useEffect(() => {
    if (!driving) return;
    const pressed = pressedRef.current;
    const heldKeys = heldKeysRef.current;
    const localKeys = localKeysRef.current;
    return () => {
      pressed.clear();
      heldKeys.clear();
      localKeys.clear();
    };
  }, [driving]);

  /**
   * THE WHEEL, ON A LISTENER OF ITS OWN THAT MAY SAY NO.
   *
   * It was React's `onWheel`, and React registers wheel listeners as passive: its `preventDefault`
   * blocked nothing and logged "Unable to preventDefault inside passive event listener invocation"
   * on every notch. So a wheel over the Bot's screen scrolled the Bot's page AND the app under the
   * overlay at once. Registered here with `passive: false`, the notch goes to the Bot's page only —
   * refused to the app even before the first frame has said how big the page is.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!driving || !canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const size = frameSize.current;
      if (!size) return;
      const point = pageCoordinates(
        { naturalWidth: size.width, naturalHeight: size.height },
        canvas.getBoundingClientRect(),
        event,
      );
      if (!point) return;
      send({
        type: "wheel",
        ...point,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifierBits(event),
      });
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [driving, send]);

  /**
   * The keyboard field takes focus when control is handed over.
   *
   * It has to: the keystroke handlers moved off `window` and onto that element, and until it holds
   * focus there is nothing for them to fire on — and no IME either.
   */
  useEffect(() => {
    if (!driving) return;
    keyboardRef.current?.focus();
  }, [driving]);

  /**
   * Keystrokes, forwarded while driving.
   *
   * ON ONE ELEMENT, NOT ON THE WINDOW — this was a keyboard trap in the WCAG 2.1.2 sense. Window
   * listeners with an unconditional `preventDefault` swallowed Tab for the whole page, so once a
   * person took control there was no key that could move focus anywhere: "Hand back" was two
   * centimetres away and unreachable without a mouse. Keeping them on the focused field keeps Tab
   * and typing directed at the remote page while it holds focus, and returns the keyboard to the
   * app the moment it does not.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Escape leaves, and Tab is how somebody gets back out to Hand back.
    if (event.key === "Escape" || event.key === "Tab") return;
    /*
     * PASTE IS THIS COMPUTER'S, AND THE BROWSER MUST BE LEFT TO DO IT.
     *
     * What a person pastes is on their own clipboard, which only their own browser can read — it
     * hands the text over in a `paste` event, and `handlePaste` sends that on. Until 2026-10-02
     * the shortcut never got that far: this handler cancelled every keydown, ⌘V among them, so no
     * `paste` event fired (measured in Chromium 151 and WebKit 26.5: none), and the V went to the
     * Bot's page with ⌘ held, where it was typed. A code copied out of a message and pasted
     * arrived as a `v` (measured in the image's Chromium). So the shortcut is left alone — before
     * the input method's check, since a syllable being written when ⌘V is pressed makes the
     * keystroke the input method's too — and its keyup is kept here with it. (Upstream OpenBot's
     * #422.)
     */
    if (isPasteShortcut(event)) {
      localKeysRef.current.add(event.code);
      return;
    }
    /*
     * KOREAN IS NOT TYPED ONE KEY PER LETTER.
     *
     * While the IME is composing, every keystroke arrives here with `key === "Process"` (or
     * `keyCode` 229) and the letters a person is actually assembling are not in any of them. Sent
     * on as key events, ㅎ + ㅏ + ㄴ reached the remote page as three separate jamo and 한 never
     * appeared. The composed word arrives once, at `compositionend`, and that is what is sent —
     * which is the same door a paste already uses.
     */
    if (isImeKey(event)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    heldKeysRef.current.set(event.code || event.key, {
      key: event.key,
      keyCode: event.keyCode,
    });
    send({
      type: "key",
      event: "down",
      key: event.key,
      code: event.code,
      /*
       * WHICH KEY IT WAS, AS THIS BROWSER NUMBERS IT. Chrome is told a key by number, and the
       * computer used to work the number out from the character — which made `.` Delete and `$`
       * Shift+Home (`agent-computer/src/screencast.ts`). This browser already knows the number,
       * on whatever keyboard the person has.
       */
      windowsVirtualKeyCode: event.keyCode,
      // Only a printable character carries text. Sending text for Backspace makes Chrome insert a
      // character instead of deleting one.
      ...(event.key.length === 1 ? { text: event.key } : {}),
      modifiers: modifierBits(event),
    });
  };
  const handleKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" || event.key === "Tab") return;
    // The other half of a key that was kept here: the Bot's page never saw it go down.
    if (localKeysRef.current.delete(event.code) || isPasteShortcut(event)) {
      return;
    }
    if (isImeKey(event)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    heldKeysRef.current.delete(event.code || event.key);
    send({
      type: "key",
      event: "up",
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode,
      modifiers: modifierBits(event),
    });
    /*
     * macOS never sends the `keyup` of a key let go of while ⌘ was down: ⌘A is `keydown` Meta,
     * `keydown` a, `keyup` Meta, and the `a` stays down as far as any page can tell. So when ⌘ comes
     * up, everything pressed under it comes up with it — and a V that was kept here for a paste is
     * forgotten, or the next v typed would have its keyup taken for that one's.
     */
    if (event.key === "Meta") {
      releaseKeys();
      localKeysRef.current.clear();
    }
  };
  /**
   * Focus left the keyboard field with keys still down — Tab pressed with Shift held, a click on the
   * app, the window itself losing focus. Their `keyup` will go wherever focus went, so the Bot's
   * page is told now.
   */
  const handleBlur = () => {
    releaseKeys();
    localKeysRef.current.clear();
  };
  /** Paste arrives as one block; CDP inserts it as text rather than key events. */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    event.preventDefault();
    send({ type: "text", text });
  };
  /**
   * A finished Korean word, sent whole.
   *
   * The same message a paste sends, for the same reason: `Input.insertText` puts text into the page
   * without pretending to be a keyboard, and a composed syllable is not a keystroke. The recorder
   * this passes through counts that typing happened and never reads the value (`demonstration.ts`),
   * exactly as it does for a paste.
   */
  const handleCompositionEnd = (
    event: React.CompositionEvent<HTMLTextAreaElement>,
  ) => {
    const text = event.data;
    // Emptied whether or not anything is sent: what is in this field is never read again, and a
    // field that keeps what somebody typed is a field holding a password.
    event.currentTarget.value = "";
    if (!text) return;
    send({ type: "text", text });
  };
  /**
   * TEXT THAT ARRIVED WITHOUT A KEY.
   *
   * An emoji from the system's picker, a dictated sentence, a word a keyboard on glass puts in
   * whole: the browser writes these into the field with an `input` event — no keydown this pane
   * could forward, and no composition. Until 2026-10-02 nothing listened for it. Measured on the
   * real stack: nine characters put in that way never reached the Bot's page, and were still in
   * this field afterwards, the one place a typed thing must not stay. They go the way a paste
   * goes, and the field is emptied.
   *
   * Not while a syllable is being written, and not for the event that says one was finished:
   * Safari and Firefox send that after `compositionend`, which has already sent the word.
   */
  const handleInput = (event: React.FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    const kind = native.inputType ?? "";
    if (native.isComposing || /composition/i.test(kind)) return;
    // What was put in is the event's own text; a drop carries none, and the field then holds it.
    const text = native.data ?? event.currentTarget.value;
    event.currentTarget.value = "";
    if (text && kind.startsWith("insert")) send({ type: "text", text });
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        // max-h/max-w rather than h-auto w-full: the expanded screen used to overflow a short window
        // and scroll, with the bottom of the Bot's page below the fold.
        // `touch-none` while driving: a finger on the picture is the Bot's page's, not a scroll of ours,
        // and a browser that takes a touch for panning cancels the pointer mid-press.
        className={`block max-h-full max-w-full outline-none ${driving ? "cursor-crosshair touch-none" : ""}`}
        // Only forward input during takeover.
        {...(driving
          ? {
              onMouseDown: (event: React.MouseEvent<HTMLCanvasElement>) => {
                /*
                 * Clicking the picture must not take the keyboard away from the field that has the
                 * IME on it. Focusing it here is not enough on its own: the browser moves focus
                 * AFTER this handler, to the nearest focusable ancestor — in the live view that is
                 * the page's `<main>`, and every key went there instead (measured 2026-09-24: the
                 * click reached the page, the keys never left the tab). Cancelling the default
                 * keeps focus where it is put; the press itself still goes to the page below.
                 *
                 * Still on `mousedown`, which is where the measurement was taken; what is sent to
                 * the page moved to the pointer handlers beside it.
                 */
                event.preventDefault();
                keyboardRef.current?.focus();
              },
              onPointerDown: handlePointerDown,
              onPointerMove: handlePointerMove,
              onPointerUp: handlePointerUp,
              onPointerCancel: handlePointerLost,
              onLostPointerCapture: handlePointerLost,
              onContextMenu: (event: React.MouseEvent) =>
                event.preventDefault(),
              // The wheel is not here: see the listener registered in the effect above.
            }
          : {})}
        aria-hidden={driving ? true : undefined}
        aria-label={driving ? undefined : t("The assistant's screen, live")}
        data-connected={connected}
      />
      <div className="-translate-x-1/2 pointer-events-none absolute bottom-2 left-1/2 flex items-center gap-2">
        {/* Mounted with the screen, so the cut is heard when it happens and not only seen. */}
        <LiveRegion
          as="p"
          className="whitespace-nowrap rounded-full bg-background/90 px-3 py-1 text-foreground text-xs shadow"
        >
          {lost ? t("The live picture was cut off. Reconnecting…") : null}
        </LiveRegion>
        {lost && isLostLong ? (
          <Button
            className="pointer-events-auto shadow"
            onClick={() => reconnectRef.current?.()}
            size="xs"
            type="button"
            variant="outline"
          >
            {t("Reconnect")}
          </Button>
        ) : null}
      </div>
      {driving ? (
        <textarea
          ref={keyboardRef}
          /*
           * Out of sight, in focus. One pixel and clipped rather than `hidden` or
           * `display:none`, because a hidden element cannot hold focus and an unfocused one gets no
           * IME. `readOnly` is not set either: a field a browser considers read-only is a field it
           * turns the IME off for, which is the whole failure this exists to fix.
           */
          className="absolute h-px w-px overflow-hidden border-0 p-0 opacity-0 outline-none"
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onBlur={handleBlur}
          onPaste={handlePaste}
          onCompositionEnd={handleCompositionEnd}
          onInput={handleInput}
          aria-label={t(
            "The Bot's screen. You are doing it yourself: click and type here. Tab leaves, and Escape is the same as I'm done.",
          )}
        />
      ) : null}
    </>
  );
}
