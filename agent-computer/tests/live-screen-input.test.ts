import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Page } from "playwright";
import type { Computer } from "../src/computer";
import {
  inputMessageOf,
  liveScreen,
  type StreamData,
} from "../src/live-screen";
import type { InputMessage } from "../src/screencast";
import { createSessions } from "../src/sessions";

/**
 * WHAT COMES DOWN THE LIVE SCREEN'S SOCKET IS CHECKED AT THE DOOR.
 *
 * The server relays the person's frames byte for byte (`server/src/live-screen.ts`), and this end
 * read each as `JSON.parse(raw) as InputMessage` — a cast, so anything that parsed went on to Chrome
 * as input. Found by reading upstream OpenBot's #488 and then measured here, 2026-10-02:
 *
 *  - the text frame `null` threw inside the handler's own `catch` (which reads `message.type` to
 *    log it), so the handler rejected — and a rejection nobody handles ends a Bun process: Bun
 *    1.3.11 exited 1 from a websocket `message` handler without reaching the `uncaughtException`
 *    listener this service installs. One frame, and every Bot's browser is gone;
 *  - Chromium TOOK three shapes that are nobody's input: a mouse message with no `event` reached
 *    the page as `mousemove` with a button held, a key message with no key as a `keydown` of
 *    nothing, and a key message whose `event` was neither `down` nor `up` typed its letter —
 *    without the box it landed in being followed (`person-typing.ts`), the one thing a keystroke
 *    here must never skip;
 *  - everything else was refused by Chromium as invalid parameters, one protocol round trip later.
 *
 * Only the owner's own signed-in window can open this socket, so this is a surface that sends a
 * shape this end does not know — an older or newer build, or a bug — far more than an attack.
 *
 * No browser: the cast is a recorder, and the page says nothing has focus.
 */

const BOT = "live-input-bot";
let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "laf-live-input-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A socket being cast to, with the wheel in a person's hands unless the test says otherwise. */
function watching(options: { driving?: boolean } = {}) {
  const sessions = createSessions({
    stateDirectoryFor: (botId) => join(root, botId),
  });
  const session = sessions.sessionFor(BOT);
  if (options.driving !== false) session.control.take();
  else session.control.release();
  /** What was handed on towards Chrome, as it was handed. */
  const reached: unknown[] = [];
  /** What the person's window was told. */
  const told: unknown[] = [];
  const ws = {
    data: { botId: BOT },
    send: (frame: string) => {
      told.push(JSON.parse(frame));
      return frame.length;
    },
  } as unknown as ServerWebSocket<StreamData>;
  session.viewer = {
    socket: ws,
    cast: {
      send: async (message) => {
        reached.push(message);
      },
      stop: async () => undefined,
      letGo: async () => undefined,
    },
    // Asked which element has focus before a keystroke goes (`person-typing.ts`): none does.
    page: {
      mainFrame: () => ({
        evaluateHandle: async () => ({
          asElement: () => null,
          dispose: async () => undefined,
        }),
      }),
    } as unknown as Page,
  };
  const handler = liveScreen({ sessions } as unknown as Computer);
  return {
    reached,
    told,
    say: async (raw: string) => {
      await handler.message?.(ws, raw);
    },
  };
}

const NOT_APPLIED = {
  type: "error",
  code: "laf:input_not_applied",
  error: "laf:input_not_applied",
};

/** Frames that are JSON and are not a person's input. */
const UNSHAPED = [
  "null",
  "42",
  '"x"',
  "[]",
  "{}",
  '{"type":"mouse"}',
  '{"type":"mouse","x":10,"y":10}',
  '{"type":"mouse","event":"pressed","x":"10","y":10}',
  '{"type":"mouse","event":"pressed","x":10,"y":10,"button":"thumb"}',
  '{"type":"wheel","deltaY":"NaN"}',
  '{"type":"wheel","x":10,"y":10,"deltaX":0,"deltaY":1e999}',
  '{"type":"key","event":"down"}',
  '{"type":"key","event":"sideways","key":"a","code":"KeyA","text":"a"}',
  '{"type":"key","event":"down","key":"a","code":"KeyA","windowsVirtualKeyCode":"65"}',
  '{"type":"key","event":"down","key":"a","code":"KeyA","text":7}',
  '{"type":"text"}',
  '{"type":"text","text":42}',
  '{"type":"touch","x":1,"y":2}',
];

