import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PW_FIELDS, serveFixture } from "./fixture-site";

/**
 * A VALUE TYPED THROUGH `computer_request_secret` NEVER REACHES THE NEXT SNAPSHOT.
 *
 * The whole process, over HTTP, on the auditor's page — because the leak was invisible from every
 * unit test this workspace had. `aria-snapshot.test.ts` proved that a password box WITH a label the
 * DOM could see lost its value; the page that leaked labels its box through `aria-labelledby`,
 * which `HTMLInputElement.labels` does not see, under a word (패스워드) no list carried. Measured
 * 2026-09-10 in the published `:stable` container and in main: `request_secret`, the person types,
 * the next `/snapshot` carries the value. Asserted on the WHOLE serialised body of every call the
 * Bot is handed next, the way CLAUDE.md says a secret is tested.
 *
 * Skipped where Playwright has no browser downloaded, and says so, like `korean-sites.test.ts`.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const BOT = "secret-bot";
const TOKEN = "test-computer-token";

let base = "";
let fixture: ReturnType<typeof serveFixture> | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;
let profilesDir = "";
let workspaceDir = "";

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

type Body = Record<string, unknown>;

async function call(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Body; text: string }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": BOT,
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: (() => {
      try {
        return JSON.parse(text) as Body;
      } catch {
        return {};
      }
    })(),
  };
}

const post = (path: string, payload: unknown) =>
  call(path, { method: "POST", body: JSON.stringify(payload) });

type Element = {
  ref: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
};

async function snapshot() {
  const result = await post("/snapshot", {});
  expect(result.status).toBe(200);
  const body = result.body as { snapshotId: number; elements: Element[] };
  return {
    text: result.text,
    snapshotId: body.snapshotId,
    elements: body.elements ?? [],
  };
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

/** The Bot asks for a value into a field, and a person types it. */
async function typeThroughTheDoor(
  ref: string,
  snapshotId: number,
  text: string,
) {
  const asked = await post("/control/secret", {
    label: "로그인에 필요한 값",
    ref,
    snapshotId,
  });
  expect(asked.status).toBe(200);
  const supplied = await post("/human/secret", { text });
  expect(supplied.status).toBe(200);
  expect(supplied.body.characters).toBe(text.length);
  // The door itself answers with a count, never the value.
  expect(supplied.text).not.toContain(text);
}

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  fixture = serveFixture();
  profilesDir = await mkdtemp(join(tmpdir(), "laf-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-workspace-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      // The fixture is served on 127.0.0.1, which the navigation guard refuses without this — the
      // same opt-in a laptop deployment sets to browse its own services (navigation-guard.ts).
      AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      // A laptop has no host to hold the browser's egress rules (egress-guard.ts).
      AGENT_COMPUTER_EGRESS_FIREWALL: "off",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
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
  "a secret typed through the request, on the auditor's page",
  () => {
    test("into every way a page names or marks a secret box, and nowhere in anything the Bot reads next", async () => {
      expect(
        (await post("/navigate", { url: `${fixture?.url}pw` })).status,
      ).toBe(200);

      // One value per field, each distinct, so a leak says which field it came from.
      const typed = new Map<string, string>([
        [PW_FIELDS.labelledby, "PERSON-TYPED-SECRET-7788"],
        [PW_FIELDS.currentPassword, "current-password-canary-5521"],
        [PW_FIELDS.placeholder, "placeholder-canary-9034"],
        [PW_FIELDS.oneTimeCode, "482913"],
      ]);
      for (const [name, value] of typed) {
        const before = await snapshot();
        await typeThroughTheDoor(
          named(before.elements, name).ref,
          before.snapshotId,
          value,
        );
      }

      // Everything the Bot would be handed next, serialised whole.
      const next = await snapshot();
      const read = await call("/read");
      for (const value of typed.values()) {
        expect(next.text).not.toContain(value);
        expect(read.text).not.toContain(value);
      }

      // Present and empty, not absent — the Bot must be able to press 로그인 rather than ask again —
      // and marked, which is what the server's deny rule reads before a Bot types into one.
      for (const name of typed.keys()) {
        expect(named(next.elements, name)).toMatchObject({
          type: "password",
          value: "",
        });
      }
      // The username is nobody's secret, and nothing here made it one.
      expect(named(next.elements, PW_FIELDS.plain)).not.toHaveProperty("type");
    }, 60_000);

    test("marked by the markup before anyone types: the type, the token, whatever the name", async () => {
      expect(
        (await post("/navigate", { url: `${fixture?.url}pw` })).status,
      ).toBe(200);
      const first = await snapshot();
      for (const name of [
        PW_FIELDS.labelledby,
        PW_FIELDS.currentPassword,
        PW_FIELDS.placeholder,
        PW_FIELDS.oneTimeCode,
      ]) {
        expect([name, named(first.elements, name).type]).toEqual([
          name,
          "password",
        ]);
      }
      expect(named(first.elements, PW_FIELDS.plain)).not.toHaveProperty("type");
      expect(named(first.elements, PW_FIELDS.renames)).not.toHaveProperty(
        "type",
      );
    }, 60_000);

    test("a box nothing marks is followed by identity, through a rename, until the page is gone", async () => {
      const VALUE = "TYPED-INTO-AN-UNMARKED-BOX-4411";
      expect(
        (await post("/navigate", { url: `${fixture?.url}pw` })).status,
      ).toBe(200);
      const first = await snapshot();
      const box = named(first.elements, PW_FIELDS.renames);
      expect(box).not.toHaveProperty("type");

      await typeThroughTheDoor(box.ref, first.snapshotId, VALUE);

      // The box renamed itself on the keystroke, so Playwright handed it a new ref: neither the
      // old ref, nor the name, nor any word is what finds it now.
      const next = await snapshot();
      expect(next.text).not.toContain(VALUE);
      const renamed = named(next.elements, PW_FIELDS.renamed);
      expect(renamed.ref).not.toBe(box.ref);
      expect(renamed).toMatchObject({ type: "password", value: "" });
      // And again: following it is not a one-snapshot trick.
      expect((await snapshot()).text).not.toContain(VALUE);

      // Leaving the page lets the field go: the same page, loaded fresh, is ordinary again.
      await post("/navigate", { url: `${fixture?.url}other` });
      await post("/navigate", { url: `${fixture?.url}pw` });
      const fresh = await snapshot();
      expect(named(fresh.elements, PW_FIELDS.renames)).not.toHaveProperty(
        "type",
      );
    }, 60_000);
  },
);
