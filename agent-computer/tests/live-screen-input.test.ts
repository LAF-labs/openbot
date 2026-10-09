import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Page } from "playwright";
import type { Computer } from "../src/computer";
import { liveScreen, type StreamData } from "../src/live-screen";
import type { Screencast } from "../src/screencast";
import { createSessions } from "../src/sessions";

/**
 * NOTHING THAT COMES DOWN THE LIVE SCREEN'S SOCKET REACHES THE BOT'S PAGE.
 *
 * Until 2026-10-09 this socket carried a person's clicks and keys to the page while they held the
 * wheel, and refused them with `laf:take_control_first` while they did not. Nobody drives the Bot's
 * browser now (owner, 2026-10-09): the surface sends nothing, the server's proxy forwards nothing,
 * and this end drops whatever still arrives — a window loaded before the change, or anything else
 * holding the token — unread and unanswered.
 *
 * No browser: the page and the cast write down anything asked of them, and nothing should be.
 */

const BOT = "live-input-bot";
let root = "";
let made = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "laf-live-input-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Something that writes down every property asked of it, and every call made through one. */
function witness(name: string, touched: string[]): unknown {
  return new Proxy(() => undefined, {
    get: (_target, key) => {
      // Not a promise: `await` asks for `then` before anything else, and that is not a use.
      if (key === "then") return undefined;
      touched.push(`${name}.${String(key)}`);
      return witness(`${name}.${String(key)}`, touched);
    },
    apply: (_target, _this, args) => {
      touched.push(`${name}(${args.length})`);
      return Promise.resolve(witness(`${name}()`, touched));
    },
  });
}

/**
 * A socket being cast to. `savedHold` starts the Bot from a `control.json` written by a release in
 * which a person held the wheel — the file a deployment upgraded mid-takeover finds.
 */
async function watching(options: { savedHold?: boolean } = {}) {
  made += 1;
  const directory = join(root, `state-${made}`);
  if (options.savedHold) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "control.json"),
      JSON.stringify({
        holder: "human",
        since: "2026-10-08T23:00:00.000Z",
        reason: "로그인해 주세요",
        requested: false,
      }),
      "utf8",
    );
  }
  const sessions = createSessions({ stateDirectoryFor: () => directory });
  const session = sessions.sessionFor(BOT);
  /** Everything asked of the page or the cast. */
  const touched: string[] = [];
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
    cast: witness("cast", touched) as Screencast,
    page: witness("page", touched) as Page,
  };
  const handler = liveScreen({ sessions } as unknown as Computer);
  return {
    touched,
    told,
    say: async (raw: string) => {
      await handler.message?.(ws, raw);
    },
  };
}

/** What a person's window sent while it drove, field for field, as the surface used to send it. */
const DRIVING = [
  {
    type: "mouse",
    event: "pressed",
    x: 320.5,
    y: 200.25,
    button: "left",
    clickCount: 1,
    modifiers: 0,
  },
  {
    type: "mouse",
    event: "released",
    x: 320.5,
    y: 200.25,
    button: "left",
    clickCount: 1,
    modifiers: 0,
  },
  { type: "mouse", event: "moved", x: 12, y: 34, button: "none" },
  { type: "wheel", x: 320, y: 200, deltaX: 0, deltaY: 120, modifiers: 0 },
  {
    type: "key",
    event: "down",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    text: "a",
    modifiers: 0,
  },
  { type: "key", event: "up", key: "a", code: "KeyA", modifiers: 0 },
  { type: "key", event: "down", key: "Enter", code: "Enter" },
  { type: "text", text: "한글 비밀번호 1234" },
].map((message) => JSON.stringify(message));

/** Frames that were never anybody's input. */
const JUNK = [
  "null",
  "42",
  '"x"',
  "[]",
  "{}",
  '{"type":"mouse"}',
  '{"type":"key","event":"sideways","key":"a","code":"KeyA","text":"a"}',
  '{"type":"touch","x":1,"y":2}',
  "{not json",
];

describe("the live screen's socket", () => {
  test("hands a person's clicks, keys and text to neither the page nor the cast, and says nothing back", async () => {
    const screen = await watching();
    for (const raw of DRIVING) await screen.say(raw);
    expect(screen.touched).toEqual([]);
    // Not refused either: there is no wheel to be told to take, and nobody is sending on purpose.
    expect(screen.told).toEqual([]);
  });

  test("takes none of it from a hold on the wheel saved before the upgrade", async () => {
    // The file a release that still had takeovers wrote in the middle of one.
    const screen = await watching({ savedHold: true });
    for (const raw of DRIVING) await screen.say(raw);
    expect(screen.touched).toEqual([]);
    expect(screen.told).toEqual([]);
  });

  test("drops what was never input the same way, `null` included, without throwing", async () => {
    // `null` once threw out of this handler, and a rejection nobody handles ends a Bun process —
    // this one is every Bot's browser.
    const screen = await watching();
    for (const raw of JUNK) await screen.say(raw);
    expect(screen.touched).toEqual([]);
    expect(screen.told).toEqual([]);
  });
});
