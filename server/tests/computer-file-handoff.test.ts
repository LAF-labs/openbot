import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRegistry } from "../src/computer/approvals";
import {
  type ComputerClient,
  ComputerUnavailableError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import { createPolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import { API_CSP, createSecurityMiddleware } from "../src/middleware/security";

/**
 * A FILE ON ITS WAY FROM THE BOT'S FOLDER TO THE PERSON (phase 8, first slice, 2026-10-02).
 *
 * The route that sends it is on the origin that serves the app, and what it sends was written by a
 * Bot — or by whatever page handed the Bot's browser a download. So the thing under test is less
 * that the bytes arrive than what they arrive WEARING: a file opened by this origin as the document
 * it claims to be would run with the person's session. Every header is asserted exactly, for every
 * kind of file a Bot might be talked into writing.
 *
 * The computer here is a folder in memory that refuses the way the container does
 * (`agent-computer/src/workspace.ts`); `tests/file-handoff.test.ts` at the root runs the same
 * routes against the container's real ones.
 */

const OWNER = {
  id: "owner-user",
  email: "owner@laf.test",
  role: "user",
} as const;

const text = (value: string) => new TextEncoder().encode(value);
const bytesOf = (...values: number[]) => Uint8Array.from(values);

const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3);
const GIF = text("GIF89a...");
const WEBP = bytesOf(...text("RIFF"), 0x24, 0, 0, 0, ...text("WEBPVP8 "));
/** What a Bot can be talked into writing: a page of script, under any name it likes. */
const SCRIPT = text("<script>fetch('/api/me').then(steal)</script>");
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"/>');
/** Distinctive enough that finding it in a serialised row means what it looks like it means. */
const CONTENTS = "합계,12000,ZX9-FILE-CONTENTS";

const FILES: Record<string, Uint8Array<ArrayBuffer>> = {
  "보고서/9월 정산내역 (2).csv": text(CONTENTS),
  "notes.md": text("# 메모"),
  "chart.png": PNG,
  "photo.JPG": JPEG,
  "photo.jpeg": JPEG,
  "moving.gif": GIF,
  "shot.webp": WEBP,
  "drawing.svg": SVG,
  "page.html": SCRIPT,
  "report.pdf": text("%PDF-1.7"),
  // The name says picture and the bytes say otherwise — and the other way round.
  "disguised.png": SCRIPT,
  "mislabelled.csv": PNG,
  "wrong-picture.gif": PNG,
  "data.bin": bytesOf(0, 1, 2, 255),
  ".results/call_1.txt": text("a long tool result"),
  noextension: text("x"),
};

function surface(
  options: {
    drives?: (botId: string) => boolean;
    auditFailure?: Error;
    unreachable?: boolean;
    truncated?: boolean;
  } = {},
) {
  const rows: AuditEventInput[] = [];
  const asked: string[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => {
      if (options.auditFailure) throw options.auditFailure;
      rows.push(event);
    },
  };
  /** The container's own refusals, as the client raises them (`COMPUTER_ANSWERS`). */
  const found = (path: string) => {
    if (options.unreachable) {
      throw new ComputerUnavailableError("laf:computer_unreachable");
    }
    if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
      throw new WorkspaceRefusedError("laf:file_path_refused");
    }
    if (path === "보고서" || path === ".results") {
      throw new WorkspaceRequestError("laf:file_wrong_kind");
    }
    if (path === "huge.bin") {
      throw new WorkspaceRequestError("laf:file_too_large");
    }
    const file = FILES[path];
    if (!file) throw new WorkspaceRequestError("laf:file_not_found");
    return file;
  };
  const client = {
    statFile: async (path: string) => {
      asked.push(`stat ${path}`);
      return { path, kind: "file" as const, bytes: found(path).byteLength };
    },
    downloadFile: async (path: string) => {
      asked.push(`download ${path}`);
      return found(path);
    },
    listFiles: async (input: { path?: string }) => {
      asked.push(`list ${input.path ?? "."}`);
      if (options.unreachable) {
        throw new ComputerUnavailableError("laf:computer_unreachable");
      }
      if (input.path === "nowhere") {
        throw new WorkspaceRequestError("laf:file_not_found");
      }
      return {
        path: input.path ?? ".",
        entries: [
          { path: ".results", kind: "folder" as const },
          { path: ".results/call_1.txt", kind: "file" as const, bytes: 18 },
          { path: "notes.md", kind: "file" as const, bytes: 8 },
          { path: "보고서", kind: "folder" as const },
          {
            path: "보고서/9월 정산내역 (2).csv",
            kind: "file" as const,
            bytes: 33,
          },
          { path: "보고서/.draft.md", kind: "file" as const, bytes: 1 },
        ],
        truncated: options.truncated === true,
      };
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  const policy = { deny: [], ask: [], allow: ["true"] };
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => policy,
    approvals: createApprovalRegistry(),
  });
  const drives = options.drives ?? ((botId: string) => botId === "bot-1");
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", OWNER);
    context.set("mayDriveBot", async (botId) => drives(botId));
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createComputerRoutes(
      client,
      gateway,
      createPolicyStore(policy),
      requireUser,
    ),
  );
  const download = (path: string, inline = false) =>
    app.request(
      `/bot-1/files/download?path=${encodeURIComponent(path)}${inline ? "&inline=1" : ""}`,
    );
  return { app, rows, asked, download };
}

