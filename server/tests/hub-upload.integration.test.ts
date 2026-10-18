import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { MAIN_SCOPE } from "../../shared/file-scope";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import {
  ComputerUnavailableError,
  FILE_NOT_FOUND,
  WorkspaceRequestError,
} from "../src/computer/client";
import { createDatabase } from "../src/db/client";
import { hubOutbox } from "../src/db/schema";
import {
  createHubHttp,
  type HubAnswer,
  type HubHttp,
  type HubUploadRequest,
} from "../src/hub/http";
import { createHubOutbox, type HubOutbox } from "../src/hub/outbox";
import { createHubToolTransport, HUB_UPLOAD_SENDING } from "../src/hub/tools";
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

function stack(
  files: Map<string, Uint8Array>,
  options: {
    /** Holds the hub's answer to an upload: told when it is out, answering when `answer` does. */
    held?: { asked: () => void; answer: Promise<void> };
    /** The write's wait; by default one that never ends. */
    sleep?: () => Promise<void>;
    /** Which uploads the hub holds, by the name the file goes up under. All of them by default. */
    holds?: (name: string) => boolean;
  } = {},
) {
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
      const meta = JSON.parse(String(form.get("meta"))) as { name: string };
      if (options.held && (options.holds?.(meta.name) ?? true)) {
        options.held.asked();
        await options.held.answer;
      }
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
    sleep: options.sleep ?? (() => new Promise<void>(() => {})),
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

  test("an upload still on its way when the wait ends is said as on its way, and the Bot is not held behind it", async () => {
    let asked = () => {};
    const inFlight = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let answer = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const s = stack(new Map([["거래처.txt", NOTE]]), {
      held: { asked, answer: held },
      // The wait ends the moment the upload is out, with the hub's answer still held.
      sleep: () => inFlight,
    });
    // Read with a lock that waits, this call stands behind the held answer and never returns.
    const result = await s.tools.callTool(chat, "write", {
      kind: "upload",
      path: "거래처.txt",
    });
    expect(JSON.parse(result.text)).toEqual({
      source: "회사",
      kind: "upload",
      sent: false,
      sending: true,
      note: toolResultText(HUB_UPLOAD_SENDING),
    });
    expect(s.sent).toHaveLength(1);
    const id = made[0] as string;
    expect((await rowOf(id))?.deliveredAt).toBeNull();

    answer();
    // The sweep the write started is the one running: asked again, the outbox hands back that
    // same sweep, so this waits for the attempt to write the hub's answer — and for the sweep to
    // end, so it takes no row of the next test's.
    expect(await s.outbox.sweep()).toMatchObject({ delivered: 1, refused: 0 });
    const row = await rowOf(id);
    expect(row?.deliveredAt).toBeInstanceOf(Date);
    expect(row?.refusedAt).toBeNull();
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

  test("a room post written while an upload is out goes at once, and a second upload is said as on its way", async () => {
    let asked = () => {};
    const inFlight = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let answer = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let waits = 0;
    const s = stack(
      new Map([
        ["거래처.txt", NOTE],
        ["견적.txt", new TextEncoder().encode("견적 4500원")],
      ]),
      {
        held: { asked, answer: held },
        holds: (name) => name === "거래처.txt",
        // The first upload's wait ends once it is out; the post's never does, so its answer is the
        // hub's; the second upload's at once, with the first still out ahead of it.
        sleep: () => {
          waits += 1;
          if (waits === 1) return inFlight;
          if (waits === 2) return new Promise<void>(() => {});
          return Promise.resolve();
        },
      },
    );
    const first = await s.tools.callTool(chat, "write", {
      kind: "upload",
      path: "거래처.txt",
    });
    expect(JSON.parse(first.text)).toMatchObject({ sending: true });

    const post = await s.tools.callTool(chat, "write", {
      kind: "post",
      room: "r1",
      text: "자료 올려요",
    });
    expect(JSON.parse(post.text)).toEqual({
      source: "회사",
      kind: "post",
      sent: true,
    });
    expect(s.posts).toEqual(["/rooms/r1/messages"]);

    const second = await s.tools.callTool(chat, "write", {
      kind: "upload",
      path: "견적.txt",
    });
    expect(JSON.parse(second.text)).toEqual({
      source: "회사",
      kind: "upload",
      sent: false,
      sending: true,
      note: toolResultText(HUB_UPLOAD_SENDING),
    });

    answer();
    await s.outbox.sweep();
    expect(s.sent.map((one) => one.request.idempotencyKey)).toEqual([
      made[0],
      made[2],
    ]);
    for (const id of made) {
      expect((await rowOf(id))?.deliveredAt).toBeInstanceOf(Date);
    }
  });

  test("an upload written after its lane last looked is offered in the same sweep", async () => {
    const reference = (path: string) => ({
      upload: {
        botId: "bot_1",
        scope: "main",
        path,
        sha256: "unchecked",
        size: 1,
        name: path,
        folder: "/",
      },
    });
    const sent: string[] = [];
    let second: string | null = null;
    // The outbox's database, with the second row written the moment the sweep has found nothing
    // more to offer: after its last look, before it ends.
    const watched = Object.create(database, {
      transaction: {
        value: async (...args: Parameters<typeof database.transaction>) => {
          const result = await database.transaction(...args);
          if (result === null && second === null) {
            second = await outbox.enqueue({
              method: "PUT",
              path: "/files",
              body: reference("견적.txt"),
              origin: "chat",
            });
            made.push(second);
          }
          return result;
        },
      },
    }) as typeof database;
    const outbox = createHubOutbox({
      database: watched,
      http: {} as HubHttp,
      sleep: async () => {},
      // The first file's computer does not answer, so its row waits and the sweep goes on.
      sendUpload: async (held) => {
        if (held.path === "거래처.txt") {
          return { ok: false, status: null, code: "laf:computer_unreachable" };
        }
        sent.push(held.path);
        return { ok: true, status: 200, body: {} };
      },
    });
    const [first] = await database
      .insert(hubOutbox)
      .values({
        id: crypto.randomUUID(),
        method: "PUT",
        path: "/files",
        body: reference("거래처.txt"),
        origin: "chat",
      })
      .returning({ id: hubOutbox.id });
    made.push(first?.id as string);

    expect(await outbox.sweep("uploads")).toEqual({
      delivered: 1,
      refused: 0,
      kept: 1,
    });
    expect(sent).toEqual(["견적.txt"]);
    expect((await rowOf(second ?? ""))?.deliveredAt).toBeInstanceOf(Date);
  });
});

describe("a hub that answers an upload it will not take now", () => {
  /** The hub's front door: `PUT /files` answered as `answerUpload` says, the rest taken. */
  function hub(answerUpload: (name: string) => Response | null) {
    const asked: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        asked.push(`${request.method} ${path}`);
        if (request.method === "PUT" && path === "/hub/v1/files") {
          const form = await request.formData();
          const meta = JSON.parse(String(form.get("meta"))) as { name: string };
          return (
            answerUpload(meta.name) ??
            Response.json({ ok: true, id: "f_1", version: 1 })
          );
        }
        return Response.json({ ok: true });
      },
    });
    const http = createHubHttp({
      url: `http://localhost:${server.port}`,
      vmKey: "pass_for_test",
      sleep: async () => {},
    });
    const files = new Map([
      ["거래처.txt", NOTE],
      ["견적.txt", new TextEncoder().encode("견적 4500원")],
    ]);
    const readFolder = async ({ path }: { path: string }) => {
      const bytes = files.get(path);
      if (!bytes) throw new WorkspaceRequestError(FILE_NOT_FOUND);
      return bytes;
    };
    let uploads: HubUploads | undefined;
    const outbox = createHubOutbox({
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
      converter: {
        convert: async () => ({ ok: false, failure: "unavailable" }),
      },
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
      sleep: () => new Promise<void>(() => {}),
    });
    return { tools, outbox, asked, stop: () => server.stop(true) };
  }

  test("a hub with no file space ends the upload with its own fact, and the writes behind it go", async () => {
    const h = hub(() =>
      Response.json(
        { ok: false, code: "laf:hub_files_unset" },
        { status: 503 },
      ),
    );
    try {
      const refused = await h.tools
        .callTool(chat, "write", { kind: "upload", path: "거래처.txt" })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PluginRefusedError);
      expect((refused as PluginRefusedError).code).toBe("laf:hub_files_unset");
      const row = await rowOf(made[0] as string);
      expect(row?.refusedAt).toBeInstanceOf(Date);
      expect(row?.status).toBe(503);

      const post = await h.tools.callTool(chat, "write", {
        kind: "post",
        room: "r1",
        text: "자료는 메일로 보낼게요",
      });
      expect(JSON.parse(post.text)).toMatchObject({ sent: true });
      // Asked once: an ended row is not offered again.
      expect(await h.outbox.sweep()).toEqual({
        delivered: 0,
        refused: 0,
        kept: 0,
      });
      expect(h.asked.filter((one) => one.startsWith("PUT"))).toHaveLength(1);
    } finally {
      h.stop();
    }
  });

  test("a hub taking as many uploads as it can keeps the row, says it is on its way, and the next upload still goes", async () => {
    let busy = true;
    const h = hub((name) =>
      busy && name === "거래처.txt"
        ? Response.json(
            { ok: false, code: "laf:hub_busy" },
            { status: 503, headers: { "retry-after": "2" } },
          )
        : null,
    );
    try {
      const first = await h.tools.callTool(chat, "write", {
        kind: "upload",
        path: "거래처.txt",
      });
      expect(JSON.parse(first.text)).toMatchObject({
        sent: false,
        sending: true,
      });
      const kept = await rowOf(made[0] as string);
      expect(kept?.refusedAt).toBeNull();
      expect(kept?.lastCode).toBe("laf:hub_busy");
      // Asked again after the same waits a hub that did not answer gets.
      expect(kept?.attempts).toBe(4);

      const second = await h.tools.callTool(chat, "write", {
        kind: "upload",
        path: "견적.txt",
      });
      expect(JSON.parse(second.text)).toMatchObject({ sent: true });

      busy = false;
      expect(await h.outbox.sweep()).toMatchObject({ delivered: 1, kept: 0 });
      expect((await rowOf(made[0] as string))?.deliveredAt).toBeInstanceOf(
        Date,
      );
    } finally {
      h.stop();
    }
  });
});
