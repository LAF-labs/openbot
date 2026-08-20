import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
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
  /** Called with a human-readable reason when the stream cannot be established. */
  onProblem?: (problem: string | null) => void;
};

export function LiveScreen({ computerId, driving, onProblem }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
        error?: string;
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "error") {
        onProblem?.(message.error ?? "The screen could not be shown.");
        return;
      }
      if (message.type !== "frame" || !message.data) return;

      const canvas = canvasRef.current;
      if (!canvas || closed) return;

      frameSize.current = {
        width: message.width ?? 1280,
        height: message.height ?? 800,
      };

      /**
       * Decoded off the main thread and drawn as a bitmap.
       *
       * `createImageBitmap` rather than assigning a data URI to an `<img>`: the image path decodes
       * synchronously on the main thread for every frame, which at screencast rates is the difference
       * between a smooth page and one that stutters while you are trying to click something on it.
       */
      try {
        const binary = Uint8Array.from(atob(message.data), (c) =>
          c.charCodeAt(0),
        );
        const bitmap = await createImageBitmap(
          new Blob([binary], { type: "image/jpeg" }),
        );
        if (closed) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        // Ignore a single corrupt frame; the next frame replaces it.
      }
    };

    socket.onerror = () => onProblem?.("The live screen could not be reached.");
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
   * The canvas takes focus when control is handed over.
   *
   * It has to: the keystroke handlers below moved off `window` and onto this element, and until it
   * holds focus there is nothing for them to fire on.
   */
  useEffect(() => {
    if (!driving) return;
    canvasRef.current?.focus();
  }, [driving]);

  /**
   * Keystrokes, forwarded while driving.
   *
   * ON THE CANVAS, NOT ON THE WINDOW — this was a keyboard trap in the WCAG 2.1.2 sense. Window
   * listeners with an unconditional `preventDefault` swallowed Tab for the whole page, so once a
   * person took control there was no key that could move focus anywhere: "Hand back" was two
   * centimetres away and unreachable without a mouse. A focusable canvas keeps Tab and typing
   * directed at the remote page while the canvas holds focus, and returns the keyboard to the app
   * the moment it does not.
   *
   * The old comment claimed a canvas cannot hold focus. With `tabIndex` it can.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    // Escape leaves, and Tab is how somebody gets back out to Hand back.
    if (event.key === "Escape" || event.key === "Tab") return;
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
  const handleKeyUp = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === "Escape" || event.key === "Tab") return;
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
  const handlePaste = (event: React.ClipboardEvent<HTMLCanvasElement>) => {
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    event.preventDefault();
    send({ type: "text", text });
  };

  return (
    <canvas
      ref={canvasRef}
      // max-h/max-w rather than h-auto w-full: the expanded screen used to overflow a short window
      // and scroll, with the bottom of the Bot's page below the fold.
      className={`block max-h-full max-w-full outline-none focus-visible:ring-2 focus-visible:ring-ring ${driving ? "cursor-crosshair" : ""}`}
      role={driving ? "application" : undefined}
      tabIndex={driving ? 0 : undefined}
      // Only forward input during takeover.
      {...(driving
        ? {
            onKeyDown: handleKeyDown,
            onKeyUp: handleKeyUp,
            onPaste: handlePaste,
            onMouseDown: onMouse("pressed"),
            onMouseUp: onMouse("released"),
            onMouseMove: onMouse("moved"),
            onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
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
      aria-label={
        driving
          ? t(
              "The assistant's screen. You have control: click and type here. Tab leaves, Escape hands back.",
            )
          : t("The assistant's screen, live")
      }
      data-connected={connected}
    />
  );
}
