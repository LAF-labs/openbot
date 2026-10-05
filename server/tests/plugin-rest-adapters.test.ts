import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TOOL_RESULT_CUT } from "../../shared/spillover";
import * as cafe24 from "../src/plugins/cafe24-rest";
import { CATALOGUE, catalogueEntry } from "../src/plugins/catalogue";
import * as gmail from "../src/plugins/gmail-rest";
import * as business from "../src/plugins/google-business-rest";
import * as calendar from "../src/plugins/google-calendar-rest";
import { definitionHashOf } from "../src/plugins/laf-contract";
import * as drive from "../src/plugins/google-drive-rest";
import * as sheets from "../src/plugins/google-sheets-rest";
import { transportFor } from "../src/plugins/transport";
import { stubFetch } from "./support/fetch";

/**
 * The five REST adapters, against the shapes their vendors actually answer with.
 *
 * NO LIVE VENDOR, and that is a decision rather than a convenience. A suite that reached Google
 * would depend on somebody else's uptime, on a grant nobody in CI holds, and on a quota; one that
 * reached Cafe24 would need a mall. What is worth pinning here does not need a vendor anyway,
 * because it is all on THIS side of the wire: which URL is built, which parameters go with it, and
 * — the half that decides what a Bot then says — what a person's answer reads like when the vendor
 * refuses.
 *
 * The error case is in every describe for one reason. `asResult("")` exists because an empty tool
 * result reads to a model as "nothing to report" and gets filled in from memory; a refusal that
 * came back as an empty success would be the same failure with a worse cause. So each adapter is
 * asked what it says when the vendor says no, and the answer has to be `isError` AND carry the
 * vendor's own sentence, which is where Google names the API that is not switched on.
 */

type Asked = { url: URL; method: string; body: unknown; headers: Headers };

let asked: Asked[] = [];
let realFetch: typeof fetch;

/** What the next vendor call answers with. Replaced per test. */
let reply: (asked: Asked) => Response = () => json({});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  asked = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url, init) => {
    const record: Asked = {
      url: new URL(String(url)),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    asked.push(record);
    return reply(record);
  });
});

afterEach(() => {
  // A leaked global would silently answer every later file in the run.
  globalThis.fetch = realFetch;
  reply = () => json({});
});

/** A vendor that refuses, in the shape Google and Cafe24 both use for it. */
const refuses = (status: number, message: string) => () =>
  json({ error: { message } }, status);

const connectionTo = (url: string) => ({ url, token: "at" });

/* ── the seam every entry is reached through ─────────────────────────────────────────────────── */

describe("the transport registry", () => {
  test("every catalogue entry resolves to a transport that exists", () => {
    // The union is closed, so this cannot fail at compile time — but an entry naming a transport
    // the registry forgot would fail at the first tool call, on somebody's screen.
    for (const entry of CATALOGUE) {
      // The two functions every caller reaches for, not merely a value: a registry entry pointing at
      // the wrong module is defined and still fails at the first call.
      const transport = transportFor(entry);
      expect(typeof transport?.listTools).toBe("function");
      expect(typeof transport?.callTool).toBe("function");
      expect(typeof transport?.listNeedsCredential).toBe("boolean");
    }
  });

  test("a curated REST adapter's tool list needs nobody's credential", () => {
    // The list is this repository, not an answer from a server. Assumed otherwise, configuring one
    // sent an administrator to their own settings page to mint a token that is then discarded.
    for (const key of [
      "google-sheets",
      "gmail",
      "google-calendar",
      "google-business-profile",
      "cafe24",
    ]) {
      expect(transportFor(catalogueEntry(key)!).listNeedsCredential).toBe(
        false,
      );
    }
  });

  test("no adapter annotates its own tools, because the catalogue is the reviewed word", async () => {
    // Two sources for one decision, and the one a reader would trust is the one that does nothing:
    // `call.ts` reads the floor from `guardedTools`, so an annotation written here would decide
    // nothing while looking like it did.
    for (const module of [sheets, gmail, calendar, business, cafe24]) {
      const tools = await module.listTools({ url: "https://example.test" });
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.annotations).toBeNull();
      }
    }
    for (const key of [
      "google-sheets",
      "gmail",
      "google-calendar",
      "google-business-profile",
      "cafe24",
    ]) {
      const entry = catalogueEntry(key)!;
      // Every guarded name is one the adapter actually implements, and every guard is one of the
      // four a person can be shown a sentence for.
      for (const [name, guard] of Object.entries(entry.guardedTools ?? {})) {
        expect(entry.writeTools).toContain(name);
        expect(["money", "external", "destructive", "unannotated"]).toContain(
          guard,
        );
      }
    }
  });
});

/* ── Google Sheets ───────────────────────────────────────────────────────────────────────────── */

