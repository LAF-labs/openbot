import { afterAll, describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { MAIN_SCOPE, projectScope } from "../../shared/file-scope";
import { createConverter } from "../src/attachments/converter-client";
import {
  ComputerUnavailableError,
  FILE_NOT_FOUND,
  WorkspaceRequestError,
} from "../src/computer/client";
import {
  createHubHttp,
  type HubHttp,
  type HubUploadRequest,
} from "../src/hub/http";
import type { HubOutboxWrite } from "../src/hub/outbox";
import {
  createHubUploads,
  HUB_UPLOAD_CHANGED,
  HUB_UPLOAD_GONE,
  HUB_UPLOAD_READ_ASKED,
  HUB_UPLOAD_SOURCE_AWAY,
  type HubUploadDeps,
  HubUploadRefused,
  multipartBody,
  textOfFile,
} from "../src/hub/upload";

/**
 * A file into the company's team files: the words read out of it, the scope its read is judged
 * under, the body the hub reads part by part, and what an attempt says when the file moved.
 *
 * The converter is the real one, in the local child a laptop uses (`converter-client.ts`), so a
 * sheet's words come out of the same reader an attachment's do. The hub is a script, or — for the
 * HTTP half — a `Bun.serve` on port 0 that reads what arrived.
 */

const converter = createConverter({ kind: "local" });
/** A cold `bun` reading a sheet in a child, beside three other files' work. */
const CHILD = 30_000;

function workbook(rows: (string | number)[][], name = "거래처"): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(
    XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
  );
}

/** A real one-page PDF with a text layer (`attachments.test.ts`'s). */
function pdfWith(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** "상호,금액\n가나상회,1000\n" as Excel saves a CSV in Korea: CP949. */
const CP949_CSV = new Uint8Array([
  0xbb, 0xf3, 0xc8, 0xa3, 0x2c, 0xb1, 0xdd, 0xbe, 0xd7, 0x0a, 0xb0, 0xa1, 0xb3,
  0xaa, 0xbb, 0xf3, 0xc8, 0xb8, 0x2c, 0x31, 0x30, 0x30, 0x30, 0x0a,
]);

describe("the words that go up with a file", () => {
  test(
    "a Korean sheet's cells are read by the converter",
    async () => {
      const text = await textOfFile(
        converter,
        "거래처.xlsx",
        workbook([
          ["상호", "담당"],
          ["푸른솔식자재", "김민지"],
        ]),
      );
      expect(text).toContain("푸른솔식자재");
      expect(text).toContain("김민지");
    },
    CHILD,
  );

  test(
    "a PDF's text layer is read by the converter",
    async () => {
      const text = await textOfFile(
        converter,
        "견적.pdf",
        pdfWith("Quote 4500 won"),
      );
      expect(text).toContain("Quote 4500 won");
    },
    CHILD,
  );

  test(
    "a CSV saved in the Korean code page is read as Korean",
    async () => {
      const text = await textOfFile(converter, "목록.csv", CP949_CSV);
      expect(text).toContain("가나상회");
    },
    CHILD,
  );

  test("plain text is decoded here, UTF-8 or the Korean code page", async () => {
    const never = {
      convert: async () => {
        throw new Error("plain text never reaches the converter");
      },
    };
    expect(
      await textOfFile(
        never,
        "메모.txt",
        new TextEncoder().encode("회의는 화요일"),
      ),
    ).toBe("회의는 화요일");
    // "가나" in CP949.
    expect(
      await textOfFile(
        never,
        "메모.md",
        new Uint8Array([0xb0, 0xa1, 0xb3, 0xaa]),
      ),
    ).toBe("가나");
    // A NUL is no text file, whatever it is called.
    expect(
      await textOfFile(never, "a.txt", new Uint8Array([0x61, 0, 0x62])),
    ).toBeNull();
  });

  test("a file the converter does not read, or cannot, goes without words", async () => {
    let asked = 0;
    const failing = {
      convert: async () => {
        asked += 1;
        return { ok: false as const, failure: "unavailable" as const };
      },
    };
    expect(
      await textOfFile(failing, "사진.png", new Uint8Array([1, 2, 3])),
    ).toBeNull();
    // A photo is not offered to the converter at all; a sheet is, and its failure is no text.
    expect(asked).toBe(0);
    expect(
      await textOfFile(failing, "매출.xlsx", new Uint8Array([1, 2, 3])),
    ).toBeNull();
    expect(asked).toBe(1);
  });
});

/** What a multipart body says, as a fetch reader parses it. */
async function partsOf(request: {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}) {
  const form = await new Response(request.body, {
    headers: { "content-type": request.contentType },
  }).formData();
  const blob = form.get("blob");
  return {
    names: [...form.keys()],
    meta: JSON.parse(String(form.get("meta"))) as Record<string, unknown>,
    text: form.get("text") === null ? null : String(form.get("text")),
    blob:
      blob instanceof Blob ? new Uint8Array(await blob.arrayBuffer()) : null,
  };
}

describe("the body the hub reads part by part", () => {
  test("meta, text and blob arrive whole; a part with nothing is left out", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 13, 10, 45, 45]);
    const withText = await partsOf(
      multipartBody([
        {
          name: "meta",
          contentType: "application/json",
          body: async () =>
            new TextEncoder().encode('{"name":"매출.xlsx","folder":"/"}'),
        },
        {
          name: "text",
          contentType: "text/plain; charset=utf-8",
          body: async () => new TextEncoder().encode("가나상회"),
        },
        {
          name: "blob",
          contentType: "application/octet-stream",
          body: async () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 3));
                controller.enqueue(bytes.subarray(3));
                controller.close();
              },
            }),
        },
      ]),
    );
    expect(withText.names).toEqual(["meta", "text", "blob"]);
    expect(withText.meta).toEqual({ name: "매출.xlsx", folder: "/" });
    expect(withText.text).toBe("가나상회");
    expect(withText.blob).toEqual(bytes);

    const without = await partsOf(
      multipartBody([
        {
          name: "meta",
          contentType: "application/json",
          body: async () => new TextEncoder().encode("{}"),
        },
        { name: "text", contentType: "text/plain", body: async () => null },
        {
          name: "blob",
          contentType: "application/octet-stream",
          body: async () => bytes,
        },
      ]),
    );
    expect(without.names).toEqual(["meta", "blob"]);
  });
});

