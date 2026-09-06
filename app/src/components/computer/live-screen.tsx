import { useCallback, useEffect, useRef, useState } from "react";
import {
  SCREEN_UNAVAILABLE,
  SCREEN_UNREACHABLE,
} from "@/lib/computer/screen-problems";
import { t } from "@/lib/i18n";
import { decodeFrame, paintFrame } from "./frame-bitmap";
import { pageCoordinates } from "./take-the-wheel";

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
};

export function LiveScreen({ computerId, driving, onProblem }: Props) {
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
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Same origin, so the scheme follows the page: wss when the app is served over https.
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/api/computers/${encodeURIComponent(computerId)}/stream`,
    );
    socketRef.current = socket;
    let closed = false;

    socket.onopen = () => {
      setConnected(true);
      onProblem?.(null);
    };

    socket.onmessage = async (event) => {
      let message: {
        type: string;
        data?: string;
        width?: number;
        height?: number;
        /** The container's fact code. Its `error` sentence is for a log, never for this pane. */
        code?: string;
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "error") {
        onProblem?.(message.code ?? SCREEN_UNAVAILABLE);
        return;
      }
      if (message.type !== "frame" || !message.data) return;

      const canvas = canvasRef.current;
      if (!canvas || closed) return;

      frameSize.current = {
        width: message.width ?? 1280,
        height: message.height ?? 800,
      };

      // Drawn as a bitmap because input coordinates are measured against this canvas. The decode
      // itself moved into `frame-bitmap.ts`, which is also where the timings live.
      const bitmap = await decodeFrame(message.data, "image/jpeg");
      // Ignore a single corrupt frame; the next frame replaces it.
      if (!bitmap) return;
      if (closed) {
        bitmap.close();
        return;
      }
      paintFrame(canvas, bitmap);
      bitmap.close();
    };

    socket.onerror = () => onProblem?.(SCREEN_UNREACHABLE);
    socket.onclose = () => setConnected(false);

    return () => {
      closed = true;
      socket.close();
      socketRef.current = null;
    };
    // The socket is per Bot; switching Bot must close this stream and open the next one.
  }, [computerId, onProblem]);

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
  const at = useCallback((event: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const size = frameSize.current;
    if (!canvas || !size) return null;
    return pageCoordinates(
      { naturalWidth: size.width, naturalHeight: size.height },
      canvas.getBoundingClientRect(),
      event,
    );
  }, []);

  const onMouse = useCallback(
    (kind: "pressed" | "released" | "moved") =>
      (event: React.MouseEvent<HTMLCanvasElement>) => {
        const point = at(event);
        if (!point) return;
        send({
          type: "mouse",
          event: kind,
          ...point,
          button:
            event.button === 2
              ? "right"
              : event.button === 1
                ? "middle"
                : "left",
          clickCount: kind === "moved" ? 0 : 1,
          modifiers: modifierBits(event),
        });
      },
    [at, send],
  );

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
     * KOREAN IS NOT TYPED ONE KEY PER LETTER.
     *
     * While the IME is composing, every keystroke arrives here with `key === "Process"` (or
     * `keyCode` 229) and the letters a person is actually assembling are not in any of them. Sent
     * on as key events, ㅎ + ㅏ + ㄴ reached the remote page as three separate jamo and 한 never
     * appeared. The composed word arrives once, at `compositionend`, and that is what is sent —
     * which is the same door a paste already uses.
     */
    if (event.nativeEvent.isComposing || event.key === "Process") {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    send({
      type: "key",
      event: "down",
      key: event.key,
      code: event.code,
      // Only a printable character carries text. Sending text for Backspace makes Chrome insert a
      // character instead of deleting one.
      ...(event.key.length === 1 ? { text: event.key } : {}),
      modifiers: modifierBits(event),
    });
  };
  const handleKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" || event.key === "Tab") return;
    if (event.nativeEvent.isComposing || event.key === "Process") {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    send({
      type: "key",
      event: "up",
      key: event.key,
      code: event.code,
      modifiers: modifierBits(event),
    });
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

  return (
    <>
      <canvas
        ref={canvasRef}
        // max-h/max-w rather than h-auto w-full: the expanded screen used to overflow a short window
        // and scroll, with the bottom of the Bot's page below the fold.
        className={`block max-h-full max-w-full outline-none ${driving ? "cursor-crosshair" : ""}`}
        // Only forward input during takeover.
        {...(driving
          ? {
              onMouseDown: (event: React.MouseEvent<HTMLCanvasElement>) => {
                // Clicking the picture must not take the keyboard away from the field that has the
                // IME on it. The canvas is not focusable, so this only has to put focus back where a
                // browser may have moved it.
                keyboardRef.current?.focus();
                onMouse("pressed")(event);
              },
              onMouseUp: onMouse("released"),
              onMouseMove: onMouse("moved"),
              onContextMenu: (event: React.MouseEvent) =>
                event.preventDefault(),
              onWheel: (event: React.WheelEvent<HTMLCanvasElement>) => {
                const point = at(event);
                if (!point) return;
                event.preventDefault();
                send({
                  type: "wheel",
                  ...point,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                  modifiers: modifierBits(event),
                });
              },
            }
          : {})}
        aria-hidden={driving ? true : undefined}
        aria-label={driving ? undefined : t("The assistant's screen, live")}
        data-connected={connected}
      />
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
          onPaste={handlePaste}
          onCompositionEnd={handleCompositionEnd}
          aria-label={t(
            "The assistant's screen. You have control: click and type here. Tab leaves, Escape hands back.",
          )}
        />
      ) : null}
    </>
  );
}