describe("Google Sheets", () => {
  const connection = connectionTo(
    "https://sheets.googleapis.com/v4/spreadsheets",
  );

  test("an append goes to the tab's append endpoint, entered the way a person would type it", async () => {
    reply = () => json({ updates: { updatedRange: "주문!A7:C7" } });

    const result = await sheets.callTool(connection, "append_sheet_row", {
      // A link, because that is what a person hands a Bot. The id is pulled out of it.
      spreadsheetId:
        "https://docs.google.com/spreadsheets/d/1AbC-dEf_2/edit#gid=0",
      range: "주문",
      values: ["2026-09-04", "김", 3],
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("주문!A7:C7");
    expect(asked[0]?.url.pathname).toBe(
      "/v4/spreadsheets/1AbC-dEf_2/values/%EC%A3%BC%EB%AC%B8:append",
    );
    expect(asked[0]?.method).toBe("POST");
    // USER_ENTERED so 010-… stays a phone number; INSERT_ROWS so nothing below the table is
    // overwritten by an append.
    expect(asked[0]?.url.searchParams.get("valueInputOption")).toBe(
      "USER_ENTERED",
    );
    expect(asked[0]?.url.searchParams.get("insertDataOption")).toBe(
      "INSERT_ROWS",
    );
    // Every cell as a string, including the number: Sheets is told to parse what a person typed,
    // so sending `3` as JSON and sending "3" reach the same cell, and one shape is easier to say
    // is right at a glance.
    expect(asked[0]?.body).toEqual({ values: [["2026-09-04", "김", "3"]] });
  });

  test("a read says out loud that it truncated", async () => {
    reply = () => json({ values: [["a"], ["b"], ["c"]] });

    const result = await sheets.callTool(connection, "read_sheet_values", {
      spreadsheetId: "sheet-1",
      range: "주문",
      maxRows: 2,
    });

    // A truncated read that reads like a complete one is how a Bot answers "이게 전부야" about
    // half a sheet.
    expect(result.text).toContain("3행 중 2행");
  });

  test("a refusal carries Google's own sentence, not a shrug", async () => {
    reply = refuses(
      403,
      "Google Sheets API has not been used in project 123 before or it is disabled.",
    );

    const result = await sheets.callTool(connection, "list_sheet_tabs", {
      spreadsheetId: "sheet-1",
    });

    expect(result.isError).toBe(true);
    // The 403 is where Google names the API that is switched off and gives the console URL, which
    // is the difference between a fix and a guess.
    expect(result.text).toContain("403");
    expect(result.text).toContain("has not been used in project");
  });
});

/* ── Gmail ───────────────────────────────────────────────────────────────────────────────────── */

describe("Gmail", () => {
  const connection = connectionTo(
    "https://gmail.googleapis.com/gmail/v1/users/me",
  );

  test("a send posts the RFC 2047 encoded mail, not a draft", async () => {
    reply = () => json({ id: "msg-1" });

    const result = await gmail.callTool(connection, "send_message", {
      to: "shop@example.com",
      subject: "주문 확인",
      body: "안녕하세요",
    });

    expect(result.isError).toBe(false);
    expect(asked[0]?.url.pathname).toBe("/gmail/v1/users/me/messages/send");
    const raw = (asked[0]?.body as { raw: string } | undefined)?.raw ?? "";
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    // A Korean subject on a raw header is what every mail client disagrees about unless it is
    // encoded; the address and the body are not.
    expect(mime).toContain("=?UTF-8?B?");
    expect(mime).toContain("shop@example.com");
  });

  test("a draft goes somewhere else entirely, which is the whole difference", async () => {
    reply = () => json({ id: "draft-1" });

    await gmail.callTool(connection, "create_draft", {
      to: "shop@example.com",
      subject: "hi",
      body: "hello",
    });

    // A draft stays in the person's own mailbox; a send leaves and cannot be recalled. Only one of
    // the two is guarded `external`, so posting a draft to the send endpoint would be the boundary
    // asking about the wrong thing.
    expect(asked[0]?.url.pathname).toBe("/gmail/v1/users/me/drafts");
    expect(asked[0]?.body).toEqual({ message: { raw: expect.any(String) } });
  });

  test("a search with nothing to show says so rather than answering empty", async () => {
    reply = () => json({ messages: [] });

    const result = await gmail.callTool(connection, "search_messages", {
      query: "무언가",
    });

    // An empty string reads to a model as "the tool had nothing to say" and gets filled in from
    // memory, which for a mailbox search is the exact failure this connector exists to prevent.
    expect(result.isError).toBe(false);
    // And it says what was searched for: nothing for this search is not an empty mailbox.
    expect(result.text).toBe(
      '[검색어 "무언가" · 0통]\n이 검색에 맞는 메일이 없습니다.',
    );
  });

  test("a search's first line says what was searched for, so a list nobody chose the query of can be read", async () => {
    // A turn's first step calls this with a query of its own (`turns/first-move.ts`): the Bot's
    // model is handed the list without having written "unread, in the inbox".
    globalThis.fetch = stubFetch(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/messages")) return json({ messages: [{ id: "m1" }] });
      return json({
        id: "m1",
        payload: { headers: [{ name: "Subject", value: "견적서" }] },
      });
    });
    const unread = await gmail.callTool(connection, "search_messages", {
      query: "is:unread in:inbox",
    });
    expect(unread.text.split("\n")[0]).toBe(
      '[검색어 "is:unread in:inbox" · 1통]',
    );
    const recent = await gmail.callTool(connection, "search_messages", {});
    expect(recent.text.split("\n")[0]).toBe(
      "[검색어 없이 최근 메일부터 · 1통]",
    );
  });

  test("a refusal is a refusal, and it names the status", async () => {
    reply = refuses(429, "User-rate limit exceeded.");

    const result = await gmail.callTool(connection, "search_messages", {
      query: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("429");
  });

  /*
   * THE N+1, BOUNDED (audit 2026-09-10, A9 F7). Gmail's list answers ids and nothing else, so a
   * search is one list and up to fifty reads. One after another, at a 40 ms round trip, fifty took
   * 2,157 ms; each allowed its own thirty seconds, the worst case was twenty-five minutes in a chat
   * turn nothing else bounds.
   */
  test("a search reads the headers six at a time, in the order Gmail listed them", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `m${index}`);
    let inFlight = 0;
    let peak = 0;
    globalThis.fetch = stubFetch(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/messages")) {
        return json({ messages: ids.map((id) => ({ id })) });
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(40);
      inFlight -= 1;
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      return json({
        id,
        payload: { headers: [{ name: "Subject", value: `제목 ${id}` }] },
      });
    });
    const started = Date.now();

    const result = await gmail.callTool(connection, "search_messages", {
      max: 50,
    });

    const elapsed = Date.now() - started;
    expect(result.isError).toBe(false);
    // The first line is what was searched for; the fifty are under it.
    const [said, ...lines] = result.text.split("\n");
    expect(said).toBe("[검색어 없이 최근 메일부터 · 50통]");
    expect(lines).toHaveLength(50);
    // Gmail's order, not the order the reads happened to finish in.
    expect(lines[0]).toContain("제목 m0");
    expect(lines[49]).toContain("제목 m49");
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
    // Fifty serial reads at 40 ms would be two seconds; nine rounds of six is under half of one.
    expect(elapsed).toBeLessThan(1_500);
    // Nothing was cut short, so nothing says so.
    expect(result.text).not.toContain("통만 읽었습니다");
  });

  test("one deadline bounds the whole search, and the answer says once what it is missing", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `m${index}`);
    globalThis.fetch = stubFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/messages")) {
        return json({ messages: ids.map((id) => ({ id })) });
      }
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      if (Number(id.slice(1)) < 3) {
        return json({
          id,
          payload: { headers: [{ name: "Subject", value: `제목 ${id}` }] },
        });
      }
      // A vendor that never answers, until the call's own deadline lets go of the request.
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const started = Date.now();

    const result = await gmail.callTool(
      connection,
      "search_messages",
      { max: 50 },
      { deadlineMs: 200 },
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.isError).toBe(false);
    // What was read is the answer, and the one note says how much was not.
    expect(result.text).toContain("제목 m0");
    expect(result.text).toContain("50통 중 3통만 읽었습니다");
    expect(result.text.split("통만 읽었습니다")).toHaveLength(2);
  });
});

