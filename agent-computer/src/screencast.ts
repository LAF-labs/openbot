/**
 * Live screen and live input over one WebSocket, using Chrome's own screencast.
 *
 * Chrome pushes frames as the page changes, which supports human takeover better than polling a PNG
 * once a second.
 *
 * This follows permissively-licensed references: `steel-dev/steel-browser`'s `casting.handler.ts`
 * (Apache-2.0) for the server loop and Chrome DevTools' `InputModel.ts` (BSD-3) for key event
 * translation.
 *
 * noVNC is not used because it requires Xvfb, x11vnc and websockify, while this container runs
 * headless. This implementation streams the page and forwards input through the Chrome DevTools
 * Protocol.
 */
import type { CDPSession, Page } from "playwright";
import type { FrameHeader } from "../../shared/screen-frame";

/** What the surface sends us. */
export type InputMessage =
  | {
      type: "mouse";
      event: "pressed" | "released" | "moved";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      clickCount?: number;
      modifiers?: number;
    }
  | {
      type: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      type: "key";
      event: "down" | "up";
      key: string;
      code: string;
      text?: string;
      modifiers?: number;
    }
  | { type: "text"; text: string };

/**
 * What a frame is before it goes on the wire (`shared/screen-frame.ts`): the header and Chrome's own
 * JPEG bytes, which are never re-encoded.
 */
export type CastFrame = {
  header: FrameHeader;
  jpeg: Uint8Array;
};

/**
 * The site a frame is a picture of: an address's host; null for no page; the scheme alone for a
 * browser's own page.
 *
 * THE HOST AND NOTHING ELSE OF THE ADDRESS. The surface needs two facts: the site to name above
 * the picture, and whether there is a page at all — a closed tab comes back as a fresh blank one
 * (`profiles.page`), and the live view closes rather than draw a white box. A path or a query can
 * carry what a person typed into a form sent by GET, and this socket does not pass the filter
 * every HTTP answer passes (`typed-values.ts`), so none of it is sent.
 */
