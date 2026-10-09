import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { SIGN_IN, serveFixture } from "./fixture-site";

/**
 * A SAVED LOGIN, PUT INTO A REAL PAGE BY THE COMPUTER'S OWN DOOR (2026-10-10, record §6).
 *
 * The server sends a sign-in name and a password it took out of the vault, and the origins the
 * login was saved for. What is pinned here is what only the computer can know: which document a
 * box is in. `/saved-sign-in` says how long the value in each box is and never what it is; on
 * `/framed-saved-sign-in` the same boxes are in a frame from another origin than the page the tab is
 * on — this fixture answers on `127.0.0.1` and on `localhost`, two origins to a browser.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "test-computer-token";
const WHO = "saved.kim77";
const PASSWORD = "S4ved-CANARY&login";

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
  return { seen, post, get, snapshot };
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
  profilesDir = await mkdtemp(join(tmpdir(), "laf-login-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-login-workspace-"));
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

/** The fixture's two origins: where it is served, and the same server by its other name. */
const here = () => new URL(String(fixture?.url)).origin;
const elsewhere = () => here().replace("127.0.0.1", "localhost");

describe.skipIf(!HAS_BROWSER)(
  "a saved login and the page it is put into",
  () => {
    /** The two boxes of the sign-in on the page the Bot is on, as the server would name them. */
    const boxesOn = async (bot: ReturnType<typeof asBot>) => {
      const shot = await bot.snapshot();
      const [id, password] = [SIGN_IN.id, SIGN_IN.password].map((name) => {
        const box = shot.elements.find((element) => element.name === name);
        if (!box) throw new Error(`nothing called ${name}`);
        return box;
      });
      if (!id || !password) throw new Error("no sign-in on the page");
      return { shot, id, password };
    };
    const fillWith = async (
      bot: ReturnType<typeof asBot>,
      origins: string[],
      change: (fields: Record<string, unknown>[]) => void = () => undefined,
    ) => {
      const { shot, id, password } = await boxesOn(bot);
      const fields = [
        { ref: id.ref, element: { role: id.role, name: id.name }, value: WHO },
        {
          ref: password.ref,
          element: { role: password.role, name: password.name },
          value: PASSWORD,
        },
      ];
      change(fields);
      return bot.post("/login/fill", {
        fields,
        snapshotId: shot.snapshotId,
        origins,
      });
    };
    const lengths = async (bot: ReturnType<typeof asBot>) =>
      /칸에 든 글자 수 \d+\/\d+/.exec((await bot.get("/read")).text)?.[0];

    test("goes into the boxes of a page of the origin it was saved for, each value into its own, and is in nothing the Bot is handed", async () => {
      const bot = asBot("saved-login-bot");
      expect(
        (await bot.post("/navigate", { url: `${fixture?.url}saved-sign-in` }))
          .status,
      ).toBe(200);
      const { shot, id, password } = await boxesOn(bot);
      // Where the boxes are: the origin of their own document, and nothing of its address.
      const where = await bot.post("/login/where", {
        refs: [id.ref, password.ref],
        snapshotId: shot.snapshotId,
      });
      expect(where.body).toEqual({
        fields: [
          { ref: id.ref, origin: here() },
          { ref: password.ref, origin: here() },
        ],
      });

      const filled = await fillWith(bot, [here()]);
      expect(filled.status).toBe(200);
      expect(filled.body).toEqual({
        filled: true,
        fields: 2,
        url: `${fixture?.url}saved-sign-in`,
      });
      // In order: the name in the first box, the password in the second.
      expect(await lengths(bot)).toBe(
        SIGN_IN.lengths(WHO.length, PASSWORD.length),
      );
      // Held for the run like a value a person typed, and both boxes read as secret from here on.
      expect((await bot.get("/control")).body.valuesHeld).toBe(true);
      const after = await bot.snapshot();
      for (const name of [SIGN_IN.id, SIGN_IN.password]) {
        expect(
          after.elements.find((element) => element.name === name),
        ).toMatchObject({ type: "password", value: "" });
      }
      expect(leaks(bot.seen, [WHO, PASSWORD])).toEqual([]);
    }, 90_000);

    test("is put nowhere on a page of another origin, and nothing of it is held", async () => {
      const bot = asBot("wrong-site-bot");
      await bot.post("/navigate", { url: `${fixture?.url}saved-sign-in` });
      for (const origins of [
        ["https://shop.example"],
        // The same host by its other name is another origin, and so is another port.
        [elsewhere()],
        [`${here()}1`],
        [],
      ]) {
        const refused = await fillWith(bot, origins);
        expect([refused.status, refused.body.code]).toEqual([
          409,
          "laf:login_origin_mismatch",
        ]);
      }
      expect(await lengths(bot)).toBe(SIGN_IN.lengths(0, 0));
      expect((await bot.get("/control")).body.valuesHeld).toBeUndefined();
      expect(leaks(bot.seen, [WHO, PASSWORD])).toEqual([]);
    }, 90_000);

    test("belongs to the frame its boxes are in, not to the page the tab is on", async () => {
      const bot = asBot("framed-login-bot");
      const framed = `${fixture?.url}framed-saved-sign-in?from=${encodeURIComponent(elsewhere())}`;
      expect((await bot.post("/navigate", { url: framed })).status).toBe(200);
      expect(
        await until(async () =>
          (await bot.snapshot()).elements.some(
            (element) => element.name === SIGN_IN.password,
          ),
        ),
      ).toBe(true);
      const { shot, id, password } = await boxesOn(bot);
      const where = await bot.post("/login/where", {
        refs: [id.ref, password.ref],
        snapshotId: shot.snapshotId,
      });
      expect(
        (where.body.fields as { origin: string }[]).map(
          (field) => field.origin,
        ),
      ).toEqual([elsewhere(), elsewhere()]);

      // Saved for the page's own origin: the boxes are not that page's, and nothing goes in.
      const refused = await fillWith(bot, [here()]);
      expect([refused.status, refused.body.code]).toEqual([
        409,
        "laf:login_origin_mismatch",
      ]);
      expect((await bot.get("/control")).body.valuesHeld).toBeUndefined();

      // Saved for the frame's: it does.
      const filled = await fillWith(bot, [elsewhere()]);
      expect(filled.status).toBe(200);
      expect(
        await until(async () =>
          (await bot.get("/read")).text.includes(
            SIGN_IN.lengths(WHO.length, PASSWORD.length),
          ),
        ),
      ).toBe(true);
      expect(leaks(bot.seen, [WHO, PASSWORD])).toEqual([]);
    }, 90_000);

    test("is held to what each box was judged as and to the look it was named on: a box called something else, or an older look, gets nothing", async () => {
      const bot = asBot("held-login-bot");
      await bot.post("/navigate", { url: `${fixture?.url}saved-sign-in` });
      const renamed = await fillWith(bot, [here()], (fields) => {
        fields[1] = {
          ...fields[1],
          element: { role: "textbox", name: "댓글" },
        };
      });
      expect([renamed.status, renamed.body.code]).toEqual([
        409,
        "laf:label_changed",
      ]);
      // Asked of every box before any value went in: the name is not left in the first.
      expect(await lengths(bot)).toBe(SIGN_IN.lengths(0, 0));

      const { shot, id, password } = await boxesOn(bot);
      const stale = await bot.post("/login/fill", {
        fields: [
          {
            ref: id.ref,
            element: { role: id.role, name: id.name },
            value: WHO,
          },
          {
            ref: password.ref,
            element: { role: password.role, name: password.name },
            value: PASSWORD,
          },
        ],
        snapshotId: shot.snapshotId - 1,
        origins: [here()],
      });
      expect([stale.status, stale.body.code]).toEqual([409, "laf:stale_refs"]);
      const older = await bot.post("/login/where", {
        refs: [id.ref],
        snapshotId: shot.snapshotId - 1,
      });
      expect([older.status, older.body.code]).toEqual([409, "laf:stale_refs"]);

      // A call that names no box, an empty value, or more boxes than a card holds is no call.
      for (const fields of [
        [],
        [{ ref: id.ref, element: {}, value: "" }],
        Array.from({ length: 7 }, (_, index) => ({
          ref: `e${index}`,
          element: {},
          value: "x",
        })),
      ]) {
        const invalid = await bot.post("/login/fill", {
          fields,
          snapshotId: shot.snapshotId,
          origins: [here()],
        });
        expect(invalid.status).toBe(400);
      }
      expect((await bot.post("/login/where", { refs: [] })).status).toBe(400);
      expect(await lengths(bot)).toBe(SIGN_IN.lengths(0, 0));
      expect(leaks(bot.seen, [WHO, PASSWORD])).toEqual([]);
    }, 90_000);
  },
);