/* ── Google Drive ────────────────────────────────────────────────────────────────────────────── */

/*
 * THE FIRST ADAPTER, LAST TO JOIN THE SHARED SHAPE (audit 2026-09-10, A9 F6). Drive kept private
 * copies of the request helper from before `rest-support.ts` existed, and the copies had drifted on
 * the two details that matter: it followed a redirect with somebody's token on the request, and it
 * parsed a 200 unguarded, so Google's maintenance page threw a `SyntaxError` out of the tool call.
 */
describe("Google Drive", () => {
  const connection = connectionTo("https://www.googleapis.com/drive/v3");

  test("a search escapes the quote and asks for the fields a citation needs", async () => {
    reply = () =>
      json({
        files: [
          {
            id: "f1",
            name: "메뉴판 [2026]",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-09-01T00:00:00Z",
            webViewLink: "https://docs.google.com/document/d/f1",
          },
        ],
      });

    const result = await drive.callTool(connection, "search_files", {
      query: "don't",
    });

    expect(result.isError).toBe(false);
    expect(asked[0]?.url.pathname).toBe("/drive/v3/files");
    // An apostrophe would otherwise end the clause; escaped, a term is only ever a term.
    expect(asked[0]?.url.searchParams.get("q")).toContain("don\\'t");
    expect(asked[0]?.url.searchParams.get("fields")).toContain("webViewLink");
    // A link a reader can click, with the bracket in the name kept out of the link syntax.
    expect(result.text).toContain(
      "[메뉴판 \\[2026\\]](https://docs.google.com/document/d/f1)",
    );
    expect(result.text).toContain("id: f1");
  });

  test("a Doc is exported as text rather than downloaded", async () => {
    reply = (request) =>
      request.url.pathname.endsWith("/export")
        ? new Response("본문", { headers: { "content-type": "text/plain" } })
        : json({
            id: "f1",
            name: "기획서",
            mimeType: "application/vnd.google-apps.document",
          });

    const result = await drive.callTool(connection, "read_file_content", {
      fileId: "f1",
    });

    expect(result.isError).toBe(false);
    expect(asked[1]?.url.pathname).toBe("/drive/v3/files/f1/export");
    expect(asked[1]?.url.searchParams.get("mimeType")).toBe("text/plain");
    expect(result.text).toContain("기획서");
    expect(result.text).toContain("본문");
  });

  /*
   * THE TRASH IS LEFT OUT OF BOTH LISTINGS (upstream OpenBot #588).
   *
   * `files.list` returns trashed files unless the query says otherwise, so a document somebody had
   * thrown away came back as a match, or as a recent file, with nothing in its line to say so.
   */
  test("a search leaves the trash out, for both halves of its `or`", async () => {
    reply = () => json({ files: [] });
    await drive.callTool(connection, "search_files", { query: "don't ship" });

    // Bracketed, so the trash is left out of a match by name as well as of one by content.
    expect(asked[0]?.url.searchParams.get("q")).toBe(
      "(name contains 'don\\'t ship' or fullText contains 'don\\'t ship') and trashed = false",
    );
  });

  test("recent files are ordered by Drive, and filtered only by the trash", async () => {
    reply = () => json({ files: [] });
    await drive.callTool(connection, "list_recent_files", {});

    expect(asked[0]?.url.searchParams.get("orderBy")).toBe("modifiedTime desc");
    expect(asked[0]?.url.searchParams.get("q")).toBe("trashed = false");
  });

  /*
   * A FILE IN A SHARED DRIVE IS REACHED LIKE ONE IN MY DRIVE (upstream OpenBot #589).
   *
   * Drive leaves shared drive items out of any `files.get` or `files.list` that does not say it
   * supports them: a document the person could open was "File not found" by its id and in no
   * search. Shared drives are where a company keeps its documents, so that is most of them.
   */
  test("both listings ask Drive for the items in shared drives", async () => {
    reply = () => json({ files: [] });
    await drive.callTool(connection, "search_files", { query: "roadmap" });
    await drive.callTool(connection, "list_recent_files", {});

    expect(asked).toHaveLength(2);
    for (const request of asked) {
      expect(request.url.searchParams.get("supportsAllDrives")).toBe("true");
      expect(request.url.searchParams.get("includeItemsFromAllDrives")).toBe(
        "true",
      );
    }
  });

  test("a look by id says shared drives are supported: the file, a shortcut's target, the download", async () => {
    reply = () => json({ id: "s1", name: "Plan" });
    await drive.callTool(connection, "get_file_metadata", { fileId: "s1" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url.searchParams.get("supportsAllDrives")).toBe("true");

    asked = [];
    reply = (request) => {
      if (request.url.searchParams.get("alt") === "media") {
        return new Response("notes", {
          headers: { "content-type": "text/plain" },
        });
      }
      return request.url.pathname === "/drive/v3/files/shortcut2"
        ? json({
            id: "shortcut2",
            name: "notes 바로가기",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: { targetId: "s2", targetMimeType: "text/plain" },
          })
        : json({ id: "s2", name: "notes.txt", mimeType: "text/plain" });
    };
    const read = await drive.callTool(connection, "read_file_content", {
      fileId: "shortcut2",
    });

    expect(read.text).toBe("notes.txt\n\nnotes");
    expect(asked.map((one) => one.url.pathname)).toEqual([
      "/drive/v3/files/shortcut2",
      "/drive/v3/files/s2",
      "/drive/v3/files/s2",
    ]);
    for (const request of asked) {
      expect(request.url.searchParams.get("supportsAllDrives")).toBe("true");
    }
  });

  test("an export is asked for as before: `files.export` takes a type and nothing else", async () => {
    reply = (request) =>
      request.url.pathname.endsWith("/export")
        ? new Response("본문", { headers: { "content-type": "text/plain" } })
        : json({
            id: "f1",
            name: "기획서",
            mimeType: "application/vnd.google-apps.document",
          });

    await drive.callTool(connection, "read_file_content", { fileId: "f1" });

    expect([...(asked[1]?.url.searchParams.keys() ?? [])]).toEqual([
      "mimeType",
    ]);
  });

  test("a shortcut is followed to the file it points at, once", async () => {
    // Search and the recent list return shortcuts as ordinary hits; reading one by its own id was
    // declined as a binary `application/vnd.google-apps.shortcut` (upstream OpenBot #618).
    reply = (request) => {
      const path = request.url.pathname;
      if (path === "/drive/v3/files/shortcut1") {
        return json({
          id: "shortcut1",
          name: "기획서 바로가기",
          mimeType: "application/vnd.google-apps.shortcut",
          shortcutDetails: {
            targetId: "doc9",
            targetMimeType: "application/vnd.google-apps.document",
          },
        });
      }
      if (path === "/drive/v3/files/doc9") {
        return json({
          id: "doc9",
          name: "기획서",
          mimeType: "application/vnd.google-apps.document",
        });
      }
      if (path === "/drive/v3/files/doc9/export") {
        return new Response("본문", {
          headers: { "content-type": "text/plain" },
        });
      }
      return json({}, 404);
    };

    const result = await drive.callTool(connection, "read_file_content", {
      fileId: "shortcut1",
    });

    expect(result.isError).toBe(false);
    expect(asked.map((one) => one.url.pathname)).toEqual([
      "/drive/v3/files/shortcut1",
      "/drive/v3/files/doc9",
      "/drive/v3/files/doc9/export",
    ]);
    // The pointer's own details are asked for with the type, so no second look is needed to follow it.
    expect(asked[0]?.url.searchParams.get("fields")).toContain(
      "shortcutDetails",
    );
    // Named as the file that was read, not as the shortcut.
    expect(result.text).toBe("기획서\n\n본문");
  });

  test("a shortcut to a shortcut, or to nothing, is declined rather than walked", async () => {
    reply = (request) =>
      request.url.pathname === "/drive/v3/files/a"
        ? json({
            id: "a",
            name: "돌고 도는 바로가기",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: { targetId: "b" },
          })
        : json({
            id: "b",
            name: "또 바로가기",
            mimeType: "application/vnd.google-apps.shortcut",
            shortcutDetails: { targetId: "a" },
          });
    const looped = await drive.callTool(connection, "read_file_content", {
      fileId: "a",
    });
    expect(looped.isError).toBe(true);
    expect(looped.text).toContain("application/vnd.google-apps.shortcut");
    // Two looks and no more: a loop is not a document.
    expect(asked).toHaveLength(2);

    asked = [];
    reply = () =>
      json({
        id: "c",
        name: "빈 바로가기",
        mimeType: "application/vnd.google-apps.shortcut",
      });
    const empty = await drive.callTool(connection, "read_file_content", {
      fileId: "c",
    });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("does not name a file");
    expect(asked).toHaveLength(1);
  });

  test("a binary file is declined by name, not decoded and hoped for", async () => {
    reply = () => json({ id: "f2", name: "사진.png", mimeType: "image/png" });

    const result = await drive.callTool(connection, "read_file_content", {
      fileId: "f2",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("image/png");
    expect(asked).toHaveLength(1);
  });

  /*
   * ONLY THE OPENING OF A LONG FILE IS SHOWN, SO ONLY THE OPENING IS READ (upstream OpenBot #595).
   *
   * The whole download used to be held as one string before all but its first 20,000 characters
   * were dropped. The body here counts what is pulled from it, so reading it to the end fails; and
   * the answer is held to the two things a cut at a byte count gets wrong — half a Korean character
   * and half an emoji — because 한글 is three bytes a character and a chunk ends where it likes.
   */
  /** A file's bytes handed over a piece at a time, counting what was asked for. */
  function served(bytes: Uint8Array, pieceBytes: number) {
    const counted = { pulled: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (counted.pulled >= bytes.length) {
          controller.close();
          return;
        }
        const piece = bytes.subarray(
          counted.pulled,
          counted.pulled + pieceBytes,
        );
        counted.pulled += piece.length;
        controller.enqueue(piece);
      },
    });
    return { counted, body };
  }

  /** The note a cut answer ends with. It claims no length: nobody read far enough to know one. */
  const MORE =
    "\n\n[truncated: only the opening is shown, and there is more after it]";

  test("a file far longer than one result is not downloaded whole", async () => {
    const megabyte = 1024 * 1024;
    const bytes = new TextEncoder().encode(
      `${"x".repeat(1023)}\n`.repeat(16 * 1024),
    );
    const { counted, body } = served(bytes, megabyte);
    // `as … | null`, or TypeScript narrows a value assigned only inside the stub to `null`.
    let download = null as AbortSignal | null;
    globalThis.fetch = stubFetch(async (url, init) => {
      if (new URL(String(url)).searchParams.get("alt") !== "media") {
        return json({ id: "log1", name: "big.log", mimeType: "text/plain" });
      }
      download = init?.signal ?? null;
      return new Response(body, { headers: { "content-type": "text/plain" } });
    });

    const result = await drive.callTool(connection, "read_file_content", {
      fileId: "log1",
    });

    expect(bytes.length).toBe(16 * megabyte);
    // A piece or two, never the sixteen.
    expect(counted.pulled).toBeLessThanOrEqual(4 * megabyte);
    /*
     * And the REQUEST is ended, which a stub cannot feel and a vendor can. Measured on Bun 1.3.11
     * against a real server: with only the body's reader cancelled the far end sent 14 MB in the
     * next six seconds, thrown away on arrival; with the request aborted it stopped within 80 ms.
     */
    expect(download?.aborted).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith(`big.log\n\n${"x".repeat(1023)}\n`)).toBe(
      true,
    );
    expect(result.text.endsWith(MORE)).toBe(true);
    // The note is inside what the Bot is shown. A result over this is filed and shown by its head
    // (`shared/spillover.ts`), which would put the one sentence that says "there is more" out of sight.
    expect(result.text.length).toBeLessThanOrEqual(TOOL_RESULT_CUT);
  });

  test("the opening of a Korean file ends on a whole character", async () => {
    // 1,000 bytes a piece and three bytes a character: every piece but one ends inside a 가.
    const { body } = served(
      new TextEncoder().encode("가".repeat(30_000)),
      1000,
    );
    reply = (request) =>
      request.url.searchParams.get("alt") === "media"
        ? new Response(body, { headers: { "content-type": "text/plain" } })
        : json({ id: "f3", name: "메모.txt", mimeType: "text/plain" });

    const result = await drive.callTool(connection, "read_file_content", {
      fileId: "f3",
    });

    const heading = "메모.txt\n\n";
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(MORE)).toBe(true);
    const shown = result.text.slice(heading.length, -MORE.length);
    // Nothing replaced, nothing halved: only 가, and as many as fit beside the heading and the note.
    expect(shown).toBe("가".repeat(shown.length));
    expect(shown.length).toBe(TOOL_RESULT_CUT - heading.length - MORE.length);
  });

  test("and never on half of an emoji, wherever the cut falls", async () => {
    // Two code units each, so the cut lands inside one for a name of one parity and between two for
    // the other. Both are read, because which is which depends on the note's own length.
    for (const name of ["a.txt", "ab.txt"]) {
      const { body } = served(
        new TextEncoder().encode("😀".repeat(15_000)),
        1000,
      );
      reply = (request) =>
        request.url.searchParams.get("alt") === "media"
          ? new Response(body, { headers: { "content-type": "text/plain" } })
          : json({ id: "f4", name, mimeType: "text/plain" });

      const result = await drive.callTool(connection, "read_file_content", {
        fileId: "f4",
      });

      expect(result.truncated).toBe(true);
      // Half of a surrogate pair is not a character. Before this change the first name ended on one.
      expect(result.text.isWellFormed()).toBe(true);
      const shown = result.text.slice(`${name}\n\n`.length, -MORE.length);
      expect(shown).toBe("😀".repeat(shown.length / 2));
      expect(result.text.length).toBeLessThanOrEqual(TOOL_RESULT_CUT);
      expect(result.text.length).toBeGreaterThanOrEqual(TOOL_RESULT_CUT - 1);
    }
  });

  test("a download with no body at all reads as an empty file", async () => {
    reply = (request) =>
      request.url.searchParams.get("alt") === "media"
        ? new Response(null)
        : json({ id: "f5", name: "empty.txt", mimeType: "text/plain" });

    const result = await drive.callTool(connection, "read_file_content", {
      fileId: "f5",
    });

    expect(result).toEqual({
      text: "empty.txt",
      isError: false,
      truncated: false,
    });
  });

  test("a redirect is refused rather than followed, with somebody's token on the request", async () => {
    // Measured: a 302 to another origin had THAT origin's file list read back as Drive's answer.
    let sawRedirectManual = false;
    globalThis.fetch = stubFetch(async (_url, init) => {
      sawRedirectManual = init?.redirect === "manual";
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/files" },
      });
    });

    const result = await drive.callTool(connection, "list_recent_files", {});

    expect(sawRedirectManual).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("302");
  });

  test("a 200 that is not JSON is a refusal, not a crash", async () => {
    // Google's maintenance page. This used to escape as `SyntaxError: Failed to parse JSON`, filed
    // as `mcp.call_failed` and shown to a person as a 502 in English.
    reply = () =>
      new Response("<html>maintenance</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    const result = await drive.callTool(connection, "get_file_metadata", {
      fileId: "f1",
    });

    expect(result.isError).toBe(true);
  });

  test("a refusal carries Google's sentence and the status behind it", async () => {
    reply = refuses(
      403,
      "Google Drive API has not been used in project 123 before or it is disabled.",
    );

    const result = await drive.callTool(connection, "list_recent_files", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("has not been used in project");
    expect(result.status).toBe(403);
  });

  test("a tool the stored list still names, that this connector does not have, says so", async () => {
    const result = await drive.callTool(connection, "delete_everything", {});

    expect(result.isError).toBe(true);
    expect(asked).toHaveLength(0);
  });
});

