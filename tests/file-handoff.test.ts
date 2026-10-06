import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { Computer } from "../agent-computer/src/computer";
import type { StreamData } from "../agent-computer/src/live-screen";
import { computerFetch } from "../agent-computer/src/routes";
import { createSessions } from "../agent-computer/src/sessions";
import { createWorkspace } from "../agent-computer/src/workspace";
import type { AuditEventInput } from "../server/src/audit";
import { createApprovalRegistry } from "../server/src/computer/approvals";
import { createComputerClient } from "../server/src/computer/client";
import { createComputerGateway } from "../server/src/computer/gateway";
import { createPolicyStore } from "../server/src/computer/policy-store";
import { createComputerRoutes } from "../server/src/computer/routes";
import { createChatTools } from "../server/src/turns/chat-tools";
import { createPersonAnswers } from "../server/src/turns/people";
import { toolResultText } from "../shared/prompt/tool-results.ko";

/**
 * A FILE, FROM THE BOT'S FOLDER TO THE PERSON'S HANDS, WITH NOTHING FAKED IN BETWEEN (phase 8, first
 * slice, 2026-10-02).
 *
 * Each half has its own tests, and each of those fakes the other half: the server's routes run
 * over a folder in memory that refuses the way the container does, and the container's routes are
 * asked by a hand-written request. That is how two halves come to agree with their tests and not
 * with each other — the contract test for the fact codes exists for exactly that reason, and it
 * says nothing about a route whose answer is bytes.
 *
 * So here the server's real client speaks to the container's real routes over a real socket, with a
 * real folder on disk: the token and the Bot header at the container's door, the path through the
 * workspace's confinement, the bytes back through the client's bounded read, the row, the headers.
 * No browser — neither route opens one — which is the one part of the computer stood in for.
 *
 * At the root because it belongs to neither workspace: it is about the wire between them.
 */

const TOKEN = "handoff-e2e-token";
const OWNER = {
  id: "owner-user",
  email: "owner@laf.test",
  role: "user",
} as const;

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);
/** Every byte value: what a JSON reading of the answer would have destroyed. */
const BINARY = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);
const SHEET = "날짜,매출\n2026-09-30,128000\n";

let base: string;
let root: string;
let container: ReturnType<typeof Bun.serve>;
/** The server's own routes, asked as the app asks them. Hono is the server's, not this suite's. */
let app: ReturnType<typeof createComputerRoutes>;
let gateway: ReturnType<typeof createComputerGateway>;
/** The server's real client, for the two calls that are the server's own and no route's. */
let computerClient: ReturnType<typeof createComputerClient>;
const rows: AuditEventInput[] = [];
/** What reached the container's door, so a test can say what did NOT. */
const reached: string[] = [];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "laf-handoff-e2e-"));
  root = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "a private key");

  const workspace = createWorkspace(root);
  // The Bot's own way of making a file, and the runtime's own filing of a long result.
  await workspace.write("보고서/9월 정산내역 (2).csv", SHEET);
  await workspace.write(".results/call_1.txt", "a long tool result");
  await writeFile(join(root, "chart.png"), PNG);
  await writeFile(join(root, "data.bin"), BINARY);
  await writeFile(join(root, "page.html"), "<script>steal()</script>");
  await writeFile(join(root, "disguised.png"), "<script>steal()</script>");
  await writeFile(join(root, "huge.bin"), Buffer.alloc(5_000_001, 1));
  await symlink(join(outside, "secret.txt"), join(root, "innocent.txt"));

  const computer = {
    config: { token: TOKEN },
    profiles: { follow: async () => undefined },
    workspace,
    sessions: createSessions({
      stateDirectoryFor: (botId) => join(base, "state", botId),
    }),
  } as unknown as Computer;
  const handle = computerFetch(computer);
  container = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, server) => {
      reached.push(`${request.method} ${new URL(request.url).pathname}`);
      return handle(request, server as unknown as Server<StreamData>);
    },
  });

  const client = createComputerClient({
    baseUrl: `http://127.0.0.1:${container.port}`,
    token: TOKEN,
    allowPrivateHosts: true,
  });
  computerClient = client;
  const policy = { deny: [], ask: [], allow: ["true"] };
  gateway = createComputerGateway({
    client,
    auditStore: {
      insert: async (event) => {
        rows.push(event);
      },
    },
    policy: () => policy,
    approvals: createApprovalRegistry(),
  });
  // The session guard as `createRequireUser` ships it: the actor, and whose Bots they may drive.
  const requireUser: Parameters<typeof createComputerRoutes>[3] = async (
    context,
    next,
  ) => {
    context.set("actor", OWNER);
    context.set("mayDriveBot", async (botId) => botId === "bot-1");
    await next();
  };
  app = createComputerRoutes(
    client,
    gateway,
    createPolicyStore(policy),
    requireUser,
  );
});

