import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type {
  HubFile,
  HubFileList,
  HubFileText,
  HubSync,
} from "../../shared/hub/protocol";
import { hubAudit, hubBlobs, hubChunks } from "../src/db/schema";
import { EVENT_WRITE_LOCK } from "../src/events";
import { blobPath } from "../src/files/store";
import { joinTask, put, upload } from "./support/files";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

let hub: TestHub;
const ann = {
  email: "ann@example.com",
  vmOrigin: "https://ann.example",
  pass: newPass(),
};
const ben = {
  email: "ben@example.com",
  vmOrigin: "https://ben.example",
  pass: newPass(),
};
const boss = {
  email: "boss@example.com",
  vmOrigin: "https://boss.example",
  pass: newPass(),
  role: "admin" as const,
};
let annId = "";
let benId = "";

beforeAll(async () => {
  hub = await startTestHub({ fileMaxBytes: 1000 });
  annId = (await putMember(hub, ann)).id;
  benId = (await putMember(hub, ben)).id;
  await putMember(hub, boss);
});
afterAll(() => hub.stop());

const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function get<T>(pass: string, path: string): Promise<[number, T]> {
  const response = await fetch(`${hub.url}/hub/v1${path}`, asMember(pass));
  return [response.status, (await response.json()) as T];
}

async function remove(pass: string, id: string, key = randomUUID()) {
  return fetch(`${hub.url}/hub/v1/files/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${pass}`, "idempotency-key": key },
  });
}

const incoming = async () =>
  readdir(join(hub.filesDir, ".incoming")).catch(() => []);