/* ── Google Calendar ─────────────────────────────────────────────────────────────────────────── */

describe("Google Calendar", () => {
  const connection = connectionTo("https://www.googleapis.com/calendar/v3");

  test("an event with attendees tells Google to mail them; one without does not", async () => {
    reply = () =>
      json({
        summary: "미팅",
        start: { dateTime: "2026-09-05T10:00:00+09:00" },
      });

    await calendar.callTool(connection, "create_event", {
      summary: "미팅",
      start: "2026-09-05T10:00:00+09:00",
      end: "2026-09-05T11:00:00+09:00",
      attendees: ["a@example.com"],
    });
    expect(asked[0]?.url.searchParams.get("sendUpdates")).toBe("all");

    asked = [];
    await calendar.callTool(connection, "create_event", {
      summary: "혼자",
      start: "2026-09-05T10:00:00+09:00",
      end: "2026-09-05T11:00:00+09:00",
    });
    // `all` on an event with nobody to tell is a parameter that does nothing; `none` is the honest
    // value and keeps the two cases apart.
    expect(asked[0]?.url.searchParams.get("sendUpdates")).toBe("none");
  });

  test("the time carries its own offset, and no time zone is invented beside it", async () => {
    reply = () => json({});

    await calendar.callTool(connection, "create_event", {
      summary: "미팅",
      start: "2026-09-05T10:00:00+09:00",
      end: "2026-09-05T11:00:00+09:00",
    });

    const body = asked[0]?.body as {
      start: Record<string, unknown>;
      end: Record<string, unknown>;
    };
    expect(body.start).toEqual({ dateTime: "2026-09-05T10:00:00+09:00" });
    // A `timeZone` beside an offset is how an event lands an hour out on a server clocked in UTC.
    expect(body.start.timeZone).toBeUndefined();
    expect(body.end.timeZone).toBeUndefined();
  });

  test("a listing expands repeats, because that is what a person means by a week", async () => {
    reply = () => json({ items: [] });

    await calendar.callTool(connection, "list_events", { days: 3 });

    // Both together: without `singleEvents` a weekly meeting is one rule, and Calendar refuses to
    // order by start time unless it is expanding them.
    expect(asked[0]?.url.searchParams.get("singleEvents")).toBe("true");
    expect(asked[0]?.url.searchParams.get("orderBy")).toBe("startTime");
  });

  /*
   * "TODAY" IS THE PERSON'S DAY (2026-10-05). `days: 1` was the only way to ask and it means this
   * minute to the same minute tomorrow: at nine in the evening the day's earlier events were not
   * in it and tomorrow morning's were, and an empty evening read as a day with nothing on it.
   */
  const NINE_PM_SEOUL = () => new Date("2026-10-05T12:00:00Z");
  const seoul = { ...connection, timeZone: "Asia/Seoul" };

  test("day: today at nine in the evening is the whole local day — the morning in, tomorrow out", async () => {
    reply = () =>
      json({
        items: [
          {
            id: "e1",
            summary: "치과",
            start: { dateTime: "2026-10-05T09:30:00+09:00" },
            end: { dateTime: "2026-10-05T10:00:00+09:00" },
          },
          {
            id: "e2",
            summary: "창립기념일",
            start: { date: "2026-10-05" },
            end: { date: "2026-10-06" },
          },
        ],
      });

    const result = await calendar.callTool(
      seoul,
      "list_events",
      { day: "today" },
      NINE_PM_SEOUL,
    );

    // Midnight to midnight on the person's clock, which is 15:00 UTC the day before.
    expect(asked[0]?.url.searchParams.get("timeMin")).toBe(
      "2026-10-04T15:00:00.000Z",
    );
    expect(asked[0]?.url.searchParams.get("timeMax")).toBe(
      "2026-10-05T15:00:00.000Z",
    );
    expect(result.text.split("\n")).toEqual([
      "[본 기간: 2026-10-05 00:00 ~ 2026-10-06 00:00 Asia/Seoul(KST) · 일정 2건]",
      "- 2026-10-05 09:30 ~ 2026-10-05 10:00 · 치과 · id: e1",
      // An all-day event is its date: converted, it would move a day in half the world's zones.
      "- 2026-10-05 (종일) ~ 2026-10-06 (종일) · 창립기념일 · id: e2",
    ]);
  });

  test("the same minute without `day` is still from now on, and says so — tomorrow morning is in it", async () => {
    reply = () =>
      json({
        items: [
          {
            id: "e3",
            summary: "납품 미팅",
            // Whatever offset Google answers in, the line is on the person's clock.
            start: { dateTime: "2026-10-05T23:00:00Z" },
            end: { dateTime: "2026-10-05T23:30:00Z" },
          },
        ],
      });

    const result = await calendar.callTool(
      seoul,
      "list_events",
      { days: 1 },
      NINE_PM_SEOUL,
    );

    expect(asked[0]?.url.searchParams.get("timeMin")).toBe(
      "2026-10-05T12:00:00.000Z",
    );
    expect(asked[0]?.url.searchParams.get("timeMax")).toBe(
      "2026-10-06T12:00:00.000Z",
    );
    expect(result.text.split("\n")).toEqual([
      "[본 기간: 2026-10-05 21:00 ~ 2026-10-06 21:00 Asia/Seoul(KST) · 일정 1건]",
      "- 2026-10-06 08:00 ~ 2026-10-06 08:30 · 납품 미팅 · id: e3",
    ]);
  });

  test("a day with nothing on it says which day had nothing, not that nothing was found", async () => {
    reply = () => json({ items: [] });

    const result = await calendar.callTool(
      seoul,
      "list_events",
      { day: "today" },
      NINE_PM_SEOUL,
    );

    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      "[본 기간: 2026-10-05 00:00 ~ 2026-10-06 00:00 Asia/Seoul(KST) · 일정 0건]\n이 기간에 캘린더에 잡힌 일정이 없습니다.",
    );
  });

  test("the day is the person's zone's, a clock change is still one day, and only today is a day", async () => {
    reply = () => json({ items: [] });
    const iso = (
      args: Record<string, unknown>,
      timeZone = "Asia/Seoul",
      now = NINE_PM_SEOUL(),
    ) => {
      const found = calendar.listingWindow(args, now, timeZone);
      return [found.from.toISOString(), found.until.toISOString()];
    };
    // 12:00 UTC is 16:00 in Dubai, the same calendar day, four hours from UTC.
    expect(iso({ day: "today" }, "Asia/Dubai")).toEqual([
      "2026-10-04T20:00:00.000Z",
      "2026-10-05T20:00:00.000Z",
    ]);
    // And 05:00 that morning in Los Angeles is still the 5th there.
    expect(iso({ day: "today" }, "America/Los_Angeles")).toEqual([
      "2026-10-05T07:00:00.000Z",
      "2026-10-06T07:00:00.000Z",
    ]);
    // A day a clock change made 23 hours long is one day: Berlin, the last Sunday of March.
    expect(
      iso({ day: "today" }, "Europe/Berlin", new Date("2026-03-29T10:00:00Z")),
    ).toEqual(["2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"]);
    // `day` is declared nowhere and reads one word. Anything else is `days`, as before it existed.
    const fromNow = ["2026-10-05T12:00:00.000Z", "2026-10-12T12:00:00.000Z"];
    for (const day of ["tomorrow", "2026-10-09", "내일", 5]) {
      expect(iso({ day })).toEqual(fromNow);
    }
    // No zone handed over is the product's default, never the machine's own.
    const unzoned = await calendar.callTool(
      connection,
      "list_events",
      { day: "today" },
      NINE_PM_SEOUL,
    );
    expect(unzoned.text).toContain("Asia/Seoul(KST)");
  });

  /*
   * A DEFINITION THAT CHANGES IS PAUSED FOR EVERYONE WHO HAS IT CONNECTED. `servers.ts` hashes each
   * tool's name, description, schema and annotations (`definitionHashOf`), and on the next refresh
   * of a server's tools a hash that differs from the stored one sets `needsReview` — the call is
   * refused (`laf:tool_needs_review`) until somebody reviews it. That is right for a vendor's
   * server and it applies to these too. So a change to any byte of a description or a schema here
   * is an act with a cost on every deployment where the calendar or the mail is connected, and it
   * is made by changing the hash below in the same commit, on purpose — which is why the calendar's
   * `day` is read and not declared (`listingWindow`). A result's text is not part of a definition.
   */
  test("the calendar's and the mail's definitions are the ones people consented to", async () => {
    const hashes: Record<string, string> = {};
    for (const [key, module] of [
      ["google-calendar", calendar],
      ["gmail", gmail],
    ] as const) {
      for (const tool of await module.listTools({ url: "" })) {
        hashes[`${key}/${tool.name}`] = await definitionHashOf({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema as Record<string, unknown>,
          annotations: tool.annotations as never,
        });
      }
    }
    expect(hashes).toEqual({
      "google-calendar/list_events":
        "a63a32392b8f10b35a605bd3399d86db949a1a5b6b3a555d6656675489d1306e",
      "google-calendar/create_event":
        "83f9ad0e3ea8f80c12b5fc57a22e90f846a6e405928a5ffdb3f29cfa6aa44330",
      "gmail/search_messages":
        "5b8a68a161545d4886b629220ad9ccbfce5feed499054e45207eb54c063f1d22",
      "gmail/read_message":
        "6f993826c5aeb064508b5f688c8165624d58c2a2b99b80a58ae8c9d92aa23db7",
      "gmail/create_draft":
        "e7c035f7b5330885460d9a67998bad62b35f6f2037bdfa38ae321d7d07053239",
      "gmail/send_message":
        "96b5621f295d5ef3655b93e427cf27046ee9267ad4d89e0ec9339c8909a0ae56",
    });
  });

  test("a refusal comes back as one", async () => {
    reply = refuses(401, "Invalid Credentials");

    const result = await calendar.callTool(connection, "list_events", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("401");
  });
});