afterAll(async () => {
  await container.stop(true);
  await rm(base, { recursive: true, force: true });
});

const download = (path: string, inline = false) =>
  app.request(
    `/bot-1/files/download?path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}`,
  );

const refusalOf = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

describe("a file the Bot wrote, downloaded by the person it wrote it for", () => {
  test("arrives byte for byte under its Korean name, as an attachment that can run nothing", async () => {
    rows.length = 0;

    const response = await download("보고서/9월 정산내역 (2).csv");

    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/csv",
      "content-length": String(Buffer.byteLength(SHEET)),
      "content-disposition":
        "attachment; filename*=UTF-8''9%EC%9B%94%20%EC%A0%95%EC%82%B0%EB%82%B4%EC%97%AD%20%282%29.csv",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    });
    expect(await response.text()).toBe(SHEET);
    expect(rows).toEqual([
      {
        eventType: "computer.file_downloaded",
        targetType: "computer",
        targetId: "bot-1",
        actorUserId: "owner-user",
        payload: {
          bot: "bot-1",
          actor: "owner-user",
          file: "보고서/9월 정산내역 (2).csv",
          bytes: Buffer.byteLength(SHEET),
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("128000");
  });

  test("bytes that are not text come through as they are", async () => {
    const response = await download("data.bin");
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BINARY);
  });

  test("a picture is drawn only when asked and only when it is one; a page called a picture is saved", async () => {
    rows.length = 0;

    const drawn = await download("chart.png", true);
    expect(drawn.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''chart.png",
    );
    expect(drawn.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await drawn.arrayBuffer())).toEqual(PNG);
    // Drawn in the card, not taken away: no row.
    expect(rows).toEqual([]);

    for (const path of ["disguised.png", "page.html"]) {
      const saved = await download(path, true);
      expect([path, saved.headers.get("content-disposition")]).toEqual([
        path,
        `attachment; filename*=UTF-8''${path}`,
      ]);
      expect(saved.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'",
      );
    }
    // Asked for as previews and not pictures: downloads, and recorded as downloads.
    expect(rows.map((row) => [row.eventType, row.payload.file])).toEqual([
      ["computer.file_downloaded", "disguised.png"],
      ["computer.file_downloaded", "page.html"],
    ]);
  });
});

