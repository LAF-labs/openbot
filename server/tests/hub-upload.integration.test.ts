import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { MAIN_SCOPE } from "../../shared/file-scope";
import {
  ComputerUnavailableError,
  FILE_NOT_FOUND,
  WorkspaceRequestError,
} from "../src/computer/client";
import { createDatabase } from "../src/db/client";
import { hubOutbox } from "../src/db/schema";
import type { HubAnswer, HubHttp, HubUploadRequest } from "../src/hub/http";
import { createHubOutbox, type HubOutbox } from "../src/hub/outbox";
import { createHubToolTransport } from "../src/hub/tools";
import {
  createHubUploads,
  HUB_UPLOAD_CHANGED,
  type HubUploads,
} from "../src/hub/upload";
import { PluginRefusedError } from "../src/plugins/store";

/**
 * 라피's upload against a real Postgres: the row holds a reference, a hub that is down keeps it, a
 * hub that comes back gets it once under the key the first attempt carried — and a file written
 * over in between is not what goes.
 *
 * The Bot's folder is a map, the hub a script that records each upload's parts; the outbox's waits
 * between retries are instant.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 4 },
);

const made: string[] = [];

afterEach(async () => {
  if (made.length) {
    await database.delete(hubOutbox).where(inArray(hubOutbox.id, made));
    made.length = 0;
  }
});

afterAll(async () => {
  await database.$client.close();
});

type Sent = { request: HubUploadRequest; names: string[]; text: string | null };

const down: HubAnswer<unknown> = {
  ok: false,
  status: null,
  code: "laf:hub_unreachable",
};

function stack(files: Map<string, Uint8Array>) {
  let up = true;
  const sent: Sent[] = [];
  const posts: string[] = [];
  const http: HubHttp = {
    async request(request) {
      if (!up) return down as never;
      posts.push(request.path);
      return { ok: true, status: 200, body: { ok: true } } as never;
    },
    async upload(request) {
      // Read whole whether or not the hub is up: a request that went out spent its body.
      const form = await new Response(request.body, {
        headers: { "content-type": request.contentType },
      }).formData();
      if (!up) return down as never;
      sent.push({
        request,
        names: [...form.keys()],
        text: form.get("text") === null ? null : String(form.get("text")),
      });
      return {
        ok: true,
        status: 200,
        body: { ok: true, id: "f_1", version: 1 },
      } as never;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  const readFolder = async ({ path }: { path: string }) => {
    const bytes = files.get(path);
    if (!bytes) throw new WorkspaceRequestError(FILE_NOT_FOUND);
    return bytes;
  };
  let uploads: HubUploads | undefined;
  const outbox: HubOutbox = createHubOutbox({
    database,
    http,
    sleep: async () => {},
    sendUpload: (reference, request) =>
      (uploads as HubUploads).sendReference(reference, request),
  });
  const enqueue = outbox.enqueue;
  outbox.enqueue = async (write) => {
    const id = await enqueue(write);
    made.push(id);
    return id;
  };
  uploads = createHubUploads({
    http,
    outbox,
    converter: { convert: async () => ({ ok: false, failure: "unavailable" }) },
    readFolder,
    readJudged: async ({ path }) => ({
      path,
      bytes: await readFolder({ path }),
    }),
    scopeOfThread: async () => MAIN_SCOPE,
  });
  const tools = createHubToolTransport({
    http,
    outbox,
    database,
    uploads,
    // Never resolves: the answer must come from the sweep having finished, not from a timer.
    sleep: () => new Promise<void>(() => {}),
  });
  return {
    tools,
    outbox,
    sent,
    posts,
    setUp: (value: boolean) => {
      up = value;
    },
  };
}

async function rowOf(id: string) {
  const [row] = await database
    .select()
    .from(hubOutbox)
    .where(inArray(hubOutbox.id, [id]));
  return row;
}

const chat = {
  url: "https://hub.example",
  drawnOn: "conversation" as const,
  botId: "bot_1",
  actorId: "user_1",
  threadId: "thread_1",
  runId: "run_1",
};

const NOTE = new TextEncoder().encode("거래처: 푸른솔식자재, 발주는 목요일");

describe("라피 uploads a file from its folder", () => {
  test("delivered at once when the hub is up, with its words", async () => {
    const s = stack(new Map([["거래처.txt", NOTE]]));
    const result = await s.tools.callTool(chat, "write", {
      kind: "upload",
      path: "거래처.txt",
      folder: "/영업",
    });
    expect(JSON.parse(result.text)).toEqual({
      source: "회사",
      kind: "upload",
      sent: true,
    });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.text).toBe("거래처: 푸른솔식자재, 발주는 목요일");
    expect(s.sent[0]?.request).toMatchObject({ origin: "chat", run: "run_1" });
    const row = await rowOf(s.sent[0]?.request.idempotencyKey ?? "");
    expect(row?.deliveredAt).toBeInstanceOf(Date);
    // The row holds where the file is, never its bytes or its words.
    expect(JSON.stringify(row?.body)).not.toContain("푸른솔");
  });

  test("a hub that is down keeps the row; back, the file goes once with the same key", async () => {
    const s = stack(new Map([["거래처.txt", NOTE]]));
    s.setUp(false);
    const result = await s.tools.callTool(chat, "write", {
      kind: "upload",
      path: "거래처.txt",
    });
    expect(JSON.parse(result.text)).toMatchObject({
      kind: "upload",
      sent: false,
    });
    expect(made).toHaveLength(1);
    const id = made[0] as string;
    const kept = await rowOf(id);
    expect(kept?.deliveredAt).toBeNull();
    expect(kept?.refusedAt).toBeNull();
    expect(kept?.lastCode).toBe("laf:hub_unreachable");
    expect(kept?.attempts).toBe(4);

    s.setUp(true);
    expect(await s.outbox.sweep()).toEqual({
      delivered: 1,
      refused: 0,
      kept: 0,
    });
    expect(await s.outbox.sweep()).toEqual({
      delivered: 0,
      refused: 0,
      kept: 0,
    });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.request.idempotencyKey).toBe(id);
    expect((await rowOf(id))?.deliveredAt).toBeInstanceOf(Date);
  });

  test("a file written over before the retry is not sent: the row ends with the fact", async () => {
    const files = new Map([["거래처.txt", NOTE]]);
    const s = stack(files);
    s.setUp(false);
    await s.tools.callTool(chat, "write", {
      kind: "upload",
      path: "거래처.txt",
    });
    const id = made[0] as string;

    files.set("거래처.txt", new TextEncoder().encode("다른 사람이 고친 내용"));
    s.setUp(true);
    expect(await s.outbox.sweep()).toEqual({
      delivered: 0,
      refused: 1,
      kept: 0,
    });
    const row = await rowOf(id);
    expect(row?.refusedAt).toBeInstanceOf(Date);
    expect(row?.lastCode).toBe(HUB_UPLOAD_CHANGED);
    expect(s.sent).toHaveLength(0);
  });

  test("a file that is not there is refused before any row", async () => {
    const s = stack(new Map());
    const refused = await s.tools
      .callTool(chat, "write", { kind: "upload", path: "없는파일.xlsx" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PluginRefusedError);
    expect((refused as PluginRefusedError).code).toBe(FILE_NOT_FOUND);
    expect(made).toHaveLength(0);
  });

  test("an upload whose computer is away waits, and a message behind it still goes", async () => {
    const files = new Map([["거래처.txt", NOTE]]);
    const s = stack(files);
    let away = false;
    // The computer itself, not the file: the row waits instead of ending.
    const realGet = files.get.bind(files);
    files.get = (key: string) => {
      if (away) {
        throw new ComputerUnavailableError("laf:computer_unreachable");
      }
      return realGet(key);
    };
    s.setUp(false);
    await s.tools.callTool(chat, "write", {
      kind: "upload",
      path: "거래처.txt",
    });
    await s.outbox.enqueue({
      method: "POST",
      path: "/rooms/r1/messages",
      body: { text: "자료 올렸어요" },
      origin: "chat",
    });
    // The sweep the write started, against the hub that is still down, is over before the hub is back.
    await s.outbox.sweep();
    away = true;
    s.setUp(true);
    const sweep = await s.outbox.sweep();
    expect(sweep).toEqual({ delivered: 1, refused: 0, kept: 1 });
    expect(s.posts).toEqual(["/rooms/r1/messages"]);
    const upload = await rowOf(made[0] as string);
    expect(upload?.deliveredAt).toBeNull();
    expect(upload?.refusedAt).toBeNull();
    expect(upload?.lastCode).toBe("laf:computer_unreachable");

    away = false;
    expect(await s.outbox.sweep()).toMatchObject({ delivered: 1 });
    expect(s.sent).toHaveLength(1);
  });
});