/* ── Google Business Profile ─────────────────────────────────────────────────────────────────── */

describe("Google Business Profile", () => {
  const connection = connectionTo("https://mybusiness.googleapis.com/v4");

  test("a resource name a model made up never reaches a URL", () => {
    expect(business.isResourceName("accounts/123/locations/456")).toBe(true);
    // These travel straight into a path. Whether Google normalises `../..` is not something this
    // connector should be finding out.
    expect(business.isResourceName("accounts/../../etc")).toBe(false);
    expect(business.isResourceName("locations/456")).toBe(false);
    expect(business.isResourceName("accounts/123/locations/456?x=1")).toBe(
      false,
    );
  });

  test("a reply is refused before the network when the name is not one", async () => {
    const result = await business.callTool(connection, "reply_to_review", {
      review: "https://evil.example/",
      comment: "감사합니다",
    });

    expect(result.isError).toBe(true);
    expect(asked).toHaveLength(0);
  });

  test("a reply is a PUT on the review's own address", async () => {
    reply = () => json({});

    const result = await business.callTool(connection, "reply_to_review", {
      review: "accounts/1/locations/2/reviews/3",
      comment: "감사합니다",
    });

    expect(result.isError).toBe(false);
    expect(asked[0]?.method).toBe("PUT");
    expect(asked[0]?.url.pathname).toBe(
      "/v4/accounts/1/locations/2/reviews/3/reply",
    );
    expect(asked[0]?.body).toEqual({ comment: "감사합니다" });
  });

  test("the locations listing hands back a name list_reviews can actually take", async () => {
    reply = (request) =>
      request.url.pathname.endsWith("/accounts")
        ? json({ accounts: [{ name: "accounts/1", accountName: "가게" }] })
        : json({
            locations: [{ name: "locations/2", title: "본점" }],
          });

    const result = await business.callTool(connection, "list_locations", {});

    // The two APIs disagree: reviews live under `accounts/…/locations/…` and the locations API
    // answers with a bare `locations/…`. A model asked to guess the rest gets it wrong every time.
    expect(result.text).toContain("location: accounts/1/locations/2");
  });

  test("a refusal on one account is reported beside the account it belongs to", async () => {
    reply = (request) =>
      request.url.pathname.endsWith("/accounts")
        ? json({ accounts: [{ name: "accounts/1", accountName: "가게" }] })
        : json(
            { error: { message: "The caller does not have permission" } },
            403,
          );

    const result = await business.callTool(connection, "list_locations", {});

    // Not an error result: one account being unreadable is not the whole call failing, and saying
    // so per account is what tells somebody which of their businesses to look at.
    expect(result.text).toContain("가게");
    expect(result.text).toContain("403");
  });
});

