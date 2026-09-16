import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  GET_FORM_BOX,
  LANDED_TEXT,
  SLOW_NO_CONTENT_MS,
  serveFixture,
  TAKEOVER_BOT_BOX,
  TAKEOVER_BOXES,
  TAKEOVER_BUTTON,
  TAKEOVER_RENAMED,
  TAKEOVER_SLOW_LINK,
} from "./fixture-site";

/**
 * WHAT A PERSON TYPES DURING A TAKEOVER NEVER REACHES THE MODEL.
 *
 * `human-input.ts` has promised it since the takeover existed, and nothing kept the promise: a
 * snapshot blanked a box's value only when the page marked it a password, a listed word named it, or
 * the look could not finish, and a box was followed by identity only when `computer_request_secret`
 * filled it. Measured 2026-09-16 (audit R3-01) on the real computer and Chromium: a box called
 * 승인번호, `/control/take`, `/human/type "SEC-TAKEOVER-9911"`, `/control/release`, `/snapshot` →
 * `{"role":"textbox","name":"승인번호","value":"SEC-TAKEOVER-9911"}`.
 *
 * And what a person typed into a form sent by GET left in the address the page landed on — on the
 * `/key` that pressed Enter, the next snapshot's `url` and `tabs`, and `/read` (audit R3-03).
 *
 * Every way a person's typing reaches the page is driven here — `/human/type`, `/human/key` one key
 * at a time, and the live screen's socket, both its `text` and its key events — into boxes nothing
 * marks or names as a secret, one of them renaming itself and one inside a frame from another origin.
 * Then everything the Bot could be handed is serialised whole, the way a secret is tested: every
 * snapshot, `/read`, the tab list, the results of its actions and of the person's, every refusal,
 * the socket's own messages, this process's log and the state it writes to disk.
 *
 * Skipped where Playwright has no browser downloaded, and says so, like `secret-snapshot.test.ts`.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "test-computer-token";

let fixture: ReturnType<typeof serveFixture> | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let profilesDir = "";
let workspaceDir = "";
/** Everything the computer wrote to its log, as it wrote it. */
let logged = "";

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

/** Read a stream to its end into the log, from the start, so a full pipe never stalls the child. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) logged += decoder.decode(chunk);
}

type Body = Record<string, unknown>;
type Answer = { path: string; status: number; body: Body; text: string };

/** Every answer the Bot's side was given, by the call that got it. */
type Seen = { path: string; text: string }[];

async function call(
  seen: Seen,
  bot: string,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": bot,
    },
  });
  const text = await response.text();
  seen.push({ path, text });
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {}
  return { path, status: response.status, body, text };
}

type Element = {
  ref: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
};

/** A computer to talk to as one Bot, remembering everything it answered. */
function asBot(bot: string) {
  const seen: Seen = [];
  const post = (path: string, payload: unknown = {}) =>
    call(seen, bot, "POST", path, payload);
  const get = (path: string) => call(seen, bot, "GET", path);
  const snapshot = async () => {
    const shot = await post("/snapshot");
    expect({ path: shot.path, status: shot.status }).toEqual({
      path: "/snapshot",
      status: 200,
    });
    return {
      snapshotId: shot.body.snapshotId as number,
      url: String(shot.body.url),
      elements: (shot.body.elements ?? []) as Element[],
      tabs: (shot.body.tabs ?? []) as { url: string }[],
    };
  };
  return { seen, post, get, snapshot };
}

const named = (elements: Element[], name: string): Element => {
  const found = elements.find((element) => element.name === name);
  if (!found) {
    throw new Error(
      `The snapshot has nothing called ${name}: ${elements.map((e) => e.name).join(" | ")}`,
    );
  }
  return found;
};

/** A condition, asked until it holds or the time is up. */
async function until(
  holds: () => boolean | Promise<boolean>,
  ms = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await holds()) return true;
    await Bun.sleep(100);
  }
  return holds();
}

/** Where a key is on a keyboard, as the live screen sends it. */
const codeOf = (character: string): string =>
  /[0-9]/.test(character)
    ? `Digit${character}`
    : character === "-"
      ? "Minus"
      : `Key${character.toUpperCase()}`;

