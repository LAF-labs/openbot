import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  EDITABLE_BOT_BOX,
  EDITABLE_BOT_EDITOR,
  EDITABLE_CARD_EDITOR,
  EDITABLE_SHAPES,
  type EditableShape,
  GET_FORM_BOX,
  KEEP_ALIVE_CLOSE,
  KEEP_ALIVE_OPEN,
  LANDED_TEXT,
  LEFT_OWNED_NOTE,
  LEFT_OWNER_BUTTON,
  LEFT_TAB,
  LEFT_TITLE,
  SLOW_NO_CONTENT_MS,
  serveFixture,
  TAKEOVER_BOT_BOX,
  TAKEOVER_BOXES,
  TAKEOVER_BUTTON,
  TAKEOVER_RENAMED,
  TAKEOVER_SLOW_LINK,
  TYPED_ARTICLE_NOTE,
  TYPED_BOT_BOX,
  TYPED_BOX,
  TYPED_FAR_BUTTON,
  TYPED_NEAR_LINK,
  TYPED_PLACE,
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
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event) => {
    // A picture is bytes (`shared/screen-frame.ts`); everything the computer says is text.
    if (typeof event.data !== "string") frames += 1;
    else said.push(event.data);
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
      // A laptop has no host to hold the browser's egress rules (egress-guard.ts).
      AGENT_COMPUTER_EGRESS_FIREWALL: "off",
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

/**
 * AND WHERE THE TYPING IS NOT INTO A FORM'S BOX.
 *
 * An editable region (`contenteditable`) is what a rich editor, a chat composer and a page title a
 * person can rename are made of. The tree prints a plain one as `generic`, which a look never lists,
 * and `person-typing.ts` left them unfollowed for that reason — but what a look lists is the link,
 * the button or the tab AROUND one, named by its words, and what `/read` hands over is the page's
 * text, with every region's in it. Each place below gets a canary of its own from a person holding
 * the wheel, and then everything the Bot is handed is read for each of them.
 */
describe.skipIf(!HAS_BROWSER)(
  "a person's typing into an editable region during a takeover",
  () => {
    const canary = (shape: string) => `CANARY-${shape}-7391`;
    const shapes = Object.keys(EDITABLE_SHAPES) as EditableShape[];
    /** Where a canary shows in what a look and two reads handed over, said place by place. */
    const shownIn = (
      texts: readonly string[],
      look: { elements: Element[] },
      reads: Answer[],
    ) =>
      texts.flatMap((text) => [
        ...look.elements
          .filter((element) => element.name.includes(text))
          .map((element) => `${text}: the name of a ${element.role}`),
        ...look.elements
          .filter((element) => element.value?.includes(text))
          .map((element) => `${text}: the value of a ${element.role}`),
        ...reads
          .filter((read) => read.text.includes(text))
          .map((read) => `${text}: ${read.path}`),
      ]);

    test("is in nothing the Bot is handed afterwards: not as the region's own contents, not in the name or value of a control that takes them from it, not in the page's text", async () => {
      const { post, get, snapshot, seen } = asBot("editable-takeover-bot");
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-editable` }))
          .status,
      ).toBe(200);
      await snapshot();

      expect((await post("/control/take")).status).toBe(200);
      for (const shape of shapes) {
        const clicked = await post("/human/click", EDITABLE_SHAPES[shape]);
        const typed = await post("/human/type", { text: canary(shape) });
        expect([shape, clicked.status, typed.status]).toEqual([
          shape,
          200,
          200,
        ]);
      }
      // Every canary went where it was meant to: the page says which place took how many characters.
      await until(() =>
        shapes.every(
          (shape) => (fixture?.typedInto()[shape] ?? 0) >= canary(shape).length,
        ),
      );
      const landed = fixture?.typedInto() ?? {};
      expect(
        shapes.filter((shape) => (landed[shape] ?? 0) < canary(shape).length),
      ).toEqual([]);
      expect((await post("/control/release")).status).toBe(200);

      // The Bot's turn. Where each canary shows, said place by place before the whole is searched.
      const after = await snapshot();
      expect(
        shownIn(shapes.map(canary), after, [
          await get("/read"),
          await get("/read?whole=1"),
        ]),
      ).toEqual([]);

      // Nothing a person typed made the page unreadable: what the Bot writes itself, into a box and
      // into a region, it is shown and reads back.
      for (const [name, text] of [
        [EDITABLE_BOT_BOX, "봇이 쓴 메모"],
        [EDITABLE_BOT_EDITOR, "봇이 쓴 글"],
      ] as const) {
        const now = await snapshot();
        expect(
          (
            await post("/type", {
              ref: named(now.elements, name).ref,
              snapshotId: now.snapshotId,
              text,
            })
          ).status,
        ).toBe(200);
      }
      const own = await snapshot();
      expect(named(own.elements, EDITABLE_BOT_BOX)).toMatchObject({
        value: "봇이 쓴 메모",
      });
      expect(named(own.elements, EDITABLE_BOT_BOX)).not.toHaveProperty("type");
      const reread = await get("/read?whole=1");
      expect(String(reread.body.text)).toContain("봇이 쓴 글");
      // And the rest of the page is still there to be read.
      expect(String(reread.body.text)).toContain("글 쓰는 화면");
      await post("/scroll", { deltaY: 100 });
      await post("/key", { key: "Tab" });
      await snapshot();

      expect(leaks(seen, shapes.map(canary))).toEqual([]);
      expect(
        leaks(
          [
            { path: "the computer's log", text: logged },
            {
              path: "the Bot's saved state",
              text: await everyFile(join(profilesDir, "bot.state")),
            },
          ],
          shapes.map(canary),
        ),
      ).toEqual([]);
    }, 120_000);

    /*
     * The masked card types for the person (`/human/secret`), into the box the Bot named — and a
     * region that says it is a text box is a box the Bot can name. Blanked in the list like any
     * other, it was read out whole by `/read`: the one value the card exists to keep from the model.
     */
    test("supplied through the masked card, is not in the page's text either", async () => {
      const { post, get, snapshot, seen } = asBot("editable-card-bot");
      const SECRET = canary("card");
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-editable` }))
          .status,
      ).toBe(200);
      const before = await snapshot();
      expect(
        (
          await post("/control/secret", {
            label: "편집기에 넣을 값",
            ref: named(before.elements, EDITABLE_CARD_EDITOR).ref,
            snapshotId: before.snapshotId,
          })
        ).status,
      ).toBe(200);
      expect((await post("/human/secret", { text: SECRET })).status).toBe(200);

      const after = await snapshot();
      expect(named(after.elements, EDITABLE_CARD_EDITOR)).toMatchObject({
        type: "password",
      });
      expect(
        shownIn([SECRET], after, [
          await get("/read"),
          await get("/read?whole=1"),
        ]),
      ).toEqual([]);
      expect(leaks(seen, [SECRET])).toEqual([]);
    }, 60_000);
  },
);