/* ── Cafe24 ──────────────────────────────────────────────────────────────────────────────────── */

describe("Cafe24", () => {
  const connection = connectionTo(
    "https://sunnymart.cafe24api.com/api/v2/admin",
  );

  test("every call carries the API version the mall is pinned to", async () => {
    reply = () => json({ orders: [] });

    await cafe24.callTool(connection, "list_orders", {
      startDate: "2026-09-01",
      endDate: "2026-09-04",
    });

    expect(asked[0]?.headers.get("x-cafe24-api-version")).toBeTruthy();
    // The items in the same round trip: a page of order numbers with no product names is one a
    // model cannot say anything about.
    expect(asked[0]?.url.searchParams.get("embed")).toBe("items");
    expect(asked[0]?.url.searchParams.get("start_date")).toBe("2026-09-01");
  });

  test("a malformed date is refused here rather than sent", async () => {
    const result = await cafe24.callTool(connection, "list_orders", {
      startDate: "2026/09/01",
      endDate: "2026-09-04",
    });

    // Cafe24 answers a malformed date with a message about a field name, which a model reads as a
    // schema problem and retries verbatim.
    expect(result.isError).toBe(true);
    expect(asked).toHaveLength(0);
  });

  test("a status change is a PUT carrying the shop number Cafe24 refuses the call without", async () => {
    reply = () => json({});

    const result = await cafe24.callTool(connection, "update_order_status", {
      orderId: "20260904-0000001",
      status: "shipped",
    });

    expect(result.isError).toBe(false);
    expect(asked[0]?.method).toBe("PUT");
    expect(asked[0]?.url.pathname).toBe(
      "/api/v2/admin/orders/20260904-0000001",
    );
    expect(asked[0]?.body).toEqual({
      shop_no: 1,
      request: { status: "shipped" },
    });
  });

  test("a refusal carries Cafe24's own sentence", async () => {
    reply = refuses(422, "Invalid order status");

    const result = await cafe24.callTool(connection, "update_order_status", {
      orderId: "1",
      status: "nonsense",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("422");
    expect(result.text).toContain("Invalid order status");
  });

  test("a tool the stored list still names, that this connector does not have, says so", async () => {
    const result = await cafe24.callTool(connection, "delete_everything", {});

    expect(result.isError).toBe(true);
    expect(asked).toHaveLength(0);
  });
});

/* ── what every adapter does the same way ────────────────────────────────────────────────────── */

describe("the shared REST behaviour", () => {
  test("a call with nobody's credential is named, never sent as `Bearer undefined`", async () => {
    const result = await sheets.callTool(
      { url: "https://sheets.googleapis.com/v4/spreadsheets" },
      "list_sheet_tabs",
      { spreadsheetId: "x" },
    );

    expect(result.isError).toBe(true);
    expect(asked).toHaveLength(0);
  });

  test("a 200 that is not JSON is a refusal, not a crash", async () => {
    // A captive portal or a maintenance page answers 200 with HTML, and an unguarded parse would
    // throw out of a tool call that has a perfectly good way to say so.
    reply = () =>
      new Response("<html>maintenance</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    const result = await sheets.callTool(
      connectionTo("https://sheets.googleapis.com/v4/spreadsheets"),
      "list_sheet_tabs",
      { spreadsheetId: "x" },
    );

    expect(result.isError).toBe(true);
  });

  test("a redirect is refused rather than followed", async () => {
    // This request carries somebody's access token; following a 302 would hand it to whatever
    // address the answer named.
    let sawRedirectManual = false;
    globalThis.fetch = stubFetch(async (_url, init) => {
      sawRedirectManual = init?.redirect === "manual";
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/" },
      });
    });

    const result = await sheets.callTool(
      connectionTo("https://sheets.googleapis.com/v4/spreadsheets"),
      "list_sheet_tabs",
      { spreadsheetId: "x" },
    );

    expect(sawRedirectManual).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("302");
  });

  /*
   * The status is a FIELD beside the sentence, because one reader acts on it: the call path judges
   * a connection's health off a 401 (`connection-health.ts`). Read out of the prose, that judgement
   * would be one rewording away from never running again.
   */
  test("a refusal carries its status as a fact, for every adapter", async () => {
    reply = refuses(401, "Invalid Credentials");

    const results = await Promise.all([
      sheets.callTool(
        connectionTo("https://sheets.googleapis.com/v4/spreadsheets"),
        "list_sheet_tabs",
        { spreadsheetId: "x" },
      ),
      gmail.callTool(
        connectionTo("https://gmail.googleapis.com/gmail/v1/users/me"),
        "read_message",
        { messageId: "m1" },
      ),
      calendar.callTool(
        connectionTo("https://www.googleapis.com/calendar/v3"),
        "list_events",
        {},
      ),
      drive.callTool(
        connectionTo("https://www.googleapis.com/drive/v3"),
        "list_recent_files",
        {},
      ),
      cafe24.callTool(
        connectionTo("https://sunnymart.cafe24api.com/api/v2/admin"),
        "list_orders",
        { startDate: "2026-09-01", endDate: "2026-09-04" },
      ),
    ]);

    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.status).toBe(401);
    }
  });
});