describe("a frame that is not a person's input", () => {
  test("`null` does not throw out of the handler", async () => {
    const screen = watching();
    // It rejected: `null.type`, read again by the catch that reports a failed input.
    await screen.say("null");
    expect(screen.reached).toEqual([]);
  });

  test("is never handed on to Chrome, whichever shape it is", async () => {
    const screen = watching();
    for (const raw of UNSHAPED) await screen.say(raw);
    expect(screen.reached).toEqual([]);
  });

  test("is answered as input that did not reach the page", async () => {
    // The answer most of these already got, one refused protocol call later: a person whose press
    // did nothing is told so, in the surface's own words for this code.
    const screen = watching();
    for (const raw of UNSHAPED) await screen.say(raw);
    expect(screen.told).toEqual(UNSHAPED.map(() => NOT_APPLIED));
  });

  test("is told to take the wheel first when nobody holds it, as any frame is", async () => {
    const screen = watching({ driving: false });
    await screen.say("null");
    await screen.say('{"type":"text","text":"한글"}');
    expect(screen.reached).toEqual([]);
    expect(screen.told).toEqual([
      {
        type: "error",
        code: "laf:take_control_first",
        error: "laf:take_control_first",
      },
      {
        type: "error",
        code: "laf:take_control_first",
        error: "laf:take_control_first",
      },
    ]);
  });

  test("something that is not JSON at all is still dropped without a word", async () => {
    const screen = watching();
    await screen.say("{not json");
    expect(screen.reached).toEqual([]);
    expect(screen.told).toEqual([]);
  });

  test("is no input, read by itself", () => {
    expect(
      UNSHAPED.filter((raw) => inputMessageOf(JSON.parse(raw)) !== null),
    ).toEqual([]);
  });
});

/**
 * What the surface does send (`app/src/components/computer/live-screen.tsx`), field for field, and
 * the shorter messages a window loaded before it learned a field still sends: no `button` on a
 * move, no `windowsVirtualKeyCode` on a key. A door that turned these away would be a person
 * pressing keys at a page that hears nothing.
 */
const SENT: InputMessage[] = [
  {
    type: "mouse",
    event: "moved",
    x: 320.5,
    y: 200.25,
    button: "none",
    clickCount: 0,
    modifiers: 0,
  },
  {
    type: "mouse",
    event: "pressed",
    x: 320.5,
    y: 200.25,
    button: "left",
    clickCount: 2,
    modifiers: 8,
  },
  {
    type: "mouse",
    event: "released",
    x: 320.5,
    y: 200.25,
    button: "left",
    clickCount: 2,
    modifiers: 8,
  },
  { type: "mouse", event: "moved", x: 12, y: 34 },
  { type: "wheel", x: 320, y: 200, deltaX: 0, deltaY: -53.3, modifiers: 0 },
  { type: "wheel", x: 320, y: 200, deltaX: 0, deltaY: 120 },
  {
    type: "key",
    event: "down",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    text: "a",
    modifiers: 0,
  },
  {
    type: "key",
    event: "up",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 0,
  },
  { type: "key", event: "down", key: "Enter", code: "Enter" },
  // A key a keyboard on glass names nothing for: both are strings, and one is empty.
  { type: "key", event: "up", key: "Unidentified", code: "", modifiers: 0 },
  { type: "text", text: "한글" },
];

describe("what a person's window really sends", () => {
  test("goes on to Chrome as it came, in the order it came", async () => {
    const screen = watching();
    for (const message of SENT) await screen.say(JSON.stringify(message));
    expect(screen.reached).toEqual(SENT);
    expect(screen.told).toEqual([]);
  });

  test("is handed back untouched, read by itself", () => {
    for (const message of SENT) {
      const frame: unknown = JSON.parse(JSON.stringify(message));
      expect(inputMessageOf(frame)).toBe(frame as InputMessage);
    }
  });
});