describe("PUT /files", () => {
  test("keeps the bytes by their hash, the text for reading, and answers with both", async () => {
    const bytes = "3월 매출 정산표 원본 바이트";
    const put1 = await put(hub, ann.pass, {
      meta: { name: "3월 정산.xlsx", folder: "/회계/2026" },
      text: "3월 매출 정산 내역입니다.",
      bytes,
      mime: "application/vnd.ms-excel",
    });
    expect(put1.version).toBe(1);
    expect(put1.sha256).toBe(sha(bytes));
    expect(await readFile(blobPath(hub.filesDir, put1.sha256), "utf8")).toBe(
      bytes,
    );
    expect(blobPath(hub.filesDir, put1.sha256)).toBe(
      join(
        hub.filesDir,
        put1.sha256.slice(0, 2),
        put1.sha256.slice(2, 4),
        put1.sha256,
      ),
    );

    const [status, meta] = await get<{ file: HubFile }>(
      ann.pass,
      `/files/${put1.id}`,
    );
    expect(status).toBe(200);
    expect(meta.file).toMatchObject({
      id: put1.id,
      name: "3월 정산.xlsx",
      folder: "/회계/2026",
      size: Buffer.byteLength(bytes),
      version: 1,
      mime: "application/vnd.ms-excel",
      by: annId,
      visibility: "company",
      hasText: true,
    });

    const content = await fetch(
      `${hub.url}/hub/v1/files/${put1.id}/content`,
      asMember(ben.pass),
    );
    expect(content.status).toBe(200);
    expect(content.headers.get("content-length")).toBe(
      String(Buffer.byteLength(bytes)),
    );
    expect(content.headers.get("content-type")).toBe(
      "application/vnd.ms-excel",
    );
    expect(await content.text()).toBe(bytes);
    expect(await incoming()).toEqual([]);
  });

  test("a version replaces the content, the text and the chunks, and keeps the place", async () => {
    const first = await put(hub, ann.pass, {
      meta: { name: "메뉴.txt" },
      text: "봄 메뉴 초안",
      bytes: "v1",
    });
    const second = await put(hub, ben.pass, {
      meta: { id: first.id, name: "ignored.txt" },
      text: "여름 메뉴 확정",
      bytes: "v2",
    });
    expect(second).toMatchObject({
      id: first.id,
      version: 2,
      sha256: sha("v2"),
    });
    const [, meta] = await get<{ file: HubFile }>(
      ann.pass,
      `/files/${first.id}`,
    );
    expect(meta.file).toMatchObject({
      name: "메뉴.txt",
      version: 2,
      by: benId,
    });
    const [, text] = await get<HubFileText>(
      ann.pass,
      `/files/${first.id}/text`,
    );
    expect(text.text).toBe("여름 메뉴 확정");
    const chunks = await hub.database
      .select({ text: hubChunks.text })
      .from(hubChunks)
      .where(eq(hubChunks.sourceId, first.id));
    expect(chunks).toEqual([{ text: "여름 메뉴 확정" }]);
  });

  test("the same bytes twice are one blob held twice, and a deletion lets one go", async () => {
    const bytes = `same-${randomUUID()}`;
    const a = await put(hub, ann.pass, { meta: { name: "a.bin" }, bytes });
    const b = await put(hub, ben.pass, { meta: { name: "b.bin" }, bytes });
    expect(a.sha256).toBe(b.sha256);
    const refs = async () =>
      (
        await hub.database
          .select({ refs: hubBlobs.refs })
          .from(hubBlobs)
          .where(eq(hubBlobs.sha256, a.sha256))
      )[0]?.refs;
    expect(await refs()).toBe(2);
    expect((await remove(ann.pass, a.id)).status).toBe(200);
    expect(await refs()).toBe(1);
    const [status] = await get(ann.pass, `/files/${a.id}`);
    expect(status).toBe(404);
    const [, list] = await get<HubFileList>(ann.pass, "/files");
    const ids = list.files.map((file) => file.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });

  test("a repeated key is one write, answered the same, with nothing left half-written", async () => {
    const key = randomUUID();
    const input = { meta: { name: "once.txt" }, bytes: "once", key };
    const first = await put(hub, ann.pass, input);
    const again = await put(hub, ann.pass, { ...input, bytes: "different" });
    expect(again).toEqual(first);
    const [, list] = await get<HubFileList>(ann.pass, "/files");
    expect(list.files.filter((file) => file.name === "once.txt")).toHaveLength(
      1,
    );
    expect(await incoming()).toEqual([]);
  });

  test("a file over the limit is refused at the byte that crosses it, and leaves nothing", async () => {
    const atLimit = await upload(hub, ann.pass, {
      meta: { name: "edge.bin" },
      bytes: "x".repeat(1000),
    });
    expect(atLimit.status).toBe(200);
    const over = await upload(hub, ann.pass, {
      meta: { name: "over.bin" },
      bytes: "y".repeat(1001),
    });
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({
      ok: false,
      code: "laf:hub_file_too_large",
    });
    expect(await incoming()).toEqual([]);
    const [, list] = await get<HubFileList>(ann.pass, "/files");
    expect(list.files.map((file) => file.name)).not.toContain("over.bin");
  });

  test.each([
    ["somebody else's me:", () => `me:${benId}`, 403],
    ["a task they are not on", () => "task:not-mine", 403],
    ["a value that is none of the three", () => "everyone", 400],
  ])("a member cannot give a file %s", async (_label, visibility, status) => {
    const response = await upload(hub, ann.pass, {
      meta: { name: "nope.txt", visibility: visibility() },
      bytes: "nope",
    });
    expect(response.status).toBe(status);
  });

  test("a member gives a file their own me:, or a task they are on", async () => {
    await joinTask(hub, "launch", annId);
    const mine = await upload(hub, ann.pass, {
      meta: { name: "mine.txt", visibility: `me:${annId}` },
      bytes: "mine",
    });
    expect(mine.status).toBe(200);
    const task = await upload(hub, ann.pass, {
      meta: { name: "task.txt", visibility: "task:launch" },
      bytes: "task",
    });
    expect(task.status).toBe(200);
  });

  test.each([
    ["no key", { "idempotency-key": "" }],
    ["not multipart", { "content-type": "application/json" }],
  ])("%s is a 400", async (_label, headers) => {
    const response = await fetch(`${hub.url}/hub/v1/files`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${ann.pass}`,
        "idempotency-key": randomUUID(),
        ...headers,
      },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });

  test.each([
    ["no blob", ["meta"]],
    ["no meta", ["blob"]],
    ["an unknown part", ["meta", "blob", "extra"]],
  ])("a body with %s is a 400", async (_label, parts) => {
    const form = new FormData();
    if (parts.includes("meta"))
      form.append("meta", JSON.stringify({ name: "x" }));
    if (parts.includes("blob")) form.append("blob", new Blob(["x"]), "x");
    if (parts.includes("extra")) form.append("extra", "x");
    const response = await fetch(`${hub.url}/hub/v1/files`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${ann.pass}`,
        "idempotency-key": randomUUID(),
      },
      body: form,
    });
    expect(response.status).toBe(400);
    expect(await incoming()).toEqual([]);
  });

  test("without a pass nothing is answered but the one-line refusal", async () => {
    const response = await fetch(`${hub.url}/hub/v1/files`);
    expect(response.status).toBe(401);
  });
});