/** The person's live screen, as the surface opens it: frames down, input up. */
async function openScreen(bot: string) {
  const socket = new WebSocket(
    `${base.replace(/^http/, "ws")}/stream?bot=${bot}&token=${TOKEN}`,
  );
  let frames = 0;
  /** Everything that came down the socket that was not a picture. */
  const said: string[] = [];
  socket.addEventListener("message", (event) => {
    const text = String(event.data);
    if (text.startsWith('{"type":"frame"')) frames += 1;
    else said.push(text);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("no socket")));
  });
  // A frame is the cast running, which is when input starts being accepted.
  expect(await until(() => frames > 0)).toBe(true);
  await Bun.sleep(200);
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  return {
    said,
    click(point: { x: number; y: number }) {
      for (const event of ["pressed", "released"] as const) {
        send({ type: "mouse", event, ...point, button: "left", clickCount: 1 });
      }
    },
    paste(text: string) {
      send({ type: "text", text });
    },
    press(text: string) {
      for (const character of text) {
        const key = { key: character, code: codeOf(character) };
        send({ type: "key", event: "down", ...key, text: character });
        send({ type: "key", event: "up", ...key });
      }
    },
    close: () => socket.close(),
  };
}

/** Whether any answer carries any of these values, said as which answer and which value. */
function leaks(seen: Seen, values: Iterable<string>) {
  const found: string[] = [];
  for (const value of values) {
    for (const { path, text } of seen) {
      if (text.includes(value)) found.push(`${value} in ${path}`);
    }
  }
  return found;
}

