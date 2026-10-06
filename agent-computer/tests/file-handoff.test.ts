import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { FILE_PATH_HEADER } from "../../shared/workspace-files";
import type { Computer } from "../src/computer";
import type { StreamData } from "../src/live-screen";
import { computerFetch } from "../src/routes";
import { createSessions } from "../src/sessions";
import { digestOf, keepTyped } from "../src/typed-values";
import { createWorkspace } from "../src/workspace";

/**
 * A FILE ON ITS WAY TO THE PERSON, AS THE SERVER ASKS FOR IT (phase 8, 2026-10-02).
 *
 * `workspace.test.ts` holds the confinement to a real filesystem. This holds what is on the wire:
 * the routes behind this container's real door — its token, its Bot header, its table — with a
 * real folder underneath. `/files/download` was the one route here whose answer is not JSON, so the
 * thing most worth pinning is that the bytes arrive as they are on disk: every other answer passes
 * a filter on its way out that parses and rewrites it (`withoutTypedAddresses`).
 *
 * AND THE SERVER'S OWN TWO (2026-10-06): `/files/bytes`, the same answer under another bound, and
 * `/files/put`, the one route whose REQUEST is not JSON — the body is the file and the path is in
 * a header.
 *
 * No browser: neither route opens one, so the only part of the computer faked below is the part
 * that would start Chromium.
 */

const TOKEN = "file-handoff-test-token";
const BOT = "bot-1";

let base: string;
let root: string;
let outside: string;
let ask: (request: Request) => Promise<Response>;
let sessions: ReturnType<typeof createSessions>;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "laf-file-handoff-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "a private key", "utf8");

  sessions = createSessions({
    stateDirectoryFor: (botId) => join(base, "state", botId),
  });
  const computer = {
    config: { token: TOKEN },
    // Where the person is, told on every call: nothing to follow, and no browser to tell.
    profiles: { follow: async () => undefined },
    workspace: createWorkspace(root, {
      readBytes: 64_000,
      writeBytes: 1_000_000,
      listEntries: 500,
      downloadBytes: 64,
      wholeBytes: 128,
      putBytes: 64,
    }),
    sessions,
  } as unknown as Computer;
  const handle = computerFetch(computer);
  // Only `/stream` touches the server, to upgrade a socket; no call here is one.
  ask = (request) => handle(request, {} as Server<StreamData>);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {
    "x-openbot-computer-token": TOKEN,
    "x-openbot-bot-id": BOT,
  },
) {
  return ask(
    new Request(`http://computer${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

const refusalOf = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

describe("a file's bytes, over the wire", () => {
  /** Every byte value, a NUL and invalid UTF-8 among them. */
  const BINARY = Uint8Array.from({ length: 64 }, (_, index) => index * 4);

  test("arrive exactly as they are on disk, named as nothing", async () => {
    await writeFile(join(root, "chart.png"), BINARY);

    const response = await post("/files/download", { path: "chart.png" });

    expect(response.status).toBe(200);
    // What it is called is the server's to decide, from its own table; this says only "bytes".
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-length")).toBe("64");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BINARY);
  });

  test("a Korean name in the request reaches the Korean file", async () => {
    await mkdir(join(root, "보고서"), { recursive: true });
    await writeFile(join(root, "보고서/9월 정산내역 (2).csv"), "합계,12000\n");

    const response = await post("/files/download", {
      path: "보고서/9월 정산내역 (2).csv",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("합계,12000\n");
  });

  test("are not rewritten by the filter that blanks what a person typed", async () => {
    /*
     * Once a person has typed into this Bot's browser, every JSON answer is parsed and its
     * addresses blanked of that value on the way out. A file is not an answer about a page: one
     * that holds an address carrying the very thing they typed leaves exactly as it is.
     */
    const typed = "SEC-GETFORM-7788";
    keepTyped(sessions.sessionFor(BOT), digestOf(typed));
    const contents = JSON.stringify({
      url: `https://shop.example/landed?pin=${typed}`,
    });
    await writeFile(join(root, "saved.json"), contents);

    const response = await post("/files/download", { path: "saved.json" });

    expect(await response.text()).toBe(contents);
  });

  test("its facts are a file, its size, and none of what it holds", async () => {
    await writeFile(join(root, "notes.md"), "# 메모\n");

    const response = await post("/files/stat", { path: "notes.md" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "notes.md",
      kind: "file",
      bytes: Buffer.byteLength("# 메모\n"),
    });
  });
});

