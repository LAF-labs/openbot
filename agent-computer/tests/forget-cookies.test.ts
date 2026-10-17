import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { FORGET_ORIGINS_MAX, originsOf } from "../src/computer-routes";
import { serveFixture, SIGNED_OUT_TEXT, signedInAs } from "./fixture-site";

/**
 * SIGNING THE BROWSER OUT OF SOME SITES AND NOT THE OTHERS, on a real Chromium.
 *
 * A person leaving their company keeps their own logins and loses the company's
 * (`server/src/hub/leave.ts`). One fixture site answers on two hosts — `127.0.0.1` and
 * `localhost` are two cookie jars to a browser, whatever the port — and each is signed in as
 * somebody else. Forgetting one origin must sign that one out and leave the other signed in; a
 * delete that emptied the jar, or one that touched nothing, fails one of the two reads.
 *
 * Skipped where Playwright has no browser downloaded, as `shared-profile.test.ts` is.
 */

const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const TOKEN = "test-computer-token";
const BOT = "shop-bot";

describe("which origins a forget will take", () => {
  test("exact http(s) origins, each once", () => {
    expect(
      originsOf([
        "https://wing.example.co.kr",
        "http://127.0.0.1:8080",
        "https://wing.example.co.kr",
      ]),
    ).toEqual(["https://wing.example.co.kr", "http://127.0.0.1:8080"]);
    expect(originsOf([])).toEqual([]);
  });

  test.each([
    ["a path", ["https://wing.example.co.kr/login"]],
    ["a trailing slash", ["https://wing.example.co.kr/"]],
    ["a bare host", ["wing.example.co.kr"]],
    ["another scheme", ["file:///etc"]],
    ["not a string", [42]],
    ["not a list", "https://wing.example.co.kr"],
    ["nothing", undefined],
  ])("refuses %s", (_what, value) => {
    expect(originsOf(value)).toBeNull();
  });

  test("refuses more than a call may name", () => {
    const many = Array.from(
      { length: FORGET_ORIGINS_MAX + 1 },
      (_, at) => `https://site${at}.example.com`,
    );
    expect(originsOf(many)).toBeNull();
    expect(originsOf(many.slice(1))).toHaveLength(FORGET_ORIGINS_MAX);
  });
});

let fixture: ReturnType<typeof serveFixture> | null = null;
let profilesDir = "";
let workspaceDir = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let base = "";

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

async function post(
  path: string,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": TOKEN,
      "x-openbot-bot-id": BOT,
    },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    body: ((await response.json().catch(() => null)) ?? {}) as Record<
      string,
      unknown
    >,
  };
}

const pageText = async (url: string) =>
  String((await post("/navigate", { url })).body.text ?? "");

describe.if(HAS_BROWSER)("forgetting the cookies of some origins", () => {
  beforeAll(async () => {
    fixture = serveFixture();
    profilesDir = await mkdtemp(join(tmpdir(), "laf-forget-profiles-"));
    workspaceDir = await mkdtemp(join(tmpdir(), "laf-forget-workspace-"));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], {
      env: {
        ...process.env,
        COMPUTER_TOKEN: TOKEN,
        PORT: String(port),
        PROFILES_DIR: profilesDir,
        WORKSPACE_DIR: workspaceDir,
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
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
  }, 30_000);

  afterAll(async () => {
    child?.kill();
    await child?.exited.catch(() => undefined);
    fixture?.stop();
    for (const dir of [profilesDir, workspaceDir]) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("signs out of the origin named and stays signed in everywhere else", async () => {
    const port = new URL(fixture?.url ?? "").port;
    const company = `http://127.0.0.1:${port}`;
    const own = `http://localhost:${port}`;

    await pageText(`${company}/sign-in?as=${encodeURIComponent("회사계정")}`);
    await pageText(`${own}/sign-in?as=${encodeURIComponent("내계정")}`);
    // Both signed in first: without this, a fixture that never set a cookie would pass below.
    expect(await pageText(`${company}/whoami`)).toContain(
      signedInAs("회사계정"),
    );
    expect(await pageText(`${own}/whoami`)).toContain(signedInAs("내계정"));

    const forgot = await post("/computers/cookies/forget", {
      origins: [company],
    });
    expect(forgot.status).toBe(200);
    expect(forgot.body).toMatchObject({
      forgotten: 1,
      origins: 1,
      scope: "deployment",
    });

    expect(await pageText(`${company}/whoami`)).toContain(SIGNED_OUT_TEXT);
    expect(await pageText(`${own}/whoami`)).toContain(signedInAs("내계정"));
  }, 60_000);

  test("refuses an origin with a path, and forgets nothing for it", async () => {
    const port = new URL(fixture?.url ?? "").port;
    const own = `http://localhost:${port}`;
    const refused = await post("/computers/cookies/forget", {
      origins: [`${own}/whoami`],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("laf:request_invalid");
    expect(await pageText(`${own}/whoami`)).toContain(signedInAs("내계정"));
  }, 30_000);
});
