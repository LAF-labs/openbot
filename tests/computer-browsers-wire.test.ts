import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  BACKGROUND_BROWSERS,
  createBrowsers,
} from "../agent-computer/src/browsers";
import type { Computer } from "../agent-computer/src/computer";
import type { StreamData } from "../agent-computer/src/live-screen";
import { computerFetch } from "../agent-computer/src/routes";
import { createSessions } from "../agent-computer/src/sessions";
import { createWorkspace } from "../agent-computer/src/workspace";
import type { AuditEventInput } from "../server/src/audit";
import { computerIdOf } from "../server/src/computer/bot-id";
import {
  createComputerClient,
  WorkspaceRequestError,
} from "../server/src/computer/client";
import { createComputerGateway } from "../server/src/computer/gateway";

/**
 * THE SERVER AND THE COMPUTER AGREE ON WHICH BROWSER (piece 5-3, both halves).
 *
 * Each side has its own tests against a fake of the other: the computer's against requests typed
 * by hand (`agent-computer/tests/browsers.test.ts`), the server's against a computer that only
 * records (`server/tests/computer-browsers.test.ts`). Both would stay green with the header
 * spelled two ways, or the answer to `open` read as a different shape. Here the server's own
 * client and gateway talk to the computer's own door over a socket, with the computer's own
 * count of places — and no Chromium, because the one route that needs none (`/files/list`) is
 * enough to tell which browser answered.
 */

const TOKEN = "browsers-wire-test-token";
const BOT = "bot-1";

let base: string;
let container: ReturnType<typeof Bun.serve>;
let gateway: ReturnType<typeof createComputerGateway>;
let client: ReturnType<typeof createComputerClient>;
/** The browsers the computer built a place for, by name; null is the main one. */
const built: (string | null)[] = [];
const rows: AuditEventInput[] = [];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "laf-browsers-wire-"));
  const workspace = join(base, "workspace");
  await mkdir(join(base, "tmp"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "kept");

  /** A place with real sessions and the real folder, and a browser that only counts. */
  const seat = (root: string, name: string | null): Computer => {
    built.push(name);
    return {
      config: { token: TOKEN },
      profiles: {
        follow: async () => undefined,
        liveBots: () => [],
        closeAll: async () => undefined,
      },
      workspace: createWorkspace(workspace),
      sessions: createSessions({
        stateDirectoryFor: (botId) => join(root, "state", botId),
      }),
    } as unknown as Computer;
  };
  const handle = computerFetch(
    createBrowsers({
      main: seat(join(base, "main"), null),
      seatAt: seat,
      under: join(base, "tmp"),
    }),
  );
  container = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, server) =>
      handle(request, server as unknown as Server<StreamData>),
  });
  client = createComputerClient({
    baseUrl: `http://127.0.0.1:${container.port}`,
    token: TOKEN,
    allowPrivateHosts: true,
  });
  gateway = createComputerGateway({
    client,
    auditStore: { insert: async (event) => void rows.push(event) },
    policy: () => ({ deny: [], ask: [], allow: ["true"] }),
  });
});

afterAll(async () => {
  await container.stop(true);
  await rm(base, { recursive: true, force: true });
});

const ACTOR = { id: "dev-local-user" };
const profiles = async () =>
  (await readdir(join(base, "tmp"))).filter((name) =>
    name.startsWith("laf-browser-"),
  );

describe("the server's client against the computer's door", () => {
  test("a call that names no browser is the main one's, and builds no other", async () => {
    const listed = await gateway.listFiles(BOT, BOT, ACTOR, {});
    expect(listed.entries.map((entry) => entry.path)).toContain("notes.md");
    expect(built).toEqual([null]);
  });

  test("a browser nobody opened is refused by the computer, in the words the server knows", async () => {
    await expect(
      gateway.listFiles(computerIdOf(BOT, "run-1"), BOT, ACTOR, {}),
    ).rejects.toThrow(WorkspaceRequestError);
    expect(built).toEqual([null]);
    expect(await profiles()).toEqual([]);
  });

  test("opened through the gateway, a call by that computer's id is answered by that browser", async () => {
    expect(await gateway.openBrowser(BOT, "run-1")).toEqual({
      opened: true,
      open: 1,
      cap: BACKGROUND_BROWSERS,
    });
    const listed = await gateway.listFiles(
      computerIdOf(BOT, "run-1"),
      BOT,
      ACTOR,
      {},
    );
    expect(listed.entries.map((entry) => entry.path)).toContain("notes.md");
    expect(built).toEqual([null, "run-1"]);
    expect(await profiles()).toHaveLength(1);
    // The row says which computer it was, under the same Bot.
    expect(rows.at(-1)).toMatchObject({
      targetId: "bot-1@run-1",
      payload: { bot: BOT },
    });
  });

  test("the computer's own count is what the server is told: room for so many, then no", async () => {
    for (let index = 2; index <= BACKGROUND_BROWSERS; index += 1) {
      expect((await gateway.openBrowser(BOT, `run-${index}`)).opened).toBe(
        true,
      );
    }
    expect(await gateway.openBrowser(BOT, "one-too-many")).toEqual({
      opened: false,
      open: BACKGROUND_BROWSERS,
      cap: BACKGROUND_BROWSERS,
    });
  });

  test("let go of through the gateway, the browser is gone on the computer and its name is nobody's", async () => {
    expect(await gateway.releaseBrowser(BOT, "run-1")).toEqual({
      released: true,
    });
    expect(await gateway.releaseBrowser(BOT, "run-1")).toEqual({
      released: false,
    });
    expect(await profiles()).toHaveLength(BACKGROUND_BROWSERS - 1);
    await expect(
      gateway.listFiles(computerIdOf(BOT, "run-1"), BOT, ACTOR, {}),
    ).rejects.toThrow(WorkspaceRequestError);
    // And there is room again.
    expect((await gateway.openBrowser(BOT, "one-too-many")).opened).toBe(true);
  });

  test("a name that is not one never leaves the server", async () => {
    const before = built.length;
    await expect(
      client.forBot(BOT, "../profiles").openBrowser(),
    ).rejects.toThrow("laf:bot_id_invalid");
    expect(built).toHaveLength(before);
  });
});