describe("a file that is not handed over", () => {
  for (const route of ["/files/stat", "/files/download", "/files/bytes"]) {
    test(`${route} refuses a path outside the folder, and one that leaves through a link`, async () => {
      await symlink(join(outside, "secret.txt"), join(root, "innocent.txt"));
      for (const path of [
        "../outside/secret.txt",
        "reports/../../outside/secret.txt",
        "/etc/passwd",
        "..\\outside\\secret.txt",
        "innocent.txt",
      ]) {
        const refused = await refusalOf(await post(route, { path }));
        expect({ path, ...refused }).toEqual({
          path,
          status: 403,
          body: {
            error: "laf:file_path_refused",
            code: "laf:file_path_refused",
          },
        });
        // And what it refused is not in the refusal either.
        expect(JSON.stringify(refused.body)).not.toContain("a private key");
      }
    });

    test(`${route} says a folder is the wrong kind and an empty place is not found`, async () => {
      await mkdir(join(root, "reports"), { recursive: true });

      expect(await refusalOf(await post(route, { path: "reports" }))).toEqual({
        status: 400,
        body: { error: "laf:file_wrong_kind", code: "laf:file_wrong_kind" },
      });
      expect(await refusalOf(await post(route, { path: "nope.txt" }))).toEqual({
        status: 400,
        body: { error: "laf:file_not_found", code: "laf:file_not_found" },
      });
    });

    test(`${route} needs a path`, async () => {
      for (const body of [{}, { path: "" }, { path: "   " }, { path: 7 }]) {
        expect(await refusalOf(await post(route, body))).toEqual({
          status: 400,
          body: {
            error: "laf:request_invalid",
            code: "laf:request_invalid",
            field: "path",
          },
        });
      }
    });

    test(`${route} is behind the door every other route is`, async () => {
      await writeFile(join(root, "notes.md"), "x");

      const noToken = await refusalOf(
        await post(route, { path: "notes.md" }, { "x-openbot-bot-id": BOT }),
      );
      expect([noToken.status, noToken.body.code]).toEqual([
        401,
        "laf:computer_token_refused",
      ]);

      const noBot = await refusalOf(
        await post(
          route,
          { path: "notes.md" },
          { "x-openbot-computer-token": TOKEN },
        ),
      );
      expect([noBot.status, noBot.body.code]).toEqual([
        400,
        "laf:bot_header_missing",
      ]);
    });
  }

  test("more than a download hands over is refused with both numbers, and its facts are still told", async () => {
    await writeFile(join(root, "over.bin"), Buffer.alloc(65, 1));

    expect(
      await refusalOf(await post("/files/download", { path: "over.bin" })),
    ).toEqual({
      status: 400,
      body: {
        error: "laf:file_too_large",
        code: "laf:file_too_large",
        bytes: 65,
        limit: 64,
      },
    });
    // The card still learns how big the file is that it will draw no button under.
    const facts = await post("/files/stat", { path: "over.bin" });
    expect(await facts.json()).toMatchObject({ kind: "file", bytes: 65 });
  });

  test("a download is asked for with POST, like every file call", async () => {
    await writeFile(join(root, "notes.md"), "x");
    const response = await ask(
      new Request("http://computer/files/download?path=notes.md", {
        headers: {
          "x-openbot-computer-token": TOKEN,
          "x-openbot-bot-id": BOT,
        },
      }),
    );
    expect([response.status, (await response.json()).code]).toEqual([
      404,
      "laf:computer_route_unknown",
    ]);
  });
});