describe("a file that does not leave", () => {
  test("a path out of the folder, by `..`, by an absolute path and through a link", async () => {
    rows.length = 0;
    for (const path of [
      "../outside/secret.txt",
      "보고서/../../outside/secret.txt",
      "/etc/passwd",
      "innocent.txt",
    ]) {
      for (const door of ["info", "download"]) {
        const response = await app.request(
          `/bot-1/files/${door}?path=${encodeURIComponent(path)}`,
        );
        const refused = await refusalOf(response);
        expect({ door, path, ...refused }).toEqual({
          door,
          path,
          status: 403,
          body: {
            error: "laf:file_path_refused",
            code: "laf:file_path_refused",
          },
        });
        expect(JSON.stringify(refused.body)).not.toContain("a private key");
      }
    }
    expect(rows).toEqual([]);
  });

  test("gone is a 404, a folder the wrong kind, and five megabytes and a byte too large", async () => {
    expect(await refusalOf(await download("없는 파일.csv"))).toEqual({
      status: 404,
      body: { error: "laf:file_not_found", code: "laf:file_not_found" },
    });
    expect(await refusalOf(await download("보고서"))).toEqual({
      status: 400,
      body: { error: "laf:file_wrong_kind", code: "laf:file_wrong_kind" },
    });
    expect(await refusalOf(await download("huge.bin"))).toEqual({
      status: 400,
      body: { error: "laf:file_too_large", code: "laf:file_too_large" },
    });
    // Its facts are still told, so the card can say how big the file it draws no button under is.
    const facts = await app.request("/bot-1/files/info?path=huge.bin");
    expect(await facts.json()).toEqual({
      path: "huge.bin",
      kind: "file",
      bytes: 5_000_001,
    });
  });

  test("somebody else's Bot never reaches the container", async () => {
    reached.length = 0;
    for (const path of [
      "/bot-2/files",
      "/bot-2/files/info?path=chart.png",
      "/bot-2/files/download?path=chart.png",
    ]) {
      expect((await refusalOf(await app.request(path))).body.code).toBe(
        "laf:bot_not_found",
      );
    }
    expect(reached).toEqual([]);
  });

  test("a server that does not hold the container's token is refused at its door", async () => {
    const stranger = createComputerClient({
      baseUrl: `http://127.0.0.1:${container.port}`,
      token: "not-the-token",
      allowPrivateHosts: true,
    });
    const failure = await stranger
      .forBot("bot-1")
      .downloadFile("chart.png")
      .then(
        () => null,
        (error: Error) => error.message,
      );
    expect(failure).toBe("laf:computer_token_refused");
  });
});

describe("what the person is shown of the folder", () => {
  test("one file's facts, and the listing without the runtime's own filing", async () => {
    const facts = await app.request(
      `/bot-1/files/info?path=${encodeURIComponent("보고서/9월 정산내역 (2).csv")}`,
    );
    expect(await facts.json()).toEqual({
      path: "보고서/9월 정산내역 (2).csv",
      kind: "file",
      bytes: Buffer.byteLength(SHEET),
    });

    const listing = (await (await app.request("/bot-1/files")).json()) as {
      entries: Array<{ path: string; kind: string }>;
      truncated: boolean;
    };
    const paths = listing.entries.map((entry) => entry.path).sort();
    expect(paths).toContain("보고서/9월 정산내역 (2).csv");
    expect(paths).toContain("chart.png");
    expect(paths.filter((path) => path.startsWith("."))).toEqual([]);
    expect(listing.truncated).toBe(false);
  });
});

describe("the Bot's file card, against the real folder", () => {
  const owner = { id: OWNER.id, role: "user" } as const;
  const call = { id: "call-1", signal: new AbortController().signal };
  const fileCard = { name: "showFile", description: "", parameters: {} };

  const toolkit = () =>
    createChatTools({
      gateway,
      people: createPersonAnswers(),
      components: {
        listForAgent: async () => [
          { name: "showFile", title: "File", kind: "card", description: "d" },
        ],
        decide: async () => ({ allowed: true as const, description: "d" }),
        mayCall: async () => true,
      },
    })({ botId: "bot-1", owner, threadId: "thread-1", runId: "run-1" }, [
      fileCard,
    ]);

  test("is confirmed for a file that is there, and no row says the Bot read it", async () => {
    rows.length = 0;
    const tools = await toolkit();

    expect(
      await tools.execute(
        "showFile",
        { path: "보고서/9월 정산내역 (2).csv" },
        call,
      ),
    ).toContain("The file card is on screen");
    // The runtime looked; the Bot did not read, and the person has not taken anything yet.
    expect(rows).toEqual([]);
  });

  test("is refused, in the computer's own words, for one that is not", async () => {
    const tools = await toolkit();

    expect(
      await tools.execute("showFile", { path: "없는 파일.csv" }, call),
    ).toEqual({
      ok: false,
      code: "laf:file_not_found",
      reason: toolResultText("laf:file_not_found"),
    });
    expect(
      await tools.execute("showFile", { path: "보고서" }, call),
    ).toMatchObject({ ok: false, code: "laf:file_wrong_kind" });
    expect(
      await tools.execute("showFile", { path: "innocent.txt" }, call),
    ).toMatchObject({ ok: false, code: "laf:file_path_refused" });
  });
});