/** A Bot's folder as a map, an outbox that records, a hub that records. */
function harness(
  files: Map<string, Uint8Array>,
  options: {
    judged?: HubUploadDeps["readJudged"];
    projectOfThread?: string | null;
    folderFails?: () => Error | null;
  } = {},
) {
  const enqueued: HubOutboxWrite[] = [];
  const uploads: {
    request: HubUploadRequest;
    parts: Awaited<ReturnType<typeof partsOf>>;
  }[] = [];
  const read: string[] = [];
  const http: HubHttp = {
    request: async () => ({ ok: false, status: null, code: "x" }),
    async upload(request) {
      uploads.push({ request, parts: await partsOf(request) });
      return { ok: true, status: 200, body: { ok: true, id: "f_1" } } as never;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  const readFolder: HubUploadDeps["readFolder"] = async ({ path, scope }) => {
    read.push(`${scope.kind}:${path}`);
    const failure = options.folderFails?.();
    if (failure) throw failure;
    const bytes = files.get(path);
    if (!bytes) throw new WorkspaceRequestError(FILE_NOT_FOUND);
    return bytes;
  };
  const deps: HubUploadDeps = {
    http,
    outbox: {
      async enqueue(write) {
        enqueued.push(write);
        return `row_${enqueued.length}`;
      },
    },
    converter: {
      convert: async () => ({ ok: false, failure: "unavailable" }),
    },
    readFolder,
    readJudged:
      options.judged ??
      (async ({ path }) => ({
        path,
        bytes: await readFolder({ botId: "b", scope: MAIN_SCOPE, path }),
      })),
    scopeOfThread: async () =>
      options.projectOfThread
        ? projectScope(options.projectOfThread)
        : MAIN_SCOPE,
  };
  return { uploads: createHubUploads(deps), enqueued, sent: uploads, read };
}

const NOTE = new TextEncoder().encode("발주는 목요일");

describe("a run's upload: judged under its scope, then a reference", () => {
  test("a project's run is refused another project's file before anything is read", async () => {
    let judged = 0;
    const h = harness(new Map([["projects/channel_b/급여.txt", NOTE]]), {
      projectOfThread: "channel_a",
      judged: async () => {
        judged += 1;
        return { path: "x", bytes: NOTE };
      },
    });
    const refused = await h.uploads
      .uploadToHub({
        path: "projects/channel_b/급여.txt",
        botId: "bot_1",
        actor: { id: "u_1", threadId: "t_a" },
        origin: "chat",
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HubUploadRefused);
    expect((refused as HubUploadRefused).code).toBe("laf:file_other_project");
    expect(judged).toBe(0);
    expect(h.enqueued).toHaveLength(0);

    // The same file from the main conversation: refused too — the main folder is no project's.
    const main = harness(new Map([["projects/channel_b/급여.txt", NOTE]]));
    const alsoRefused = await main.uploads
      .uploadToHub({
        path: "projects/channel_b/급여.txt",
        botId: "bot_1",
        actor: { id: "u_1" },
        origin: "chat",
      })
      .catch((error: unknown) => error);
    expect((alsoRefused as HubUploadRefused).code).toBe(
      "laf:file_other_project",
    );
  });

  test("an allowed read becomes a row holding where the file is and its SHA-256, not its bytes", async () => {
    const h = harness(new Map([["거래처.txt", NOTE]]), {
      projectOfThread: "channel_a",
      // The gateway hands back the path as it judged it.
      judged: async () => ({ path: "거래처.txt", bytes: NOTE }),
    });
    const outcome = await h.uploads.uploadToHub({
      path: "./거래처.txt",
      botId: "bot_1",
      actor: { id: "u_1", threadId: "t_a", runId: "run_7" },
      folder: "/영업",
      origin: "chat",
    });
    expect(outcome).toEqual({ queued: "row_1" });
    expect(h.enqueued).toEqual([
      {
        method: "PUT",
        path: "/files",
        body: {
          upload: {
            botId: "bot_1",
            scope: "project:channel_a",
            path: "거래처.txt",
            sha256: new Bun.CryptoHasher("sha256").update(NOTE).digest("hex"),
            size: NOTE.byteLength,
            name: "거래처.txt",
            folder: "/영업",
            visibility: null,
          },
        },
        origin: "chat",
        runId: "run_7",
      },
    ]);
    expect(JSON.stringify(h.enqueued)).not.toContain("발주는");
  });

  test("a rule that refuses the read, or would ask about it, sends nothing", async () => {
    for (const [thrown, code] of [
      [
        Object.assign(new Error("laf:policy_denied"), {
          code: "laf:policy_denied",
        }),
        "laf:policy_denied",
      ],
      [
        // What the gateway refuses a read with where a rule asks: no question is opened for an
        // upload (`acts.ts`, `readWholeFile`).
        Object.assign(new Error("laf:would_ask"), { code: "laf:would_ask" }),
        HUB_UPLOAD_READ_ASKED,
      ],
    ] as const) {
      const h = harness(new Map([["a.txt", NOTE]]), {
        judged: async () => {
          throw thrown;
        },
      });
      const refused = await h.uploads
        .uploadToHub({
          path: "a.txt",
          botId: "b",
          actor: { id: "u" },
          origin: "chat",
        })
        .catch((error: unknown) => error);
      expect((refused as HubUploadRefused).code).toBe(code);
      expect(h.enqueued).toHaveLength(0);
    }
  });
});

describe("an attempt reads the file again", () => {
  const reference = {
    botId: "bot_1",
    scope: "project:channel_a",
    path: "projects/channel_a/메모.txt",
    sha256: new Bun.CryptoHasher("sha256").update(NOTE).digest("hex"),
    size: NOTE.byteLength,
    name: "메모.txt",
    folder: "/",
    visibility: null,
  };
  const request = { idempotencyKey: "row_1", origin: "chat", run: "run_7" };

  test("the same bytes go, with their words, under the row's key, read as the row's scope", async () => {
    const h = harness(new Map([[reference.path, NOTE]]));
    const answer = await h.uploads.sendReference(reference, request);
    expect(answer.ok).toBe(true);
    expect(h.read).toEqual([`project:${reference.path}`]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.request).toMatchObject({
      path: "/files",
      idempotencyKey: "row_1",
      origin: "chat",
      run: "run_7",
    });
    expect(h.sent[0]?.parts.meta).toEqual({ name: "메모.txt", folder: "/" });
    expect(h.sent[0]?.parts.text).toBe("발주는 목요일");
    expect(h.sent[0]?.parts.blob).toEqual(NOTE);
  });

  test("a name the team sees with no kind in it still sends the words: the kind is the file's", async () => {
    // The tool lets 라피 name the file for the team, and a title has no ending.
    const h = harness(new Map([[reference.path, NOTE]]));
    const answer = await h.uploads.sendReference(
      { ...reference, name: "목요일 발주 메모" },
      request,
    );
    expect(answer.ok).toBe(true);
    expect(h.sent[0]?.parts.meta).toEqual({
      name: "목요일 발주 메모",
      folder: "/",
    });
    expect(h.sent[0]?.parts.text).toBe("발주는 목요일");
  });

  test("a file written over since it was judged is not sent", async () => {
    const h = harness(
      new Map([[reference.path, new TextEncoder().encode("다른 내용")]]),
    );
    const answer = await h.uploads.sendReference(reference, request);
    expect(answer).toEqual({
      ok: false,
      status: null,
      code: HUB_UPLOAD_CHANGED,
    });
    expect(h.sent).toHaveLength(0);
  });

  test("a file that is gone, or a computer that does not answer, each say so", async () => {
    const gone = harness(new Map());
    expect(await gone.uploads.sendReference(reference, request)).toEqual({
      ok: false,
      status: null,
      code: HUB_UPLOAD_GONE,
    });
    const away = harness(new Map([[reference.path, NOTE]]), {
      folderFails: () =>
        new ComputerUnavailableError("laf:computer_unreachable"),
    });
    expect((await away.uploads.sendReference(reference, request)).ok).toBe(
      false,
    );
    expect(await away.uploads.sendReference(reference, request)).toMatchObject({
      code: HUB_UPLOAD_SOURCE_AWAY,
    });
    expect(gone.sent.length + away.sent.length).toBe(0);
  });

  test("a scope the row cannot name is refused, never guessed", async () => {
    const h = harness(new Map([[reference.path, NOTE]]));
    expect(
      await h.uploads.sendReference(
        { ...reference, scope: "anybody" },
        request,
      ),
    ).toMatchObject({ ok: false, code: "laf:request_invalid" });
    expect(h.read).toHaveLength(0);
  });
});

describe("a person's file, as a stream", () => {
  test("passed through once with its words after it, and no row", async () => {
    const h = harness(new Map());
    const plain = new TextEncoder().encode("주간 회의록: 신메뉴 출시");
    const outcome = await h.uploads.uploadToHub({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(plain.subarray(0, 7));
          controller.enqueue(plain.subarray(7));
          controller.close();
        },
      }),
      name: "회의록.txt",
      folder: "/회의",
      idempotencyKey: "upload_key_1",
      origin: "person",
    });
    expect(outcome).toMatchObject({ answer: { ok: true } });
    expect(h.enqueued).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.request.idempotencyKey).toBe("upload_key_1");
    expect(h.sent[0]?.parts.names).toEqual(["meta", "blob", "text"]);
    expect(h.sent[0]?.parts.blob).toEqual(plain);
    expect(h.sent[0]?.parts.text).toBe("주간 회의록: 신메뉴 출시");
  });
});