describe("a file taken whole, over the wire", () => {
  test("arrives exactly as it is on disk, named as nothing, where a download would not hand it over", async () => {
    // Over the fixture's download bound and inside its whole one.
    const sheet = Uint8Array.from({ length: 100 }, (_, index) => index * 2);
    await writeFile(join(root, "sheet.xlsx"), sheet);

    expect(
      (await refusalOf(await post("/files/download", { path: "sheet.xlsx" })))
        .body,
    ).toMatchObject({ code: "laf:file_too_large", bytes: 100, limit: 64 });

    const response = await post("/files/bytes", { path: "sheet.xlsx" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(sheet);
  });

  test("more than the server may hold is refused with both numbers", async () => {
    await writeFile(join(root, "over.bin"), Buffer.alloc(129, 1));
    expect(
      await refusalOf(await post("/files/bytes", { path: "over.bin" })),
    ).toEqual({
      status: 400,
      body: {
        error: "laf:file_too_large",
        code: "laf:file_too_large",
        bytes: 129,
        limit: 128,
      },
    });
  });

  test("is not rewritten by the filter that blanks what a person typed", async () => {
    const typed = "SEC-GETFORM-7788";
    keepTyped(sessions.sessionFor(BOT), digestOf(typed));
    const contents = JSON.stringify({
      url: `https://shop.example/landed?pin=${typed}`,
    });
    await writeFile(join(root, "saved.json"), contents);

    const response = await post("/files/bytes", { path: "saved.json" });

    expect(await response.text()).toBe(contents);
  });
});

describe("bytes put where nothing is, over the wire", () => {
  /** Every byte value a JSON body would have had to escape or lose. */
  const BINARY = Uint8Array.from({ length: 64 }, (_, index) => index * 4);
  const DOOR = {
    "x-openbot-computer-token": TOKEN,
    "x-openbot-bot-id": BOT,
  };

  /** A put as the server sends one: the file as the body, its path percent-encoded in a header. */
  function put(
    path: string | null,
    body: BodyInit | null,
    headers: Record<string, string> = DOOR,
  ) {
    return ask(
      new Request("http://computer/files/put", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          ...(path === null ? {} : { [FILE_PATH_HEADER]: path }),
          ...headers,
        },
        body,
      }),
    );
  }

  test("the body is the file and the header its path: a Korean name, bytes as they were sent, facts back", async () => {
    const path = "made/2026-10-06-1a2b3c4d/요일별 매출.xlsx";

    const response = await put(encodeURIComponent(path), BINARY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path, kind: "file", bytes: 64 });
    expect(new Uint8Array(await readFile(join(root, path)))).toEqual(BINARY);
    // And taken whole again, it is what was put.
    const back = await post("/files/bytes", { path });
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(BINARY);
  });

  test("a path that is taken is refused as that, and what is there is as it was", async () => {
    await writeFile(join(root, "notes.md"), "# 메모\n");

    expect(await refusalOf(await put("notes.md", BINARY))).toEqual({
      status: 400,
      body: { error: "laf:file_exists", code: "laf:file_exists" },
    });
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("# 메모\n");
  });

  test("more than a put takes is refused with both numbers, declared or not, and nothing is left", async () => {
    // A body of known length says so itself, and is refused by what it said.
    expect(await refusalOf(await put("over.bin", Buffer.alloc(65, 1)))).toEqual(
      {
        status: 400,
        body: {
          error: "laf:file_too_large",
          code: "laf:file_too_large",
          bytes: 65,
          limit: 64,
        },
      },
    );
    // A stream says nothing about its length, and is stopped where it passes the bound.
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(40));
        controller.close();
      },
    });
    const refused = await refusalOf(await put("over.bin", streamed));
    expect([refused.status, refused.body.code, refused.body.limit]).toEqual([
      400,
      "laf:file_too_large",
      64,
    ]);
    expect(refused.body.bytes as number).toBeGreaterThan(64);
    expect(await readdir(root)).toEqual([]);
  });

  test("needs a path, in its header, that is an encoding of something", async () => {
    for (const path of [null, "", "%20%20", "%E0%A4%A"]) {
      expect({ path, ...(await refusalOf(await put(path, BINARY))) }).toEqual({
        path,
        status: 400,
        body: {
          error: "laf:request_invalid",
          code: "laf:request_invalid",
          field: "path",
        },
      });
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("refuses a path outside the folder, and one that leaves through a link", async () => {
    await symlink(outside, join(root, "escape"));
    for (const path of [
      "../outside/owned.bin",
      "made/../../outside/owned.bin",
      "/tmp/owned.bin",
      "..\\outside\\owned.bin",
      "escape/owned.bin",
    ]) {
      expect({
        path,
        ...(await refusalOf(await put(encodeURIComponent(path), BINARY))),
      }).toEqual({
        path,
        status: 403,
        body: {
          error: "laf:file_path_refused",
          code: "laf:file_path_refused",
        },
      });
    }
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  test("is behind the door every other route is", async () => {
    const noToken = await refusalOf(
      await put("notes.md", BINARY, { "x-openbot-bot-id": BOT }),
    );
    expect([noToken.status, noToken.body.code]).toEqual([
      401,
      "laf:computer_token_refused",
    ]);
    const noBot = await refusalOf(
      await put("notes.md", BINARY, { "x-openbot-computer-token": TOKEN }),
    );
    expect([noBot.status, noBot.body.code]).toEqual([
      400,
      "laf:bot_header_missing",
    ]);
    expect(await readdir(root)).toEqual([]);
  });
});
