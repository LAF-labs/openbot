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

/** A mouse button a person can hold down. */
export type HeldButton = "left" | "right" | "middle";

/** What the surface sends us. */
export type InputMessage =
  | {
      type: "mouse";
      event: "pressed" | "released" | "moved";
      x: number;
      y: number;
      /** `none` is a move with nothing held, which is what a hover is. See {@link mouseEventOf}. */
      button?: HeldButton | "none";
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
      /** What the person's own browser called the key (`event.keyCode`). See {@link keyEventOf}. */
      windowsVirtualKeyCode?: number;
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
 * Chrome's virtual key codes, for the keys that are named rather than written.
 *
 * `Input.dispatchKeyEvent` is not satisfied by `key` alone: a form field ignores a bare Backspace
 * unless `windowsVirtualKeyCode` is set, which is the common reason a hand-written screencast works
 * for letters but not editing keys. Lifted from the mapping DevTools uses for the same purpose.
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

/**
 * The key each written symbol sits on, on the keyboard Chrome's codes describe — its own symbol and
 * the one Shift makes of it.
 *
 * A SYMBOL'S CODE POINT IS SOMEBODY ELSE'S KEY. Until 2026-10-02 every one-character key was sent as
 * its upper-cased code point, which is right for a letter and a digit and for nothing else: `.` is
 * 46, which is Delete; `'` is 39, the right arrow; and `# $ % & (` are 35 to 40 — End, Home and the
 * arrows — arriving with Shift held, which is how a person selects. Measured against Chromium 151,
 * typing into a text box: `kim.lee@naver.com` arrived as `kimlee@navercom`,
 * `https://www.hometax.go.kr/` as `https://wwwhometaxgokr/`, and `Pa$$w0rd!` as `w0rd!` — each `$`
 * selected everything before it and the next letter replaced it, in a box that shows dots. Found by
 * reading upstream OpenBot's fix for the unshifted half (#422); the shifted half is this table's.
 */
const SYMBOL_KEY_CODES: Record<string, number> = {
  ")": 48,
  "!": 49,
  "@": 50,
  "#": 51,
  $: 52,
  "%": 53,
  "^": 54,
  "&": 55,
  "*": 56,
  "(": 57,
  ";": 186,
  ":": 186,
  "=": 187,
  "+": 187,
  ",": 188,
  "<": 188,
  "-": 189,
  _: 189,
  ".": 190,
  ">": 190,
  "/": 191,
  "?": 191,
  "`": 192,
  "~": 192,
  "[": 219,
  "{": 219,
  "\\": 220,
  "|": 220,
  "]": 221,
  "}": 221,
  "'": 222,
  '"': 222,
};

/**
 * A table's own entry. What names a key came over a socket, and `constructor` and `toString` are
 * entries of every object and keys of no keyboard.
 */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The code for a key the surface only named. Nothing for a character that is on no such key. */
function virtualKeyCode(key: string): number {
  const named = own(VIRTUAL_KEY_CODES, key) ?? own(SYMBOL_KEY_CODES, key);
  if (named !== undefined) return named;
  // A letter or a digit is its own code, upper-cased. Anything else written — `é`, `м` — has no
  // code of its own, and one made up from its code point is another key's or none at all.
  return /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0;
}

/**
 * What a named key must carry for a page to act on it, which the surface does not send because it
 * is not a character anybody wrote.
 *
 * ENTER, UNTIL 2026-10-02, WAS HEARD AND NOT ACTED ON. A key with no text goes to Chrome as a
 * `rawKeyDown`, and a raw key down never becomes the `keypress` a form is sent on or a line is
 * broken by. Measured against Chromium 151: Enter in a form's text box sent the form 0 times, and
 * in a `<textarea>` left `first` as `first` — a person driving could type a search and not run it.
 * With a carriage return, which is what a keyboard's Enter carries, the form is sent once and the
 * line breaks, and a page that decides Enter for itself on `keydown` still does. Upstream OpenBot's
 * #477.
 */
const TEXT_FOR_KEY: Record<string, string> = { Enter: "\r" };

type MouseMessage = Extract<InputMessage, { type: "mouse" }>;
type KeyMessage = Extract<InputMessage, { type: "key" }>;

/**
 * One mouse message as Chrome's `Input.dispatchMouseEvent` takes it.
 *
 * A MOVE WITH NOTHING HELD IS `none`, NOT `left`. Measured 2026-10-01 against Chromium 151 with a
 * page that logs its mouse events: a move dispatched with `button: "left"` reaches the page as a
 * `mousemove` with `buttons: 1` — a drag — and with `button: "none"` as `buttons: 0`. The surface
 * sent `left` on every move (a DOM `mousemove` says `button: 0`, which is also the left button's
 * number) and this defaulted to `left`, so every hover over a signature pad, a slider or a map that
 * reads `event.buttons` drew, slid or panned with nothing pressed. A move now carries the button
 * that is actually down, which the surface knows, and nothing when it does not say.
 */
export function mouseEventOf(message: MouseMessage) {
  const moved = message.event === "moved";
  return {
    type:
      message.event === "pressed"
        ? ("mousePressed" as const)
        : message.event === "released"
          ? ("mouseReleased" as const)
          : ("mouseMoved" as const),
    x: message.x,
    y: message.y,
    button: message.button ?? (moved ? ("none" as const) : ("left" as const)),
    // Chrome needs a non-zero clickCount on press/release or the page sees a move that happens
    // to have a button set, and no click ever fires.
    clickCount: moved ? 0 : (message.clickCount ?? 1),
    modifiers: message.modifiers ?? 0,
  };
}

/** CDP's modifier bits, as the surface sends them: Alt 1, Control 2, Meta 4, Shift 8. */
const ALT = 1;
const CONTROL = 2;
const META = 4;

/**
 * ⌘ IS CONTROL TO THE BOT'S BROWSER.
 *
 * The Bot's browser is Chromium on Linux, where the key that selects all, takes back and copies is
 * Control. A person at a Mac presses ⌘, which arrives here as Meta — a key Linux has no shortcuts
 * under, so the letter pressed with it was simply typed. Measured 2026-10-02 in this image's
 * Chromium 151, on a box holding `abcd`: ⌘A left `abcda`, ⌘Z `abcdz`, ⌘X `abcdax`. Sent as Control,
 * the same keys select everything, take the last change back, put it back and cut it (measured, same
 * browser).
 *
 * Not where this service runs on a Mac — a developer running it from source — whose Chrome keeps ⌘
 * for itself and takes no shortcut by key event at all.
 *
 * Keys only. A click made with ⌘ held stays a plain click: Control would open the link in a tab
 * behind the picture, which is a tab the person cannot see.
 */
const META_IS_CONTROL = process.platform !== "darwin";

/**
 * One key message as `Input.dispatchKeyEvent` takes it.
 *
 * THE CODE THE PERSON'S OWN BROWSER GAVE THE KEY COMES FIRST. It is the one a page on their own
 * computer would have been told, on whatever keyboard they have. The tables above are for a surface
 * that did not say — one loaded before it learned to — and for a number that is no key's: Chrome's
 * codes end at 255, and 229 is an input method's, never a key.
 *
 * A SHORTCUT WRITES NOTHING. A browser makes no `keypress` for a letter pressed under ⌘ or Control,
 * and the surface sends the letter as text all the same; passed on, it is what typed the `a` above.
 * Control with Alt is not a shortcut: on a Windows keyboard that is AltGr, which writes.
 */
export function keyEventOf(
  message: KeyMessage,
  metaIsControl = META_IS_CONTROL,
) {
  const held = message.modifiers ?? 0;
  const isShortcut =
    (held & META) !== 0 || ((held & CONTROL) !== 0 && (held & ALT) === 0);
  const isCommandKey = metaIsControl && message.key === "Meta";
  const offered = isCommandKey ? 17 : message.windowsVirtualKeyCode;
  const code =
    typeof offered === "number" &&
    Number.isInteger(offered) &&
    offered > 0 &&
    offered <= 255 &&
    offered !== 229
      ? offered
      : virtualKeyCode(message.key);
  // Only on the way down, which is where a page acts. A key going up carries what it was given.
  const text =
    message.event === "up"
      ? message.text
      : ((isShortcut ? undefined : message.text) ??
        own(TEXT_FOR_KEY, message.key));
  return {
    // `keyDown` only when there is text to insert; otherwise `rawKeyDown`, which is what Chrome
    // expects for keys that do not produce a character. Sending keyDown with no text makes
    // editing keys arrive as nothing.
    type:
      message.event === "up"
        ? ("keyUp" as const)
        : text
          ? ("keyDown" as const)
          : ("rawKeyDown" as const),
    key: isCommandKey ? "Control" : message.key,
    code: isCommandKey
      ? message.code.replace(/^Meta/, "Control")
      : message.code,
    ...(text ? { text } : {}),
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers: metaIsControl && held & META ? (held & ~META) | CONTROL : held,
  };
}

/**
 * What a person is holding down on the page: buttons with where the pointer last was, keys by
 * their physical code. Kept so that it can all be let go of when they cannot do it themselves.
 */
export type HeldInput = {
  buttons: Map<HeldButton, { x: number; y: number }>;
  keys: Map<
    string,
    { key: string; code: string; windowsVirtualKeyCode?: number }
  >;
};

/** What one message changes about what is held. Applied after Chrome has taken the message. */
export function holdAfter(held: HeldInput, message: InputMessage): void {
  if (message.type === "mouse") {
    const at = { x: message.x, y: message.y };
    // A release goes where the pointer last was, so every held button follows the pointer.
    for (const button of held.buttons.keys()) held.buttons.set(button, at);
    const button = message.button ?? "left";
    if (button === "none") return;
    if (message.event === "pressed") held.buttons.set(button, at);
    if (message.event === "released") held.buttons.delete(button);
    return;
  }
  if (message.type === "key") {
    // By code, so a Shift that turned `a` into `A` between down and up is still the same key.
    const id = message.code || message.key;
    if (message.event === "down") {
      held.keys.set(id, {
        key: message.key,
        code: message.code,
        // Kept, so that the key which comes up is the one that went down.
        ...(message.windowsVirtualKeyCode === undefined
          ? {}
          : { windowsVirtualKeyCode: message.windowsVirtualKeyCode }),
      });
    } else {
      held.keys.delete(id);
    }
  }
}

/** The messages that let go of everything held: every button where it is, then every key. */
export function releasesOf(held: HeldInput): InputMessage[] {
  return [
    ...[...held.buttons].map(
      ([button, at]): InputMessage => ({
        type: "mouse",
        event: "released",
        ...at,
        button,
      }),
    ),
    ...[...held.keys.values()].map(
      (key): InputMessage => ({ type: "key", event: "up", ...key }),
    ),
  ];
}

export type Screencast = {
  /** Stop the cast and detach. Safe to call twice. Lets go of whatever was held, without waiting. */
  stop: () => Promise<void>;
  /** Apply one thing the person did. */
  send: (message: InputMessage) => Promise<void>;
  /**
   * Release every button and key the person is still holding on the page.
   *
   * FOR THE MOMENTS THEY CANNOT. A press whose release never arrives leaves the page waiting on a
   * `mouseup` (a drag handler, a custom slider) or holding Shift, and the next one to act on that
   * page is the Bot. The surface lets go itself when focus or the pointer leaves it; this is for
   * when the surface is gone or no longer allowed to speak — the socket closed, the tab died, or
   * the wheel was handed back, after which this service refuses the surface's own releases.
   */
  letGo: () => Promise<void>;
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

  const held: HeldInput = { buttons: new Map(), keys: new Map() };

  /** One message to Chrome, as it is; what is held is the caller's to keep. */
  const dispatch = (message: InputMessage): Promise<unknown> => {
    if (message.type === "mouse") {
      return client.send("Input.dispatchMouseEvent", mouseEventOf(message));
    }
    if (message.type === "wheel") {
      return client.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: message.x,
        y: message.y,
        deltaX: message.deltaX,
        deltaY: message.deltaY,
        modifiers: message.modifiers ?? 0,
      });
    }
    if (message.type === "key") {
      return client.send("Input.dispatchKeyEvent", keyEventOf(message));
    }
    // A block of text at once: a paste, or a one-time code the person did not type character by
    // character. `Input.insertText` bypasses key events entirely, which is correct here, it is not
    // pretending to be a keyboard.
    return client.send("Input.insertText", { text: message.text });
  };

  /** Everything held, released; forgotten first, so a release that fails is not sent twice. */
  const releases = (): Promise<unknown>[] => {
    const messages = releasesOf(held);
    held.buttons.clear();
    held.keys.clear();
    return messages.map((message) => dispatch(message).catch(() => undefined));
  };

  return {
    /*
     * ASKED, NOT WAITED FOR. On a tab whose next document is on its way, neither `Page.stopScreencast`
     * nor the detach answered in 5 s (measured 2026-09-14; page-arrival.ts), and a reset waits for
     * this stop: in the image built from dbc1c67, `/computers/reset` with the live screen open, one
     * second into a `/navigate` to the fixture's `/hang`, answered at 29.3 s — when the navigation gave
     * the page up. Frames that arrive after this are dropped by `stopped` either way.
     *
     * The releases go out first and are not waited for either: a viewer whose socket closed with a
     * button down is the case nobody else can let go of.
     */
    async stop() {
      if (stopped) return;
      stopped = true;
      void releases();
      void client.send("Page.stopScreencast").catch(() => undefined);
      void client.detach().catch(() => undefined);
    },

    async send(message: InputMessage) {
      if (stopped) return;
      await dispatch(message);
      // After Chrome took it: a press that failed is not a button to release later.
      holdAfter(held, message);
    },

    async letGo() {
      if (stopped) return;
      await Promise.all(releases());
    },
  };
}
