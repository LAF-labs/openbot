import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createComputerClient } from "../src/computer/client";
import { DEFAULT_ACTION_POLICY } from "../src/computer/default-policy";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";

/**
 * THE WHOLE MODEL-BOUND PAYLOAD, ON THE AUDITOR'S PAGE, THROUGH BOTH PROCESSES.
 *
 * A3 §S1 (2026-09-10): on `<input type=password aria-labelledby="패스워드">`, a value a person typed
 * through `computer_request_secret` came back on the very next `computer_snapshot` — measured in
 * the published `:stable` container and in main. The unit tests on either side each see half of
 * the path; the leak lived in the join between them. So this drives the real `agent-computer`
 * process in a real browser through this server's own client and gateway — what the tool route and
 * the unattended runner both hand a model is `gateway.snapshot()` / `gateway.read()` verbatim — and
 * serialises every answer whole. The auditor's page, byte for byte in the part that mattered.
 *
 * Skipped where Playwright has no browser downloaded (asked of the computer's own workspace, which
 * is the one that depends on it); CI installs one before the gate.
 */

const COMPUTER = resolve(import.meta.dir, "../../agent-computer");
const HAS_BROWSER =
  Bun.spawnSync(
    [
      "bun",
      "-e",
      'import { existsSync } from "node:fs"; import { chromium } from "playwright"; process.exit(existsSync(chromium.executablePath()) ? 0 : 1);',
    ],
    { cwd: COMPUTER, stdout: "ignore", stderr: "ignore" },
  ).exitCode === 0;

const TOKEN = "secret-payload-token";
const BOT = "secret-payload-bot";
const SECRET = "PERSON-TYPED-SECRET-7788";
const ACTOR = { id: "dev-local-user" };

const AUDITOR_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>로그인</title></head>
<body>
  <form>
    <label for="uid">아이디</label><input id="uid" type="text">
    <span id="패스워드">패스워드</span>
    <input type="password" aria-labelledby="패스워드">
    <button type="button">로그인</button>
  </form>
</body></html>`;

let site: ReturnType<typeof Bun.serve> | null = null;
let computer: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let profilesDir = "";
let workspaceDir = "";

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  site = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(AUDITOR_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  profilesDir = await mkdtemp(join(tmpdir(), "laf-secret-profiles-"));
  workspaceDir = await mkdtemp(join(tmpdir(), "laf-secret-workspace-"));
  const held = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = held.port;
  await held.stop(true);
  base = `http://127.0.0.1:${port}`;
  computer = Bun.spawn(["bun", "src/index.ts"], {
    cwd: COMPUTER,
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      PORT: String(port),
      PROFILES_DIR: profilesDir,
      WORKSPACE_DIR: workspaceDir,
      // The fixture is served on 127.0.0.1, which the navigation guard refuses without this — the
      // same opt-in a laptop deployment sets to browse its own services (navigation-guard.ts).
      AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await fetch(`${base}/health`).catch(() => null))?.ok) return;
    await Bun.sleep(100);
  }
  throw new Error("the computer did not start");
});

afterAll(async () => {
  computer?.kill();
  await computer?.exited;
  site?.stop(true);
  if (profilesDir) await rm(profilesDir, { recursive: true, force: true });
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_BROWSER)("a secret typed through the request", () => {
  test("is nowhere in the next snapshot or read the Bot is handed, nor in the trail", async () => {
    const rows: AuditEventInput[] = [];
    const auditStore: AuditStore = {
      insert: async (event) => void rows.push(event),
    };
    const gateway = createComputerGateway({
      client: createComputerClient({
        baseUrl: base,
        token: TOKEN,
        // The auditor's page is served from this machine.
        allowPrivateHosts: true,
      }),
      auditStore,
      // The policy a deployment ships with, not a permissive stand-in.
      policy: () => DEFAULT_ACTION_POLICY,
    });

    await gateway.navigate(BOT, BOT, ACTOR, `http://127.0.0.1:${site?.port}/`);
    const before = await gateway.snapshot(BOT);
    const box = before.elements.find((element) => element.name === "패스워드");
    expect(box).toBeDefined();

    await gateway.requestSecret(BOT, BOT, ACTOR, {
      label: "비밀번호",
      ref: box?.ref as string,
      snapshotId: before.snapshotId,
    });
    await gateway.supplySecret(BOT, BOT, ACTOR, SECRET);

    // What a tool route answers and what the unattended runner returns, serialised whole.
    const after = await gateway.snapshot(BOT);
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(await gateway.read(BOT))).not.toContain(SECRET);
    // And again, because the promise is every later snapshot, not the next one.
    expect(JSON.stringify(await gateway.snapshot(BOT))).not.toContain(SECRET);
    expect(JSON.stringify(rows)).not.toContain(SECRET);

    // The box is still there to press 로그인 beside, empty and marked — and the mark is what the
    // shipped deny rule refuses a Bot's own typing on.
    expect(
      after.elements.find((element) => element.ref === box?.ref),
    ).toMatchObject({ type: "password", value: "" });
    await expect(
      gateway.type(BOT, BOT, ACTOR, {
        ref: box?.ref as string,
        text: "guess",
        snapshotId: after.snapshotId,
      }),
    ).rejects.toThrow(ActionRefusedError);
  }, 60_000);
});
