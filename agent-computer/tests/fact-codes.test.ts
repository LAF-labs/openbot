import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { type AnswerCode, statusOf } from "../src/codes";
import { ControlError, HUMAN_HAS_CONTROL } from "../src/control";
import { actionFailure, fileFailure } from "../src/failures";
import { LabelChangedError } from "../src/label-hold";
import {
  ElementActionError,
  STALE_REFS,
  StaleSnapshotError,
} from "../src/refs";
import {
  browserFailed,
  fact,
  invalid,
  RequestInvalidError,
} from "../src/respond";
import { WorkspaceFileError, WorkspacePathError } from "../src/workspace";
import { PW_FIELDS, serveFixture } from "./fixture-site";

/**
 * EVERY FAILURE THIS CONTAINER ANSWERS WITH IS A FACT CODE.
 *
 * Until 2026-09-14 about thirty of them were sentences — "A url is required.", "The action failed.",
 * "Not authorised." — and every browser failure was Playwright's own message passed on as it was.
 * The server's client puts `error` into the error it throws, so all of it reached the audit trail, the
 * model and the Korean surface. And a Playwright message carries its call log, and the call log of a
 * `fill` carries the text being filled: `fill: Error: Element is not an <input> … - fill("…")`. A
 * failed `/human/secret` handed the person's secret straight back over HTTP.
 *
 * No exception any more: `page_timeout` kept Playwright's first line in `error` for the server's
 * client to match, until the client read `code`.
 */

type Body = Record<string, unknown>;
const CODE = /^laf:[a-z_]+$/;

const bodyOf = async (response: Response): Promise<Body> =>
  (await response.json()) as Body;

describe("a failure, as it is written", () => {
  test("carries its code in `error` and in `code`, and its facts beside them", async () => {
    const response = fact("laf:file_too_large", {
      bytes: 9,
      limit: 8,
    });
    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: "laf:file_too_large",
      code: "laf:file_too_large",
      bytes: 9,
      limit: 8,
    });
  });

  test("cannot have its code overwritten by a fact", async () => {
    const body = await bodyOf(
      fact("laf:stale_refs", { error: "a sentence", code: "laf:other" }),
    );
    expect([body.error, body.code]).toEqual([
      "laf:stale_refs",
      "laf:stale_refs",
    ]);
  });

  test("a page that never loaded is its code in both fields, like every other failure", async () => {
    // It kept Playwright's first line in `error` until 2026-09-14, for the server to match; the
    // status is the list's, and nothing a reader could match on is in the body.
    const response = fact("laf:page_timeout", { recycled: "page" });
    expect(response.status).toBe(504);
    expect(await bodyOf(response)).toEqual({
      error: "laf:page_timeout",
      code: "laf:page_timeout",
      recycled: "page",
    });
  });

  test("a browser failure is never Playwright's message, unless the message is this process's own code", async () => {
    const leaked = new Error(
      "fill: Error: Element is not an <input>, <textarea>, <select> or [contenteditable]\nCall log:\n  - waiting for locator('aria-ref=e4')\n    - fill(\"PERSON-TYPED-SECRET-7788\")\n",
    );
    const body = await bodyOf(browserFailed(leaked));
    expect(body).toEqual({
      error: "laf:browser_failed",
      code: "laf:browser_failed",
    });
    expect(
      (
        await bodyOf(
          browserFailed(new Error("laf:navigation_guard_unavailable")),
        )
      ).code,
    ).toBe("laf:navigation_guard_unavailable");
    expect((await bodyOf(browserFailed("not even an error"))).code).toBe(
      "laf:browser_failed",
    );
  });
});

