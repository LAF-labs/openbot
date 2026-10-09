import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { GET_FORM_BOX, LANDED_TEXT, serveFixture } from "./fixture-site";

/**
 * A VALUE A PERSON TYPED, SENT BY A FORM AS GET, IS IN NO ADDRESS THE BOT IS HANDED.
 *
 * A GET form puts what was typed into the address it lands on, and that address rode out on the
 * `/key` that pressed Enter, the next snapshot's `url` and `tabs`, and `/read` (audit R3-03,
 * 2026-09-16). The masked box `computer_request_secret` opens is the one way a person's typing
 * reaches the Bot's page, so it is the one door driven here. Everything the Bot is handed is
 * serialised whole and searched for the value, the way a secret is tested.
 *
 * Until 2026-10-09 this file drove a person's takeover too — `/human/type`, `/human/key` and the live
 * screen's socket, into boxes nothing marked as a secret. Nobody can take the wheel now, and those
 * doors are gone (owner, 2026-10-09); so are their tests, and the boxes the fixture drew for them.
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

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

/** Read a stream to its end, from the start, so a full pipe never stalls the child. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  await new Response(stream).arrayBuffer();
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
  profilesDir = await mkdtemp(join(tmpdir(), "laf-get-form-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-get-form-workspace-"));
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