describe("the hub's answer to an upload", () => {
  let status = 200;
  let body: unknown = { ok: true, id: "f_1", version: 1, sha256: "x" };
  const seen: { headers: Headers; names: string[]; blob: number }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const form = await request.formData();
      const blob = form.get("blob");
      seen.push({
        headers: request.headers,
        names: [...form.keys()],
        blob: blob instanceof Blob ? blob.size : -1,
      });
      return Response.json(body, { status });
    },
  });
  afterAll(() => server.stop(true));
  const http = createHubHttp({
    url: `http://localhost:${server.port}`,
    vmKey: "pass_for_test",
  });
  const send = () => {
    const multipart = multipartBody([
      {
        name: "meta",
        contentType: "application/json",
        body: async () => new TextEncoder().encode('{"name":"a.txt"}'),
      },
      {
        name: "blob",
        contentType: "application/octet-stream",
        body: async () => new Uint8Array(70_000).fill(7),
      },
    ]);
    return http.upload({
      path: "/files",
      body: multipart.body,
      contentType: multipart.contentType,
      idempotencyKey: "row_42",
      origin: "chat",
      run: "run_1",
    });
  };

  test("taken: the body arrived whole with the pass, the key and the run", async () => {
    status = 200;
    body = { ok: true, id: "f_1", version: 1, sha256: "x" };
    expect(await send()).toEqual({ ok: true, status: 200, body });
    const last = seen.at(-1);
    expect(last?.names).toEqual(["meta", "blob"]);
    expect(last?.blob).toBe(70_000);
    expect(last?.headers.get("authorization")).toBe("Bearer pass_for_test");
    expect(last?.headers.get("idempotency-key")).toBe("row_42");
    expect(last?.headers.get("x-laf-run")).toBe("run_1");
    expect(last?.headers.get("x-laf-origin")).toBe("chat");
  });

  test("full ends the row; busy and down keep it; a refusal says its code", async () => {
    status = 507;
    body = { ok: false, code: "laf:hub_full" };
    expect(await send()).toEqual({
      ok: false,
      status: 507,
      code: "laf:hub_full",
    });
    status = 503;
    body = { ok: false, code: "laf:hub_busy" };
    expect(await send()).toMatchObject({ code: "laf:hub_unreachable" });
    status = 413;
    body = { ok: false, code: "laf:hub_file_too_large" };
    expect(await send()).toMatchObject({ code: "laf:hub_file_too_large" });
  });
});