describe("what each failure of an action is answered with", () => {
  const cases: [string, unknown, number, Body][] = [
    [
      "a missing part of the request",
      new RequestInvalidError("ref"),
      400,
      { field: "ref" },
    ],
    [
      "a stale ref",
      new StaleSnapshotError(STALE_REFS),
      409,
      { code: STALE_REFS, stale: true },
    ],
    [
      "a renamed control",
      new LabelChangedError(),
      409,
      { code: "laf:label_changed", stale: true },
    ],
    [
      "a person at the wheel",
      new ControlError(HUMAN_HAS_CONTROL),
      409,
      { code: HUMAN_HAS_CONTROL, humanHasControl: true },
    ],
    [
      "a path outside the workspace",
      new WorkspacePathError("../../etc/passwd is outside"),
      403,
      { code: "laf:file_path_refused" },
    ],
    [
      "a missing file",
      new WorkspaceFileError("There is no file at a.txt."),
      400,
      { code: "laf:file_not_found" },
    ],
    [
      "an element that would not take the action",
      new ElementActionError(new Error('fill: Error: … - fill("CARD-4242")')),
      409,
      { code: "laf:element_not_actionable", stale: true },
    ],
    [
      "anything else",
      new Error("Target page, context or browser has been closed"),
      502,
      { code: "laf:browser_failed" },
    ],
  ];

  for (const [name, error, status, expected] of cases) {
    test(name, async () => {
      const response = actionFailure(error);
      const body = await bodyOf(response);
      expect([name, response.status]).toEqual([name, status]);
      expect(body).toMatchObject(expected);
      expect(body.error).toBe(body.code);
      expect(String(body.code)).toMatch(CODE);
      // No message of any error reaches the body: not the page's, not Playwright's, not ours.
      expect(JSON.stringify(body)).not.toContain("CARD-4242");
      expect(JSON.stringify(body)).not.toContain("outside");
      expect(JSON.stringify(body)).not.toContain("Target page");
    });
  }

  test("a file failure keeps the numbers a Bot can act on", async () => {
    const tooLarge = await bodyOf(
      fileFailure(
        new WorkspaceFileError("That is 9 bytes.", "laf:file_too_large", {
          bytes: 9,
          limit: 8,
        }),
      ),
    );
    expect(tooLarge).toEqual({
      error: "laf:file_too_large",
      code: "laf:file_too_large",
      bytes: 9,
      limit: 8,
    });
    const other = fileFailure(new Error("EIO: i/o error, read"));
    expect(other.status).toBe(500);
    expect((await bodyOf(other)).code).toBe("laf:file_failed");
  });

  test("invalid names the part, and nothing else", async () => {
    expect(await bodyOf(invalid("url"))).toEqual({
      error: "laf:request_invalid",
      code: "laf:request_invalid",
      field: "url",
    });
  });
});

describe("the source", () => {
  const SRC = join(import.meta.dir, "../src");
  const files = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory()
        ? files(path)
        : name.endsWith(".ts")
          ? [path]
          : [];
    });
  const code = (path: string) =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  test("writes an HTTP answer in one module, so no route can answer with a sentence", () => {
    const writers = files(SRC).filter((path) =>
      code(path).includes("new Response("),
    );
    expect(writers.map((path) => path.slice(SRC.length + 1))).toEqual([
      "respond.ts",
    ]);
  });

  test("writes a live-screen error in one place, and only as a code", () => {
    const senders = files(SRC).filter((path) =>
      /type:\s*"error"/.test(code(path)),
    );
    expect(senders.map((path) => path.slice(SRC.length + 1))).toEqual([
      "live-screen.ts",
    ]);
    expect(code(join(SRC, "live-screen.ts"))).toContain(
      'JSON.stringify({ type: "error", code, error: code })',
    );
  });
});

/*
 * THE WHOLE PROCESS, OVER HTTP. None of the calls in the first block starts a browser, so they run
 * wherever this workspace's tests run; the second block needs Chromium and says so.
 */
const HAS_BROWSER = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const BOT = "fact-bot";
const TOKEN = "test-computer-token";
let base = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let fixture: ReturnType<typeof serveFixture> | null = null;
let profilesDir = "";
let workspaceDir = "";

async function freePort(): Promise<number> {
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  if (port === undefined) throw new Error("Bun.serve returned no port.");
  return port;
}

async function call(
  path: string,
  init: RequestInit & { token?: string; bot?: string | null } = {},
): Promise<{ status: number; body: Body; text: string }> {
  const bot = init.bot === undefined ? BOT : init.bot;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-openbot-computer-token": init.token ?? TOKEN,
      ...(bot ? { "x-openbot-bot-id": bot } : {}),
    },
  });
  const text = await response.text();
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body;
  } catch {}
  return { status: response.status, body, text };
}

const post = (
  path: string,
  payload: unknown,
  init: Parameters<typeof call>[1] = {},
) => call(path, { ...init, method: "POST", body: JSON.stringify(payload) });