/**
 * WHAT KEEPING A PERSON'S TYPING OUT COSTS EVERYTHING ELSE ON THE PAGE, which has to be nothing.
 *
 * The first version of the rule above asked the page about every control of a tab a person had
 * typed into, called a page typed into blind after one second without an answer, and let a node
 * go the moment a page took it out of its document. Each of those is a way for the hand-off every
 * sign-in uses to leave a Bot with a page it cannot act on, or to hand a person's typing back.
 * Each page below has one place a person types (`TYPED_PLACE`, inside a link), one box they type
 * into, and a box and a button that are nobody's but the Bot's.
 */
describe.skipIf(!HAS_BROWSER)(
  "around a node a person typed into, during a takeover",
  () => {
    /** Nothing the Bot was handed, and nothing this process wrote, says any of these. */
    const nowhere = async (seen: Seen, typed: string[]) => {
      expect(leaks(seen, typed)).toEqual([]);
      expect(
        leaks(
          [
            { path: "the computer's log", text: logged },
            {
              path: "the Bot's saved state",
              text: await everyFile(join(profilesDir, "bot.state")),
            },
          ],
          typed,
        ),
      ).toEqual([]);
    };
    /** The page's own word for where typing landed: that place, holding that many characters. */
    const landedIn = async (places: Record<string, string | undefined>) => {
      await until(() =>
        Object.entries(places).every(
          ([place, text]) => fixture?.typedInto()[place] === text?.length,
        ),
      );
      expect(fixture?.typedInto()).toMatchObject(
        Object.fromEntries(
          Object.entries(places).map(([place, text]) => [place, text?.length]),
        ),
      );
    };
    /** The Bot writes in its own box, and is shown what it wrote: the page is not one typed into blind. */
    const botSeesItsOwn = async (bot: ReturnType<typeof asBot>) => {
      const now = await bot.snapshot();
      expect(
        (
          await bot.post("/type", {
            ref: named(now.elements, TYPED_BOT_BOX).ref,
            snapshotId: now.snapshotId,
            text: "봇이 쓴 메모",
          })
        ).status,
      ).toBe(200);
      const own = named((await bot.snapshot()).elements, TYPED_BOT_BOX);
      expect(own).toMatchObject({ value: "봇이 쓴 메모" });
      expect(own).not.toHaveProperty("type");
    };

    /*
     * BLIND IS FOR A PAGE THAT CANNOT SAY WHAT HAS FOCUS, AND A SLOW PAGE CAN. One second of silence
     * under one key used to be enough, and the document then showed the Bot no box's contents — its
     * own included — for as long as it lived. This page is busy for a second and a half.
     */
    test("a page that is slow to answer under a key is not typed into blind: the box they typed into is hushed, and nothing else", async () => {
      const bot = asBot("slow-page-bot");
      const { post, get, snapshot, seen } = bot;
      const SECRET = "CANARY-slow-page-7391";
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-slow` }))
          .status,
      ).toBe(200);
      await snapshot();
      expect((await post("/control/take")).status).toBe(200);
      // The box takes focus, and a tenth of a second later the page is busy.
      fixture?.forgetTyping();
      await post("/human/click", TYPED_BOX);
      await Bun.sleep(300);
      expect((await post("/human/type", { text: SECRET })).status).toBe(200);
      await landedIn({ box: SECRET });
      expect((await post("/control/release")).status).toBe(200);

      const after = await snapshot();
      // Followed by what the page said had focus, once it said: marked, and blank.
      expect(named(after.elements, TYPED_BOX.name)).toMatchObject({
        type: "password",
        value: "",
      });
      await botSeesItsOwn(bot);
      await get("/read");
      await nowhere(seen, [SECRET]);
    }, 60_000);

    /*
     * ONLY THE CONTROLS THAT COULD BE NAMED OUT OF WHAT WAS TYPED ARE ASKED ABOUT. On this page the
     * names step gets no answer for any control it asks about. Asked about every control, that
     * was every control nameless and every click refused as renamed.
     */
    test("a page that gives the names step no answer costs the control around what was typed its name, and no other control anything", async () => {
      const { post, get, snapshot, seen } = asBot("silent-names-bot");
      const SECRET = "CANARY-silent-names-7391";
      expect(
        (
          await post("/navigate", {
            url: `${fixture?.url}takeover-silent-names`,
          })
        ).status,
      ).toBe(200);
      await snapshot();
      expect((await post("/control/take")).status).toBe(200);
      fixture?.forgetTyping();
      await post("/human/click", TYPED_PLACE);
      expect((await post("/human/type", { text: SECRET })).status).toBe(200);
      await landedIn({ near: SECRET });
      expect((await post("/control/release")).status).toBe(200);

      const after = await snapshot();
      // The link around the region: asked about, not answered for, and so not named.
      expect(
        after.elements
          .filter((element) => element.role === "link")
          .map((element) => element.name),
      ).toEqual([""]);
      // Everything else is listed as it would be on a page nobody typed into.
      expect(
        after.elements
          .filter((element) => element.role !== "link")
          .map((element) => element.name),
      ).toEqual([TYPED_BOX.name, TYPED_BOT_BOX, TYPED_FAR_BUTTON]);
      // And can be acted on: held to its name, the button is pressed.
      const pressed = await post("/click", {
        ref: named(after.elements, TYPED_FAR_BUTTON).ref,
        snapshotId: after.snapshotId,
        element: { role: "button", name: TYPED_FAR_BUTTON },
      });
      expect(pressed.status).toBe(200);
      expect((await post("/snapshot")).body.title).toBe("눌림");
      await get("/read");
      await nowhere(seen, [SECRET]);
    }, 60_000);

    /*
     * THE SAME NODE, PUT BACK. A look while the node was out of its document used to let it go, and
     * the node came back with what was typed in it and nobody following it.
     */
    test("a node the page takes out of its document and puts back is still theirs: a look in between drops nothing", async () => {
      const { post, get, snapshot, seen } = asBot("keep-alive-bot");
      const typed = ["CANARY-kept-region-7391", "CANARY-kept-box-7391"];
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-keep-alive` }))
          .status,
      ).toBe(200);
      await snapshot();
      expect((await post("/control/take")).status).toBe(200);
      fixture?.forgetTyping();
      await post("/human/click", TYPED_PLACE);
      await post("/human/type", { text: typed[0] });
      await post("/human/click", TYPED_BOX);
      await post("/human/type", { text: typed[1] });
      await landedIn({ near: typed[0], box: typed[1] });
      expect((await post("/control/release")).status).toBe(200);

      const press = async (name: string) => {
        const now = await snapshot();
        expect(
          (
            await post("/click", {
              ref: named(now.elements, name).ref,
              snapshotId: now.snapshotId,
            })
          ).status,
        ).toBe(200);
      };
      await press(KEEP_ALIVE_CLOSE);
      // A look and a read while the panel is out: neither the box nor the link is on the page.
      const out = await snapshot();
      expect(out.elements.map((element) => element.name)).toEqual([
        KEEP_ALIVE_CLOSE,
        KEEP_ALIVE_OPEN,
      ]);
      await get("/read");
      await press(KEEP_ALIVE_OPEN);

      const back = await snapshot();
      expect(named(back.elements, TYPED_BOX.name)).toMatchObject({
        type: "password",
        value: "",
      });
      expect(
        back.elements
          .filter((element) => element.role === "link")
          .map((element) => element.name),
      ).toEqual([TYPED_NEAR_LINK]);
      await get("/read");
      await get("/read?whole=1");
      await nowhere(seen, typed);
    }, 60_000);

    /*
     * TWO LOOKS AT ONE TAB AT ONCE — a routine running while a person chats, the app's own check
     * of a site while a turn looks. A read asks where the marked nodes are with the same question
     * a look does, and the mark that says "near" held only the latest asker's token: a read that
     * landed between a look's scan and its question wrote over it, the look found nothing near,
     * and the link around what a person had typed was listed under the tree's name. Each look's
     * marks are its own now, and a read makes none.
     */
    test("a look and reads of the same tab at once each leave what was typed out, every time", async () => {
      const { post, get, snapshot, seen } = asBot("overlapping-looks-bot");
      const typed = ["CANARY-overlap-region-7391", "CANARY-overlap-box-7391"];
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-typed` }))
          .status,
      ).toBe(200);
      await snapshot();
      expect((await post("/control/take")).status).toBe(200);
      fixture?.forgetTyping();
      await post("/human/click", TYPED_PLACE);
      await post("/human/type", { text: typed[0] });
      await post("/human/click", TYPED_BOX);
      await post("/human/type", { text: typed[1] });
      await landedIn({ near: typed[0], box: typed[1] });
      expect((await post("/control/release")).status).toBe(200);

      const links: string[][] = [];
      for (let round = 0; round < 25; round += 1) {
        const [look] = await Promise.all([
          snapshot(),
          get("/read"),
          get("/read?whole=1"),
          get("/read"),
          snapshot(),
        ]);
        links.push(
          look.elements
            .filter((element) => element.role === "link")
            .map((element) => element.name),
        );
      }
      // Every look named the link by the page's own words, and no answer of any kind said more.
      expect(links).toEqual(Array(25).fill([TYPED_NEAR_LINK]));
      await nowhere(seen, typed);
    }, 120_000);

    /*
     * A NODE A PERSON TYPED INTO IS ONE FOR AS LONG AS IT LIVES, WHATEVER IT IS NOW. A title or a
     * tab renamed in place is editable while it has focus and plain again once it loses it; the
     * node keeps its mark and the words a person typed. For one commit the reader left a marked
     * node out only while it was still editable, and this title was read out whole; and a marked
     * control was taken to be named by its own contents only while editable, so the tab was listed
     * under the name the browser gave it — what was typed.
     */
    test("typed into a title and a tab that stop being editable when they lose focus, is still not in the page's text or the tab's name", async () => {
      const { post, get, snapshot, seen } = asBot("renamed-title-bot");
      const TITLE = "CANARY-renamed-title-7391";
      const TAB = "CANARY-renamed-tab-7391";
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-left` }))
          .status,
      ).toBe(200);
      expect((await post("/control/take")).status).toBe(200);
      fixture?.forgetTyping();
      await post("/human/click", LEFT_TITLE);
      expect((await post("/human/type", { text: TITLE })).status).toBe(200);
      await post("/human/click", LEFT_TAB);
      expect((await post("/human/type", { text: TAB })).status).toBe(200);
      await landedIn({ title: TITLE, tab: TAB });
      // Focus goes elsewhere, and the page makes the tab plain again as it did the title.
      await post("/human/click", TYPED_BOX);
      expect((await post("/control/release")).status).toBe(200);

      const read = await get("/read");
      // The page was read — the words around the title are there — and the title's are not.
      expect(String(read.body.text)).toContain(TYPED_NEAR_LINK);
      await get("/read?whole=1");
      const after = await snapshot();
      // The tab is in the list, and is called nothing: all it was ever called is what was typed.
      expect(
        after.elements
          .filter((element) => element.role === "tab")
          .map((element) => element.name),
      ).toEqual([""]);
      await nowhere(seen, [TITLE, TAB]);
    }, 60_000);

    /*
     * WHAT AN ELEMENT OWNS BY ID IS FOUND IN ITS OWN TREE WHEN ITS NAME IS COMPUTED — the document,
     * or the shadow tree it is in. For one commit only the document was looked in, so a button in
     * a shadow tree that owns the note beside it was not near the note, was not asked about, and
     * kept the name the browser gave it: its own word and what a person typed.
     */
    test("typed into a note a button owns inside a shadow tree, is not in the button's name", async () => {
      const { post, get, snapshot, seen } = asBot("owned-note-bot");
      const SECRET = "CANARY-owned-note-7391";
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-left` }))
          .status,
      ).toBe(200);
      const before = await snapshot();
      expect(named(before.elements, LEFT_OWNER_BUTTON).role).toBe("button");
      expect((await post("/control/take")).status).toBe(200);
      fixture?.forgetTyping();
      await post("/human/click", LEFT_OWNED_NOTE);
      expect((await post("/human/type", { text: SECRET })).status).toBe(200);
      await landedIn({ owned: SECRET });
      expect((await post("/control/release")).status).toBe(200);

      const after = await snapshot();
      expect(
        after.elements
          .filter((element) => element.role === "button")
          .map((element) => element.name),
      ).toEqual([TYPED_FAR_BUTTON, LEFT_OWNER_BUTTON]);
      await get("/read");
      await get("/read?whole=1");
      await nowhere(seen, [SECRET]);
    }, 60_000);

    test("typed into a page read as its article, is not in the article", async () => {
      const { post, get, snapshot, seen } = asBot("article-bot");
      const SECRET = "CANARY-article-7391";
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-article` }))
          .status,
      ).toBe(200);
      expect((await post("/control/take")).status).toBe(200);
      fixture?.forgetTyping();
      await post("/human/click", TYPED_PLACE);
      expect((await post("/human/type", { text: SECRET })).status).toBe(200);
      await landedIn({ note: SECRET });
      expect((await post("/control/release")).status).toBe(200);

      const read = await get("/read");
      // Read as the article Reader View takes out, with the words beside what was typed in it.
      expect(read.body.reader).toBe(true);
      expect(String(read.body.text)).toContain(TYPED_ARTICLE_NOTE);
      await get("/read?whole=1");
      await snapshot();
      await nowhere(seen, [SECRET]);
    }, 60_000);

    /*
     * 고용24 REPLACES `Map`, and an object does not cross out of such a page: asked what had focus,
     * it answered nothing, so every key a person pressed there was a key typed blind.
     */
    test("on a page that replaces Map, a person's typing is followed to its box and its region, and only those are hushed", async () => {
      const bot = asBot("replaced-map-bot");
      const { post, get, snapshot, seen } = bot;
      const typed = ["CANARY-map-box-7391", "CANARY-map-region-7391"];
      expect(
        (await post("/navigate", { url: `${fixture?.url}takeover-map` }))
          .status,
      ).toBe(200);
      await snapshot();
      expect((await post("/control/take")).status).toBe(200);
      fixture?.forgetTyping();
      await post("/human/click", TYPED_BOX);
      await post("/human/type", { text: typed[0] });
      await post("/human/click", TYPED_PLACE);
      await post("/human/type", { text: typed[1] });
      await landedIn({ box: typed[0], near: typed[1] });
      expect((await post("/control/release")).status).toBe(200);

      const after = await snapshot();
      expect(named(after.elements, TYPED_BOX.name)).toMatchObject({
        type: "password",
        value: "",
      });
      // The link around the region is named by its own words, on a page that used to get no names.
      expect(
        after.elements
          .filter((element) => element.role === "link")
          .map((element) => element.name),
      ).toEqual([TYPED_NEAR_LINK]);
      await botSeesItsOwn(bot);
      await get("/read");
      await get("/read?whole=1");
      await nowhere(seen, typed);
    }, 60_000);
  },
);