/** Every file under a directory, read whole. */
async function everyFile(directory: string): Promise<string> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        readFile(join(entry.parentPath, entry.name), "utf8").catch(() => ""),
      ),
  );
  return texts.join("\n");
}

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  profilesDir = await mkdtemp(join(tmpdir(), "laf-takeover-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-takeover-workspace-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      // The fixture is served on 127.0.0.1 and localhost, which the navigation guard refuses without
      // this — the same opt-in a laptop deployment sets to browse its own services.
      AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  void drain(child.stdout as ReadableStream<Uint8Array>);
  void drain(child.stderr as ReadableStream<Uint8Array>);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const alive = await fetch(`${base}/health`).catch(() => null);
    if (alive?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("the computer did not start");
});

afterAll(async () => {
  child?.kill();
  await child?.exited;
  fixture?.stop();
  if (profilesDir) await rm(profilesDir, { recursive: true, force: true });
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_BROWSER)("a person's typing during a takeover", () => {
  test("is in nothing the Bot is handed afterwards, by any door it came through, whatever the page calls the box", async () => {
    const bot = asBot("takeover-bot");
    const { post, get, snapshot, seen } = bot;
    // One value per door, each distinct, so a leak says which door it came through.
    const typed = {
      typed: "SEC-TAKEOVER-9911",
      keyed: "KEYS-5501",
      pasted: "SOCKET-PASTE-4432",
      pressed: "SOCKKEY-8813",
      renames: "RENAMED-BOX-2290",
      framed: "FRAME-TYPED-6620",
    } as const;

    expect(
      (await post("/navigate", { url: `${fixture?.url}takeover` })).status,
    ).toBe(200);
    // The Bot's look before the takeover: nothing is followed yet, and the boxes are ordinary.
    const before = await snapshot();
    expect(
      named(before.elements, TAKEOVER_BOXES.typed.name),
    ).not.toHaveProperty("type");

    const screen = await openScreen("takeover-bot");
    expect((await post("/control/take")).status).toBe(200);

    // Over HTTP: a block, and one key at a time.
    await post("/human/click", TAKEOVER_BOXES.typed);
    expect((await post("/human/type", { text: typed.typed })).status).toBe(200);
    await post("/human/click", TAKEOVER_BOXES.keyed);
    for (const key of typed.keyed) {
      expect((await post("/human/key", { key })).status).toBe(200);
    }
    // Down the live screen: a paste, and key events.
    screen.click(TAKEOVER_BOXES.pasted);
    screen.paste(typed.pasted);
    screen.click(TAKEOVER_BOXES.pressed);
    screen.press(typed.pressed);
    // A box that renames itself on the first keystroke, and one in another origin's frame.
    await post("/human/click", TAKEOVER_BOXES.renames);
    await post("/human/type", { text: typed.renames });
    await post("/human/click", TAKEOVER_BOXES.framed);
    await post("/human/type", { text: typed.framed });

    // The socket's input has landed once both of its boxes hold something — which a look says with
    // a value, empty or not, where an empty box has none.
    expect(
      await until(async () => {
        const during = await snapshot();
        return [TAKEOVER_BOXES.pasted.name, TAKEOVER_BOXES.pressed.name].every(
          (name) => named(during.elements, name).value !== undefined,
        );
      }),
    ).toBe(true);

    expect((await post("/control/release")).status).toBe(200);

    // The Bot's turn: look, read, list the tabs, act — its own typing included — and be refused.
    const after = await snapshot();
    for (const name of [
      TAKEOVER_BOXES.typed.name,
      TAKEOVER_BOXES.keyed.name,
      TAKEOVER_BOXES.pasted.name,
      TAKEOVER_BOXES.pressed.name,
      TAKEOVER_RENAMED,
      TAKEOVER_BOXES.framed.name,
    ]) {
      // Present and holding something that is not the Bot's, and marked so the server refuses the
      // Bot's own typing into it — the same as a box `computer_request_secret` filled.
      expect([name, named(after.elements, name)]).toMatchObject([
        name,
        { type: "password", value: "" },
      ]);
    }
    const botBox = named(after.elements, TAKEOVER_BOT_BOX);
    expect(
      (
        await post("/type", {
          ref: botBox.ref,
          snapshotId: after.snapshotId,
          text: "봇이 쓴 메모",
        })
      ).status,
    ).toBe(200);
    const again = await snapshot();
    // Nothing a person typed made every box blind: the Bot's own box shows the Bot's own words.
    expect(named(again.elements, TAKEOVER_BOT_BOX)).toMatchObject({
      value: "봇이 쓴 메모",
    });
    expect(named(again.elements, TAKEOVER_BOT_BOX)).not.toHaveProperty("type");
    await get("/read");
    await post("/tabs/switch", { index: 0 });
    const current = await snapshot();
    await post("/scroll", { deltaY: 100 });
    await post("/click", {
      ref: named(current.elements, TAKEOVER_BUTTON).ref,
      snapshotId: current.snapshotId,
    });
    await post("/key", { key: "Tab" });
    // Refusals, each for its own reason.
    expect(
      (await post("/click", { ref: "e999", snapshotId: current.snapshotId }))
        .status,
    ).toBe(409);
    expect((await post("/tabs/switch", { index: 9 })).status).toBe(400);
    expect((await post("/human/type", { text: "late" })).status).toBe(409);
    expect((await post("/human/secret", { text: "late" })).status).toBe(409);
    // And following the boxes is not a one-look trick.
    await snapshot();
    screen.close();

    expect(leaks(seen, Object.values(typed))).toEqual([]);
    expect(
      leaks(
        [{ path: "the live screen", text: screen.said.join("\n") }],
        Object.values(typed),
      ),
    ).toEqual([]);
    // Recorded that typing happened, never what was typed: not in the log, not on the disk.
    expect(
      leaks(
        [
          { path: "the computer's log", text: logged },
          {
            path: "the Bot's saved state",
            text: await everyFile(join(profilesDir, "bot.state")),
          },
        ],
        Object.values(typed),
      ),
    ).toEqual([]);
  }, 120_000);

  test("sent by a form as GET, is blanked from every address the Bot is handed, and the rest of the address is kept", async () => {
    const bot = asBot("get-form-takeover-bot");
    const { post, get, snapshot, seen } = bot;
    const SECRET = "SEC-GETFORM-TAKE-3301";
    expect(
      (await post("/navigate", { url: `${fixture?.url}get-form` })).status,
    ).toBe(200);

    expect((await post("/control/take")).status).toBe(200);
    await post("/human/click", GET_FORM_BOX);
    await post("/human/type", { text: SECRET });
    expect((await post("/human/key", { key: "Enter" })).status).toBe(200);
    expect((await post("/control/release")).status).toBe(200);

    expect(
      await until(async () => (await get("/read")).text.includes(LANDED_TEXT)),
    ).toBe(true);
    const landed = await snapshot();
    expect(new URL(landed.url).pathname).toBe("/landed");
    // The parameter is still there, empty; what nobody typed is untouched.
    expect(new URL(landed.url).searchParams.get("pin")).toBe("");
    expect(new URL(landed.url).searchParams.get("step")).toBe("2");
    expect(landed.tabs.map((tab) => new URL(tab.url).pathname)).toEqual([
      "/landed",
    ]);
    await post("/tabs/switch", { index: 0 });
    await post("/scroll", { deltaY: 100 });
    await post("/key", { key: "Tab" });

    expect(leaks(seen, [SECRET])).toEqual([]);
  }, 60_000);

  test("into a page whose next document is on its way, shows no box's contents until that page is gone", async () => {
    const bot = asBot("blind-takeover-bot");
    const { post, get, snapshot, seen } = bot;
    const SECRET = "BLIND-TYPED-7002";
    expect(
      (await post("/navigate", { url: `${fixture?.url}takeover` })).status,
    ).toBe(200);
    expect((await post("/control/take")).status).toBe(200);
    // The link starts a navigation that ends, after a while, with no document: the tab stays where it
    // was, and while it is on its way the page answers no question about its focus.
    await post("/human/click", TAKEOVER_SLOW_LINK);
    const leftAt = Date.now();
    await Bun.sleep(300);
    await post("/human/click", TAKEOVER_BOXES.typed);
    const typedAt = Date.now();
    expect((await post("/human/type", { text: SECRET })).status).toBe(200);
    // Not waited on: a person typing into a page that will not answer is not kept waiting.
    expect(Date.now() - typedAt).toBeLessThan(1_000);
    // And it was typed while the page was on its way, which is what this test is about.
    const notes = ((await get("/read")).body.notes ?? []) as { code: string }[];
    expect(notes.map((note) => note.code)).toContain("laf:page_loading");
    await Bun.sleep(
      Math.max(0, leftAt + SLOW_NO_CONTENT_MS + 700 - Date.now()),
    );
    expect((await post("/control/release")).status).toBe(200);

    const after = await snapshot();
    expect(new URL(after.url).pathname).toBe("/takeover");
    // The value is in the box — a value is present — and shown as nothing, like every box on the
    // page, with no mark: nothing found the box, so nothing can say which one it was.
    const box = named(after.elements, TAKEOVER_BOXES.typed.name);
    expect(box.value).toBe("");
    expect(box).not.toHaveProperty("type");
    expect(leaks(seen, [SECRET])).toEqual([]);

    // A new document is a page nobody typed into: the Bot's own words show again.
    expect(
      (await post("/navigate", { url: `${fixture?.url}takeover` })).status,
    ).toBe(200);
    const fresh = await snapshot();
    const botBox = named(fresh.elements, TAKEOVER_BOT_BOX);
    await post("/type", {
      ref: botBox.ref,
      snapshotId: fresh.snapshotId,
      text: "새 문서의 메모",
    });
    expect(named((await snapshot()).elements, TAKEOVER_BOT_BOX).value).toBe(
      "새 문서의 메모",
    );
  }, 60_000);
});

describe.skipIf(!HAS_BROWSER)(
  "a secret typed through the request, into a form sent by GET",
  () => {
    test("is blanked from the address on the key that sent it, the next look, its tabs and the read", async () => {
      const bot = asBot("get-form-request-bot");
      const { post, get, snapshot, seen } = bot;
      const SECRET = "SEC-GETFORM-7788";
      expect(
        (await post("/navigate", { url: `${fixture?.url}get-form` })).status,
      ).toBe(200);
      const before = await snapshot();
      const box = named(before.elements, GET_FORM_BOX.name);
      expect(
        (
          await post("/control/secret", {
            label: "간편결제 확인",
            ref: box.ref,
            snapshotId: before.snapshotId,
          })
        ).status,
      ).toBe(200);
      expect((await post("/human/secret", { text: SECRET })).status).toBe(200);

      // The Bot presses Enter in the box, which sends the form and lands on `/landed?…&pin=…`.
      expect((await post("/key", { key: "Enter" })).status).toBe(200);
      expect(
        await until(async () =>
          (await get("/read")).text.includes(LANDED_TEXT),
        ),
      ).toBe(true);
      const landed = await snapshot();
      expect(new URL(landed.url).pathname).toBe("/landed");
      expect(new URL(landed.url).searchParams.get("pin")).toBe("");
      expect(new URL(landed.url).searchParams.get("step")).toBe("2");
      await post("/tabs/switch", { index: 0 });
      // Again, after the box it was typed into is long gone.
      await snapshot();
      await get("/read");

      expect(leaks(seen, [SECRET])).toEqual([]);
    }, 60_000);
  },
);