beforeAll(async () => {
  fixture = serveFixture();
  profilesDir = await mkdtemp(join(tmpdir(), "laf-fact-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-fact-workspace-"));
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

describe("the computer's refusals, over HTTP", () => {
  test("every one of them is a code, with the status that says what to do next", async () => {
    const refusals: [
      string,
      Promise<{ status: number; body: Body }>,
      number,
      string,
    ][] = [
      [
        "wrong token",
        call("/read", { token: "not-the-token" }),
        401,
        "laf:computer_token_refused",
      ],
      [
        "no Bot named",
        call("/read", { bot: null }),
        400,
        "laf:bot_header_missing",
      ],
      [
        "a path for a Bot",
        call("/read", { bot: "../../tmp/x" }),
        400,
        "laf:bot_id_invalid",
      ],
      ["no such route", call("/nowhere"), 404, "laf:computer_route_unknown"],
      // The stream carries its token in the query: a browser cannot set a header on an upgrade.
      [
        "a stream without an upgrade",
        call(`/stream?token=${TOKEN}`),
        400,
        "laf:stream_upgrade_required",
      ],
      [
        "a navigation without an address",
        post("/navigate", {}),
        400,
        "laf:request_invalid",
      ],
      [
        "an action without a body",
        call("/click", { method: "POST", body: "not json" }),
        400,
        "laf:request_invalid",
      ],
      [
        "an upload without a ref",
        post("/upload", { path: "a.txt" }),
        400,
        "laf:request_invalid",
      ],
      [
        "a tab without an index",
        post("/tabs/switch", {}),
        400,
        "laf:request_invalid",
      ],
      [
        "a point without coordinates",
        post("/describe-point", {}),
        400,
        "laf:request_invalid",
      ],
      [
        "a secret request without a field",
        post("/control/secret", { label: "비밀번호" }),
        400,
        "laf:request_invalid",
      ],
      [
        "a secret nobody asked for",
        post("/human/secret", { text: "UNASKED-SECRET-3141" }),
        409,
        "laf:secret_not_pending",
      ],
      [
        "a person's click before taking the wheel",
        post("/human/click", { x: 1, y: 1 }),
        409,
        "laf:take_control_first",
      ],
      [
        "a file outside the workspace",
        post("/files/read", { path: "../../etc/passwd" }),
        403,
        "laf:file_path_refused",
      ],
      [
        "a file that is not there",
        post("/files/read", { path: "없는-파일.txt" }),
        400,
        "laf:file_not_found",
      ],
      [
        "a folder that is not there",
        post("/files/list", { path: "없는-폴더" }),
        400,
        "laf:file_not_found",
      ],
      [
        "a write without contents",
        post("/files/write", { path: "a.txt" }),
        400,
        "laf:request_invalid",
      ],
    ];
    for (const [name, pending, status, code] of refusals) {
      const { status: got, body } = await pending;
      expect([name, got, body.code, body.error]).toEqual([
        name,
        status,
        code,
        code,
      ]);
      // And the status is the one the list gives the code, which is where it is decided.
      expect([name, statusOf(code as AnswerCode)]).toEqual([name, status]);
    }
  }, 30_000);

  test("a write too big for the workspace says by how much, and in numbers", async () => {
    const refused = await post("/files/write", {
      path: "big.txt",
      contents: "가".repeat(400_000),
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      error: "laf:file_too_large",
      code: "laf:file_too_large",
      bytes: 1_200_000,
      limit: 1_000_000,
    });
  }, 30_000);

  test("the value of a secret nobody asked for is not in the refusal", async () => {
    const refused = await post("/human/secret", {
      text: "UNASKED-SECRET-3141",
    });
    expect(refused.text).not.toContain("UNASKED-SECRET-3141");
  }, 30_000);
});

describe.skipIf(!HAS_BROWSER)("a failure on the page, over HTTP", () => {
  const loginButton = async () => {
    const opened = await post("/navigate", { url: `${fixture?.url}pw` });
    expect(opened.status).toBe(200);
    const shot = await post("/snapshot", {});
    const elements = (shot.body.elements ?? []) as {
      ref: string;
      role: string;
      name: string;
    }[];
    const button = elements.find(
      (element) => element.role === "button" && element.name === "로그인",
    );
    if (!button) throw new Error("the /pw fixture has no 로그인 button");
    // Named here so a change to the fixture fails loudly rather than testing nothing.
    expect(elements.some((element) => element.name === PW_FIELDS.plain)).toBe(
      true,
    );
    return { ref: button.ref, snapshotId: shot.body.snapshotId as number };
  };

  test("typing into something that takes no text answers the fact, and not the text", async () => {
    const TYPED = "TYPED-INTO-A-BUTTON-5813";
    const { ref, snapshotId } = await loginButton();
    const typed = await post("/type", { ref, snapshotId, text: TYPED });
    // Measured before the change: 502, and `error` was Playwright's call log with `fill("TYPED-…")`.
    expect(typed.status).toBe(409);
    expect(typed.body.code).toBe("laf:element_not_actionable");
    expect(typed.text).not.toContain(TYPED);
    expect(typed.text).not.toContain("Call log");
  }, 60_000);

  test("a person's secret that could not be entered is not handed back, and the request is closed", async () => {
    const SECRET = "PERSON-TYPED-SECRET-2719";
    const { ref, snapshotId } = await loginButton();
    const asked = await post("/control/secret", {
      label: "로그인에 필요한 값",
      ref,
      snapshotId,
    });
    expect(asked.status).toBe(200);
    const supplied = await post("/human/secret", { text: SECRET });
    expect(supplied.status).toBe(409);
    expect(supplied.body.code).toBe("laf:element_not_actionable");
    expect(supplied.text).not.toContain(SECRET);
    expect(supplied.text).not.toContain("Call log");
    // Unretryable, so nothing is left waiting for a value that has nowhere to go.
    const control = await call("/control");
    expect(control.body.secretWanted).toBeUndefined();
  }, 60_000);
});