/** The headers a file must leave wearing, whatever it is. */
const ALWAYS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
  "cache-control": "private, no-store",
};

const headersOf = (response: Response) => ({
  "content-type": response.headers.get("content-type"),
  "content-disposition": response.headers.get("content-disposition"),
  "x-content-type-options": response.headers.get("x-content-type-options"),
  "content-security-policy": response.headers.get("content-security-policy"),
  "cache-control": response.headers.get("cache-control"),
});

const refusalOf = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as Record<string, unknown>,
});

describe("a file, downloaded", () => {
  test("arrives whole, as an attachment under its own Korean name, and can run nothing", async () => {
    const { download } = surface();

    const response = await download("보고서/9월 정산내역 (2).csv");

    expect(response.status).toBe(200);
    expect(headersOf(response)).toEqual({
      "content-type": "text/csv",
      // The name and not the path; percent-encoded UTF-8, the brackets with it (RFC 5987).
      "content-disposition":
        "attachment; filename*=UTF-8''9%EC%9B%94%20%EC%A0%95%EC%82%B0%EB%82%B4%EC%97%AD%20%282%29.csv",
      ...ALWAYS,
    });
    expect(response.headers.get("content-length")).toBe(
      String(text(CONTENTS).byteLength),
    );
    expect(await response.text()).toBe(CONTENTS);
  });

  test("its name decodes back to exactly what the file is called", async () => {
    const { download } = surface();
    const response = await download("보고서/9월 정산내역 (2).csv");
    const disposition = response.headers.get("content-disposition") ?? "";
    const encoded = disposition.split("filename*=UTF-8''")[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe("9월 정산내역 (2).csv");
    // Nothing in the header but what the grammar allows there: no quote, bracket, star or space.
    expect(encoded).toMatch(/^[A-Za-z0-9!#$&+.^_`|~%-]+$/);
  });

  test("every kind of file is an attachment, typed from a fixed table by its name alone", async () => {
    const { download } = surface();
    const TYPES: Array<[string, string]> = [
      ["notes.md", "text/markdown"],
      ["report.pdf", "application/pdf"],
      ["chart.png", "image/png"],
      ["photo.JPG", "image/jpeg"],
      ["moving.gif", "image/gif"],
      ["shot.webp", "image/webp"],
      // Not in the table on purpose: this origin does not vouch for a document a Bot wrote.
      ["page.html", "application/octet-stream"],
      ["drawing.svg", "application/octet-stream"],
      ["data.bin", "application/octet-stream"],
      ["noextension", "application/octet-stream"],
      // By the name, never by the bytes: a picture called a sheet is sent as a sheet.
      ["mislabelled.csv", "text/csv"],
    ];
    for (const [path, type] of TYPES) {
      const response = await download(path);
      expect({ path, ...headersOf(response) }).toEqual({
        path,
        "content-type": type,
        "content-disposition": `attachment; filename*=UTF-8''${path}`,
        ...ALWAYS,
      });
    }
  });

  test("leaves a row: who, which Bot's folder, which path, how big — and nothing it held", async () => {
    const { download, rows } = surface();

    await download("보고서/9월 정산내역 (2).csv");

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
          bytes: text(CONTENTS).byteLength,
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("ZX9-FILE-CONTENTS");
  });

  test("is not handed over when the trail will not take the row", async () => {
    // No path on which a file leaves as a file and nothing says so: the row is written between the
    // bytes arriving and their being sent on, and its failure is the download's.
    const { download } = surface({ auditFailure: new Error("trail is full") });

    const response = await download("notes.md");

    expect(await refusalOf(response)).toEqual({
      status: 500,
      body: { error: "laf:computer_failed", code: "laf:computer_failed" },
    });
  });
});

describe("a picture, drawn in the card", () => {
  test("is inline only when asked, only for the four, and only when its bytes agree with its name", async () => {
    const { download } = surface();
    for (const [path, type] of [
      ["chart.png", "image/png"],
      ["photo.JPG", "image/jpeg"],
      ["photo.jpeg", "image/jpeg"],
      ["moving.gif", "image/gif"],
      ["shot.webp", "image/webp"],
    ] as const) {
      const drawn = await download(path, true);
      expect({ path, ...headersOf(drawn) }).toEqual({
        path,
        "content-type": type,
        "content-disposition": `inline; filename*=UTF-8''${path}`,
        ...ALWAYS,
      });
      // The same file without the asking is a download like any other.
      const saved = await download(path);
      expect(saved.headers.get("content-disposition")).toBe(
        `attachment; filename*=UTF-8''${path}`,
      );
    }
  });

  test("an SVG, a page, a PDF and everything else is never inline, however it is asked for", async () => {
    const { download } = surface();
    for (const path of [
      "drawing.svg",
      "page.html",
      "report.pdf",
      "notes.md",
      "data.bin",
      "noextension",
      "보고서/9월 정산내역 (2).csv",
    ]) {
      const response = await download(path, true);
      expect(response.status).toBe(200);
      expect({
        path,
        disposition: response.headers.get("content-disposition")?.split(";")[0],
      }).toEqual({ path, disposition: "attachment" });
      expect(headersOf(response)).toMatchObject(ALWAYS);
    }
  });

  test("a name that says picture over bytes that are not one is saved, not drawn", async () => {
    const { download } = surface();
    for (const path of [
      // A page of script called a picture: the reason the bytes are looked at.
      "disguised.png",
      // A real picture, of another kind than its name says: the name is still a claim the file breaks.
      "wrong-picture.gif",
      // And a real picture under a name that is not a picture's: the reason the name is.
      "mislabelled.csv",
    ]) {
      const response = await download(path, true);
      expect({
        path,
        disposition: response.headers.get("content-disposition")?.split(";")[0],
      }).toEqual({ path, disposition: "attachment" });
    }
  });

  test("writes no row, and the same picture saved writes one", async () => {
    // The card draws its picture again every time the conversation is opened; a row for each
    // would bury the downloads. What is recorded is the file leaving as a file.
    const { download, rows } = surface();

    await download("chart.png", true);
    expect(rows).toEqual([]);

    await download("chart.png");
    await download("disguised.png", true);
    expect(rows.map((row) => [row.eventType, row.payload.file])).toEqual([
      ["computer.file_downloaded", "chart.png"],
      // Asked for as a preview and not one: a download, and recorded as one.
      ["computer.file_downloaded", "disguised.png"],
    ]);
  });
});

describe("a file that is not handed over", () => {
  test("somebody else's Bot is refused before the computer is asked anything", async () => {
    const { app, asked, rows } = surface();

    for (const path of [
      "/bot-2/files",
      "/bot-2/files/info?path=notes.md",
      "/bot-2/files/download?path=notes.md",
      "/bot-2/files/download?path=chart.png&inline=1",
    ]) {
      expect({ path, ...(await refusalOf(await app.request(path))) }).toEqual({
        path,
        status: 404,
        body: { error: "laf:bot_not_found", code: "laf:bot_not_found" },
      });
    }
    expect(asked).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("a path out of the folder is the computer's refusal, as the fact it sends", async () => {
    const { app, rows } = surface();
    for (const path of ["../outside/secret.txt", "/etc/passwd", "a/../../b"]) {
      for (const door of ["info", "download"]) {
        const response = await app.request(
          `/bot-1/files/${door}?path=${encodeURIComponent(path)}`,
        );
        expect({ door, path, ...(await refusalOf(response)) }).toEqual({
          door,
          path,
          status: 403,
          body: {
            error: "laf:file_path_refused",
            code: "laf:file_path_refused",
          },
        });
      }
    }
    // Nothing left, so nothing is recorded as having left.
    expect(rows).toEqual([]);
  });

  test("a file that is gone is a 404 with the computer's own code, on both doors", async () => {
    const { app } = surface();
    for (const door of ["info", "download"]) {
      expect(
        await refusalOf(
          await app.request(`/bot-1/files/${door}?path=gone.txt`),
        ),
      ).toEqual({
        status: 404,
        body: { error: "laf:file_not_found", code: "laf:file_not_found" },
      });
    }
  });

  test("a folder, a file too large and a computer that is away each say which", async () => {
    const { app } = surface();
    expect(
      await refusalOf(
        await app.request(
          `/bot-1/files/download?path=${encodeURIComponent("보고서")}`,
        ),
      ),
    ).toEqual({
      status: 400,
      body: { error: "laf:file_wrong_kind", code: "laf:file_wrong_kind" },
    });
    expect(
      await refusalOf(await app.request("/bot-1/files/download?path=huge.bin")),
    ).toEqual({
      status: 400,
      body: { error: "laf:file_too_large", code: "laf:file_too_large" },
    });

    const away = surface({ unreachable: true });
    for (const path of [
      "/bot-1/files",
      "/bot-1/files/info?path=notes.md",
      "/bot-1/files/download?path=notes.md",
    ]) {
      expect({
        path,
        ...(await refusalOf(await away.app.request(path))),
      }).toEqual({
        path,
        status: 503,
        body: {
          error: "laf:computer_unreachable",
          code: "laf:computer_unreachable",
        },
      });
    }
  });

  test("a request that names no file is refused before the computer is asked", async () => {
    const { app, asked } = surface();
    for (const path of [
      "/bot-1/files/info",
      "/bot-1/files/info?path=",
      "/bot-1/files/download",
      "/bot-1/files/download?path=%20%20",
    ]) {
      expect({ path, ...(await refusalOf(await app.request(path))) }).toEqual({
        path,
        status: 400,
        body: {
          error: "laf:tool_arguments_invalid",
          code: "laf:tool_arguments_invalid",
        },
      });
    }
    expect(asked).toEqual([]);
  });
});

describe("behind the app's own header middleware", () => {
  /*
   * `app.ts` mounts one middleware in front of every route that fills in a policy where a response
   * has none (`middleware/security.ts`): `default-src 'none'; frame-ancestors…` for an API answer.
   * A file's policy is a different sentence — `sandbox` is the half that takes its origin away —
   * and it has to be the one that leaves.
   */
  test("a file leaves with the policy its route gave it, and a refusal with the API's", async () => {
    const { app } = surface();
    const door = new Hono();
    door.use("*", createSecurityMiddleware());
    door.route("/api/computers", app);

    const file = await door.request(
      "/api/computers/bot-1/files/download?path=page.html&inline=1",
    );
    expect(file.status).toBe(200);
    expect(headersOf(file)).toEqual({
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename*=UTF-8''page.html",
      ...ALWAYS,
    });
    // And what the origin says about everything it serves is said about a file too.
    expect(file.headers.get("x-frame-options")).toBe("DENY");

    const gone = await door.request(
      "/api/computers/bot-1/files/download?path=gone.txt",
    );
    expect(gone.status).toBe(404);
    expect(gone.headers.get("content-security-policy")).toBe(API_CSP);
  });
});

describe("one file's facts", () => {
  test("are that it is a file and how big, never read to find out", async () => {
    const { app, asked, rows } = surface();

    const response = await app.request(
      `/bot-1/files/info?path=${encodeURIComponent("보고서/9월 정산내역 (2).csv")}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      path: "보고서/9월 정산내역 (2).csv",
      kind: "file",
      bytes: text(CONTENTS).byteLength,
    });
    // Asked of the computer as facts, not as a download, and a look leaves no row.
    expect(asked).toEqual(["stat 보고서/9월 정산내역 (2).csv"]);
    expect(rows).toEqual([]);
  });
});

describe("the folder, as the person is shown it", () => {
  test("is the Bot's own listing without anything hidden", async () => {
    const { app, asked, rows } = surface();

    const response = await app.request("/bot-1/files");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: ".",
      entries: [
        { path: "notes.md", kind: "file", bytes: 8 },
        { path: "보고서", kind: "folder" },
        { path: "보고서/9월 정산내역 (2).csv", kind: "file", bytes: 33 },
      ],
      truncated: false,
    });
    expect(asked).toEqual(["list ."]);
    // A read, and not a Bot's: no policy was asked and nothing is written.
    expect(rows).toEqual([]);
  });

  test("names the folder it was asked for, and says when the walk ran out", async () => {
    const { app, asked } = surface({ truncated: true });

    const response = await app.request(
      `/bot-1/files?path=${encodeURIComponent("보고서")}`,
    );

    expect(await response.json()).toMatchObject({
      path: "보고서",
      truncated: true,
    });
    expect(asked).toEqual(["list 보고서"]);
  });

  test("a folder that is not there is a 404, like a file that is not", async () => {
    const { app } = surface();
    expect(
      await refusalOf(await app.request("/bot-1/files?path=nowhere")),
    ).toEqual({
      status: 404,
      body: { error: "laf:file_not_found", code: "laf:file_not_found" },
    });
  });
});