describe("GET /files/:id/text", () => {
  test("hands back a range of characters and says when more follows", async () => {
    const text = `가나다라마바사${"아".repeat(30)}`;
    const file = await put(hub, ann.pass, {
      meta: { name: "range.txt" },
      text,
      bytes: "range",
    });
    const [, page] = await get<HubFileText>(
      ann.pass,
      `/files/${file.id}/text?from=2&limit=5`,
    );
    expect(page).toEqual({
      ok: true,
      text: "다라마바사",
      from: 2,
      total: 37,
      truncated: true,
    });
    const [, last] = await get<HubFileText>(
      ann.pass,
      `/files/${file.id}/text?from=30`,
    );
    expect(last).toMatchObject({ text: "아".repeat(7), truncated: false });
  });

  test.each(["limit=20001", "limit=0", "from=-1", "from=x"])(
    "%s is a 400",
    async (query) => {
      const file = await put(hub, ann.pass, {
        meta: { name: "q.txt" },
        text: "q",
        bytes: "q",
      });
      const [status] = await get(ann.pass, `/files/${file.id}/text?${query}`);
      expect(status).toBe(400);
    },
  );
});

describe("DELETE /files/:id", () => {
  test("a company file is taken away by the one who put it there or an admin, not by another member", async () => {
    const file = await put(hub, ann.pass, {
      meta: { name: "keep.txt" },
      bytes: `keep-${randomUUID()}`,
    });
    const byBen = await remove(ben.pass, file.id);
    expect(byBen.status).toBe(403);
    expect(await byBen.json()).toEqual({
      ok: false,
      code: "laf:hub_forbidden",
    });
    expect((await remove(boss.pass, file.id)).status).toBe(200);
    const [status] = await get(ann.pass, `/files/${file.id}`);
    expect(status).toBe(404);
  });
});

describe("events and the trail", () => {
  test("file.changed goes only to who may see the file, and the trail names the file and not its words", async () => {
    const [, before] = await get<HubSync>(ben.pass, "/sync?since=0");
    const secretName = "연봉협상-비공개.txt";
    const secretText = "비밀 문장 하나";
    const mine = await put(hub, ann.pass, {
      meta: { name: secretName, visibility: `me:${annId}` },
      text: secretText,
      bytes: "private bytes",
    });
    const shared = await put(hub, ann.pass, {
      meta: { name: "공지.txt" },
      bytes: "notice",
    });
    const [, forBen] = await get<HubSync>(
      ben.pass,
      `/sync?since=${before.seq}`,
    );
    const [, forAnn] = await get<HubSync>(
      ann.pass,
      `/sync?since=${before.seq}`,
    );
    const files = (sync: HubSync) =>
      sync.events
        .filter((event) => event.type === "file.changed")
        .map((event) => event.refId);
    expect(files(forBen)).toEqual([shared.id]);
    expect(files(forAnn)).toEqual([mine.id, shared.id]);

    await fetch(`${hub.url}/hub/v1/files/${mine.id}/text`, asMember(ann.pass));
    const trail = await hub.database
      .select()
      .from(hubAudit)
      .where(and(eq(hubAudit.target, mine.id)));
    expect(trail.map((row) => row.action)).toEqual([
      "file.written",
      "file.read",
    ]);
    expect(trail[0]).toMatchObject({
      member: annId,
      vmOrigin: ann.vmOrigin,
      outcome: "ok",
    });
    const serialised = JSON.stringify(trail);
    expect(serialised).not.toContain(secretName);
    expect(serialised).not.toContain(secretText);
  });
});