/*
 * THE SERVER'S OWN TWO CALLS, ACROSS THE SAME REAL WIRE (2026-10-06). A file taken whole and bytes
 * put where nothing is have no route of the server's in front of them and no Bot tool behind them
 * yet: what there is to hold is the wire itself — the path in a header on the way in, the body as
 * bytes both ways, the container's confinement and its refusal to replace, and each fact arriving
 * in the client as the container said it.
 */
describe("the server's own file calls, against the real folder", () => {
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected the call to fail");
      },
      (error: Error) => error,
    );

  test("bytes put under a Korean path land as they were sent, and are taken whole again", async () => {
    reached.length = 0;
    const path = "made/2026-10-06-1a2b3c4d/요일별 매출.xlsx";
    const bot = computerClient.forBot("bot-1");

    expect(await bot.putFile(path, BINARY)).toEqual({
      path,
      kind: "file",
      bytes: BINARY.byteLength,
    });
    expect(new Uint8Array(await readFile(join(root, path)))).toEqual(BINARY);
    expect(await bot.fileBytes(path)).toEqual(BINARY);
    expect(reached).toEqual(["POST /files/put", "POST /files/bytes"]);
  });

  test("a put never replaces: a taken path is refused as that, and the first file is as it was", async () => {
    const bot = computerClient.forBot("bot-1");
    await bot.putFile("made/once.bin", BINARY);

    const again = await failureOf(
      bot.putFile("made/once.bin", new Uint8Array([9, 9, 9])),
    );
    expect([again.name, again.message]).toEqual([
      "WorkspaceRequestError",
      "laf:file_exists",
    ]);
    expect(await bot.fileBytes("made/once.bin")).toEqual(BINARY);

    // A file the person's Bot already had, and a link that leads out of the folder.
    for (const taken of ["보고서/9월 정산내역 (2).csv", "innocent.txt"]) {
      expect(
        (await failureOf(bot.putFile(taken, new Uint8Array([9])))).message,
      ).toBe("laf:file_exists");
    }
    expect(
      await readFile(join(root, "보고서/9월 정산내역 (2).csv"), "utf8"),
    ).toBe(SHEET);
    expect(await readFile(join(base, "outside/secret.txt"), "utf8")).toBe(
      "a private key",
    );
  });

  test("a file too large for a person's download is still taken whole by the server", async () => {
    // Five megabytes and a byte: the download door's own refusal is held above.
    const whole = await computerClient.forBot("bot-1").fileBytes("huge.bin");
    expect(whole.byteLength).toBe(5_000_001);
    expect(whole[5_000_000]).toBe(1);
  });

  test("neither leaves the folder, and neither is answered without the Bot being named", async () => {
    const bot = computerClient.forBot("bot-1");
    for (const path of ["../outside/owned.bin", "/tmp/owned.bin"]) {
      expect((await failureOf(bot.putFile(path, BINARY))).message).toBe(
        "laf:file_path_refused",
      );
      expect((await failureOf(bot.fileBytes(path))).message).toBe(
        "laf:file_path_refused",
      );
    }
    expect((await failureOf(bot.fileBytes("innocent.txt"))).message).toBe(
      "laf:file_path_refused",
    );
    expect(await readdir(join(base, "outside"))).toEqual(["secret.txt"]);

    // The client as nobody in particular: the container asks which Bot, and gets no answer.
    expect(
      (await failureOf(computerClient.fileBytes("chart.png"))).message,
    ).toBe("laf:bot_header_missing");
    expect(
      (await failureOf(computerClient.putFile("made/nobody.bin", BINARY)))
        .message,
    ).toBe("laf:bot_header_missing");
  });
});