export function siteOf(address: string): string | null {
  const trimmed = address.trim();
  if (trimmed === "" || trimmed === "about:blank") return null;
  try {
    const url = new URL(trimmed);
    return url.host || url.protocol.replace(/:$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Chrome's virtual key codes, for the keys that need one.
 *
 * `Input.dispatchKeyEvent` is not satisfied by `key` alone. A form field will ignore a bare Backspace
 * or Enter unless `windowsVirtualKeyCode` is set, which is the common reason a hand-written
 * screencast works for letters but not editing keys. Lifted from the mapping DevTools uses for the
 * same purpose.
 */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

function virtualKeyCode(key: string): number {
  if (VIRTUAL_KEY_CODES[key] !== undefined) return VIRTUAL_KEY_CODES[key];
  // A single printable character carries its own code point, upper-cased, which is what Chrome expects
  // for a key event as opposed to the text it produces.
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

export type Screencast = {
  /** Stop the cast and detach. Safe to call twice. */
  stop: () => Promise<void>;
  /** Apply one thing the person did. */
  send: (message: InputMessage) => Promise<void>;
};

/**
 * Start casting `page` to `onFrame`, and return a handle that accepts input.
 *
 * `maxWidth`/`maxHeight` cap what Chrome encodes; it scales to fit and tells us the real dimensions in
 * the metadata, which the surface needs in order to map a click back. Capping matters because the cost
 * of a frame is mostly encoding, and oversized casts waste bandwidth.
 */
export async function startScreencast(
  page: Page,
  /**
   * Handed each frame and the acknowledgement that asks Chrome for the next one. The caller acks when
   * the frame has left — see `live-screen.ts` — which is the whole of the backpressure: Chrome sends
   * nothing more until it is told the last one went.
   */
  onFrame: (frame: CastFrame, ack: () => void) => void,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {},
): Promise<Screencast> {
  const client: CDPSession = await page.context().newCDPSession(page);
  let stopped = false;

  type ScreencastFrame = {
    data: string;
    sessionId: number;
    metadata: { deviceWidth: number; deviceHeight: number };
  };

  client.on("Page.screencastFrame", (event: ScreencastFrame) => {
    const { data, sessionId, metadata } = event;
    /*
     * Every frame is acknowledged exactly once: Chrome will not send the next one until the current is
     * acked, and forgetting is why a naive implementation delivers one frame and then appears to hang.
     * It used to be acked here, before the frame was sent — so a slow viewer got no backpressure at
     * all and Chrome ran at 25–30 fps whatever the socket could carry (performance audit, 2026-09-25).
     */
    let acked = false;
    const ack = () => {
      if (acked) return;
      acked = true;
      void client
        .send("Page.screencastFrameAck", { sessionId })
        .catch(() => undefined);
    };
    if (stopped) {
      ack();
      return;
    }
    onFrame(
      {
        header: {
          type: "frame",
          width: metadata.deviceWidth,
          height: metadata.deviceHeight,
          site: siteOf(page.url()),
        },
        jpeg: Buffer.from(data, "base64"),
      },
      ack,
    );
  });

  await client.send("Page.startScreencast", {
    format: "jpeg",
    /*
     * 60, not 70, for a picture a person reads text off at the pane's size. Measured 2026-09-25 on
     * Naver's home page while it scrolled: 131–137 KB a frame at 70 as base64 JSON, 86–95 KB at 60
     * as bytes — most of that is the base64 going, the rest is this.
     */
    quality: options.quality ?? 60,
    maxWidth: options.maxWidth ?? 1280,
    maxHeight: options.maxHeight ?? 800,
    // One frame per change, not per interval. Chrome decides when something moved.
    everyNthFrame: 1,
  });

  return {
    /*
     * ASKED, NOT WAITED FOR. On a tab whose next document is on its way, neither `Page.stopScreencast`
     * nor the detach answered in 5 s (measured 2026-09-14; page-arrival.ts), and a reset waits for
     * this stop: in the image built from dbc1c67, `/computers/reset` with the live screen open, one
     * second into a `/navigate` to the fixture's `/hang`, answered at 29.3 s — when the navigation gave
     * the page up. Frames that arrive after this are dropped by `stopped` either way.
     */
    async stop() {
      if (stopped) return;
      stopped = true;
      void client.send("Page.stopScreencast").catch(() => undefined);
      void client.detach().catch(() => undefined);
    },

    async send(message: InputMessage) {
      if (stopped) return;
      if (message.type === "mouse") {
        await client.send("Input.dispatchMouseEvent", {
          type:
            message.event === "pressed"
              ? "mousePressed"
              : message.event === "released"
                ? "mouseReleased"
                : "mouseMoved",
          x: message.x,
          y: message.y,
          button: message.button ?? "left",
          // Chrome needs a non-zero clickCount on press/release or the page sees a move that happens
          // to have a button set, and no click ever fires.
          clickCount: message.event === "moved" ? 0 : (message.clickCount ?? 1),
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      if (message.type === "wheel") {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: message.x,
          y: message.y,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      if (message.type === "key") {
        const code = virtualKeyCode(message.key);
        await client.send("Input.dispatchKeyEvent", {
          // `keyDown` only when there is text to insert; otherwise `rawKeyDown`, which is what Chrome
          // expects for keys that do not produce a character. Sending keyDown with no text makes
          // editing keys arrive as nothing.
          type:
            message.event === "up"
              ? "keyUp"
              : message.text
                ? "keyDown"
                : "rawKeyDown",
          key: message.key,
          code: message.code,
          ...(message.text ? { text: message.text } : {}),
          windowsVirtualKeyCode: code,
          nativeVirtualKeyCode: code,
          modifiers: message.modifiers ?? 0,
        });
        return;
      }

      // A block of text at once: a paste, or a one-time code the person did not type character by
      // character. `Input.insertText` bypasses key events entirely, which is correct here, it is not
      // pretending to be a keyboard.
      await client.send("Input.insertText", { text: message.text });
    },
  };
}