describe("a company that is full", () => {
  test("is refused with 507 and the fact, keeps what it has, and takes the same retry once there is room", async () => {
    const small = await startTestHub({ filesQuotaBytes: 100 });
    try {
      const pass = newPass();
      await putMember(small, {
        email: "solo@example.com",
        vmOrigin: "https://solo.example",
        pass,
      });
      const first = await put(small, pass, {
        meta: { name: "first.bin" },
        bytes: "a".repeat(60),
      });
      const key = randomUUID();
      const second = await upload(small, pass, {
        meta: { name: "second.bin" },
        bytes: "b".repeat(60),
        key,
      });
      expect(second.status).toBe(507);
      expect(await second.json()).toEqual({ ok: false, code: "laf:hub_full" });
      // The same bytes again take no more room.
      const copy = await upload(small, pass, {
        meta: { name: "copy.bin" },
        bytes: "a".repeat(60),
      });
      expect(copy.status).toBe(200);

      const response = await fetch(`${small.url}/hub/v1/files/${first.id}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${pass}`,
          "idempotency-key": randomUUID(),
        },
      });
      expect(response.status).toBe(200);
      const copyId = ((await copy.json()) as { id: string }).id;
      await fetch(`${small.url}/hub/v1/files/${copyId}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${pass}`,
          "idempotency-key": randomUUID(),
        },
      });
      const retried = await upload(small, pass, {
        meta: { name: "second.bin" },
        bytes: "b".repeat(60),
        key,
      });
      expect(retried.status).toBe(200);
    } finally {
      await small.stop();
    }
  });

  test("two uploads at once of different files cannot together go past the share", async () => {
    const small = await startTestHub({ filesQuotaBytes: 100 });
    // Before the lock below: registering a member writes an event too.
    const pass = newPass();
    await putMember(small, {
      email: "pair@example.com",
      vmOrigin: "https://pair.example",
      pass,
    });
    // Holds the event lock every write takes after its share check, so both uploads are inside
    // their transactions at once, past whatever check they made, until it is let go.
    let release = () => {};
    let held = () => {};
    const isHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = small.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${EVENT_WRITE_LOCK})`);
      held();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    try {
      await isHeld;
      const answers = Promise.all(
        ["a", "b"].map((letter) =>
          upload(small, pass, {
            meta: { name: `${letter}.bin` },
            bytes: letter.repeat(60),
          }),
        ),
      );
      // Both are waiting on a lock: the event lock, or the share's while the other holds it.
      for (let tries = 0; ; tries += 1) {
        const [row] = await small.database.execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_locks
               where locktype = 'advisory' and not granted
                 and database = (select oid from pg_database where datname = current_database())`,
        );
        if (row?.waiting === 2) break;
        if (tries > 500)
          throw new Error("the uploads never reached their writes");
        await Bun.sleep(10);
      }
      release();
      await holder;
      const statuses = (await answers).map((answer) => answer.status).sort();
      expect(statuses).toEqual([200, 507]);
      const [use] = await small.database
        .select({
          total: sql<number>`coalesce(sum(${hubBlobs.bytes}), 0)::int`,
        })
        .from(hubBlobs)
        .where(sql`${hubBlobs.refs} > 0`);
      expect(use?.total).toBe(60);
    } finally {
      release();
      await holder.catch(() => {});
      await small.stop();
    }
  });
});

describe("uploads at once", () => {
  /**
   * An upload whose body stops halfway until told to go on, over a raw socket: the request is in
   * the handler, reading, and cannot finish. (Bun's own fetch was not used for this: beside other
   * files it did not always start sending a body it was streaming.)
   */
  function heldUpload(pass: string, name: string) {
    const { hostname, port } = new URL(hub.url);
    const head = `--B\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify({ name })}\r\n--B\r\nContent-Disposition: form-data; name="blob"; filename="b"\r\n\r\nfirst half `;
    const tail = "second half\r\n--B--\r\n";
    // Chunked: with a small Content-Length Bun waits for the whole body before the handler runs.
    const chunk = (text: string) =>
      `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
    const socket = connect(Number(port), hostname);
    socket.write(
      [
        "PUT /hub/v1/files HTTP/1.1",
        `Host: ${hostname}:${port}`,
        `Authorization: Bearer ${pass}`,
        `Idempotency-Key: ${randomUUID()}`,
        "Content-Type: multipart/form-data; boundary=B",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        chunk(head),
      ].join("\r\n"),
    );
    // The status line is what is asserted; once the head is in, the socket is ours to close.
    // (Not on "close": Bun did not always close a `Connection: close` request's socket.)
    let answer = "";
    const done = new Promise<string>((resolve) => {
      socket.on("data", (data) => {
        answer += data.toString();
        if (answer.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(answer);
        }
      });
    });
    return {
      finish: () =>
        new Promise<void>((resolve, reject) =>
          socket.write(`${chunk(tail)}0\r\n\r\n`, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      done,
    };
  }

  test("a third upload while two are being read is told the hub is busy, and the two still land", async () => {
    const first = heldUpload(ann.pass, "held-1.txt");
    const second = heldUpload(ann.pass, "held-2.txt");
    // Each is inside the handler, reading, once its blob has a file in `.incoming`.
    for (let tries = 0; (await incoming()).length < 2; tries += 1) {
      if (tries > 200)
        throw new Error("the held uploads never reached the handler");
      await Bun.sleep(10);
    }
    const third = await upload(hub, ann.pass, {
      meta: { name: "third.txt" },
      bytes: "third",
    });
    await Promise.all([first.finish(), second.finish()]);
    expect(third.status).toBe(503);
    expect(third.headers.get("retry-after")).toBe("2");
    expect(await third.json()).toEqual({ ok: false, code: "laf:hub_busy" });
    expect((await first.done).split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    expect((await second.done).split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    const after = await upload(hub, ann.pass, {
      meta: { name: "third.txt" },
      bytes: "third",
    });
    expect(after.status).toBe(200);
  });
});
