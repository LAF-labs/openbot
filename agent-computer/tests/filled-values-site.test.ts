import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { HIDDEN } from "../src/filled-values";
import { SHOWN_BACK, serveFixture } from "./fixture-site";

/**
 * A PAGE THAT SHOWS A PERSON'S VALUES BACK, AGAINST THE REAL COMPUTER (2026-10-10, record §6).
 *
 * A look blanks the box a value went into, and an address is blanked of what a form wrote into its
 * query. `/shown-back` leaves neither to find: signed in, it takes its boxes away and writes the
 * sign-in name and the password into its text, its title and the path of its address, and opens a
 * second tab that says them again. Every answer the Bot is handed is kept, whole, and searched for
 * both values — the rule for anything a person typed.
 *
 * And the run's end: the tab the values went into is closed, the Bot's next look is told so, and
 * only then is anything let go of.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "test-computer-token";
const WHO = "gibeom.kim77";
const PASSWORD = "Tr0ub4dor&3-CANARY";

let fixture: ReturnType<typeof serveFixture> | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let profilesDir = "";
let workspaceDir = "";

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  await new Response(stream).arrayBuffer();
}

type Body = Record<string, unknown>;
type Answer = { path: string; status: number; body: Body; text: string };
type Seen = { path: string; text: string }[];
type Element = { ref: string; role: string; name: string };
type Tab = { index: number; title: string; url: string; active: boolean };
type Note = { code: string } & Record<string, unknown>;

function asBot(bot: string) {
  const seen: Seen = [];
  const call = async (
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
  ): Promise<Answer> => {
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
  };
  const post = (path: string, payload: unknown = {}) =>
    call("POST", path, payload);
  const get = (path: string) => call("GET", path);
  const snapshot = async () => {
    const shot = await post("/snapshot");
    expect([shot.path, shot.status]).toEqual(["/snapshot", 200]);
    return {
      snapshotId: shot.body.snapshotId as number,
      url: String(shot.body.url),
      elements: (shot.body.elements ?? []) as Element[],
      tabs: (shot.body.tabs ?? []) as Tab[],
      notes: (shot.body.notes ?? []) as Note[],
    };
  };
  const press = async (name: string) => {
    const shot = await snapshot();
    const button = shot.elements.find((element) => element.name === name);
    if (!button) throw new Error(`nothing called ${name}`);
    const pressed = await post("/click", {
      ref: button.ref,
      snapshotId: shot.snapshotId,
    });
    expect([name, pressed.status]).toEqual([name, 200]);
  };
  /** Ask for both boxes on one card and answer it, as the server would for a person. */
  const signInAs = async (who: string, password: string) => {
    expect(
      (await post("/navigate", { url: `${fixture?.url}shown-back` })).status,
    ).toBe(200);
    const shot = await snapshot();
    const boxes = [SHOWN_BACK.id, SHOWN_BACK.password].map((name) => {
      const box = shot.elements.find((element) => element.name === name);
      if (!box) throw new Error(`nothing called ${name}`);
      return box;
    });
    const asked = await post("/control/secret", {
      fields: boxes.map((box) => ({ ref: box.ref, label: box.name })),
      snapshotId: shot.snapshotId,
    });
    expect(asked.status).toBe(200);
    const supplied = await post("/human/secret", {
      values: [who, password],
      fields: boxes.map((box) => ({
        ref: box.ref,
        element: { role: box.role, name: box.name },
      })),
      snapshotId: shot.snapshotId,
    });
    expect(supplied.status).toBe(200);
  };
  return { seen, post, get, snapshot, press, signInAs };
}

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

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  profilesDir = await mkdtemp(join(tmpdir(), "laf-filled-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-filled-workspace-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      // The fixture is served on 127.0.0.1, which the navigation guard refuses without this.
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

describe.skipIf(!HAS_BROWSER)(
  "values a person put into a page that shows them back",
  () => {
    test("are in nothing the Bot is handed for the rest of the run — the text, the title, the address, another tab — and no picture of it is to be kept", async () => {
      const { seen, post, get, snapshot, press, signInAs } =
        asBot("shown-back-bot");
      expect((await get("/control")).body.valuesHeld).toBeUndefined();
      await signInAs(WHO, PASSWORD);
      expect((await get("/control")).body.valuesHeld).toBe(true);

      await press(SHOWN_BACK.signIn);
      expect(
        await until(async () =>
          (await get("/read")).text.includes(SHOWN_BACK.said),
        ),
      ).toBe(true);
      // The page said both, and the Bot is told that something was taken out and where it stood.
      const read = await get("/read");
      expect(String(read.body.text)).toContain(
        `${SHOWN_BACK.said}: ${HIDDEN} / ${HIDDEN}`,
      );
      expect(read.body.notes).toContainEqual({ code: "laf:value_hidden" });
      const signedIn = await snapshot();
      expect(signedIn.url).toBe(`${fixture?.url}shown-back/${HIDDEN}`);
      expect(signedIn.tabs.map((tab) => tab.title)).toEqual([`${HIDDEN} 님`]);

      // A picture is not words. It says of itself that it is not one to keep, and still decodes.
      const picture = await get("/screenshot?format=jpeg&width=400&quality=70");
      expect(picture.status).toBe(200);
      expect(picture.body.valuesHeld).toBe(true);
      expect(String(picture.body.base64).startsWith("/9j/")).toBe(true);

      // A second tab, which no value was put into, says them again: the run's, not the tab's.
      await press(SHOWN_BACK.receipt);
      expect(
        await until(async () => (await snapshot()).tabs.length === 2),
      ).toBe(true);
      const both = await snapshot();
      expect(both.tabs.map((tab) => tab.title).sort()).toEqual(
        [`${HIDDEN} 님`, `${HIDDEN} 확인서`].sort(),
      );
      for (const tab of both.tabs) {
        await post("/tabs/switch", { index: tab.index });
        await snapshot();
        const said = await get("/read");
        expect(String(said.body.text)).toContain(`${HIDDEN} / ${HIDDEN}`);
      }

      /*
       * A FILE IS NOT THE BROWSER'S. The Bot's folder holds the person's own files, read to be
       * changed and written back: a list with the mark where their sign-in name stood would be
       * saved that way. Read through the same door, in the same run, it comes back as written.
       */
      const written = await post("/files/write", {
        path: "customers.txt",
        contents: `kim,${WHO}\n`,
      });
      expect(written.status).toBe(200);
      const file = await post("/files/read", { path: "customers.txt" });
      expect(file.text).toContain(WHO);

      expect(
        leaks(
          seen.filter(({ path }) => !path.startsWith("/files/")),
          [WHO, PASSWORD],
        ),
      ).toEqual([]);
    }, 90_000);

    test("when the run ends, the tab they went into is closed, the Bot's next look is told so, and only then is anything let go of", async () => {
      const { post, get, snapshot, press, signInAs } = asBot("run-ended-bot");
      // A run nothing was put into ends nothing.
      expect((await post("/run/ended")).body).toEqual({
        ended: true,
        closed: 0,
      });
      await signInAs(WHO, PASSWORD);
      await press(SHOWN_BACK.signIn);
      await press(SHOWN_BACK.receipt);
      expect(
        await until(async () => (await snapshot()).tabs.length === 2),
      ).toBe(true);
      const index = (await snapshot()).tabs.findIndex((tab) => tab.active);

      const ended = await post("/run/ended");
      expect(ended.body).toEqual({ ended: true, closed: 1 });
      expect((await get("/control")).body.valuesHeld).toBeUndefined();
      expect(
        (await get("/screenshot?format=jpeg&width=400&quality=70")).body
          .valuesHeld,
      ).toBeUndefined();

      // The list the Bot's index was read from is another list: nothing acts before it looks.
      const early = await post("/tabs/switch", { index });
      expect([early.status, early.body.code]).toEqual([409, "laf:stale_refs"]);
      const after = await snapshot();
      expect(after.notes).toContainEqual({
        code: "laf:value_tab_closed",
        origin: new URL(String(fixture?.url)).origin,
      });
      expect(after.tabs).toHaveLength(1);
      expect(new URL(after.tabs[0]?.url ?? "").pathname).toBe(
        "/shown-back-receipt",
      );
      // Said once.
      expect((await snapshot()).notes).not.toContainEqual(
        expect.objectContaining({ code: "laf:value_tab_closed" }),
      );
      // And ended again, it ends nothing.
      expect((await post("/run/ended")).body).toEqual({
        ended: true,
        closed: 0,
      });
    }, 90_000);

    test("a browser that is stopped has let go of them with its tabs", async () => {
      const { post, get, signInAs } = asBot("stopped-bot");
      await signInAs(WHO, PASSWORD);
      expect((await get("/control")).body.valuesHeld).toBe(true);
      expect((await post("/computers/stop")).body).toMatchObject({
        stopped: true,
        wasRunning: true,
      });
      expect((await get("/control")).body.valuesHeld).toBeUndefined();
      // Nothing is held, so the run's end has nothing to close — and starts no browser to do it.
      expect((await post("/run/ended")).body).toEqual({
        ended: true,
        closed: 0,
      });
    }, 90_000);
  },
);
