import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as cafe24 from "../src/plugins/cafe24-rest";
import { CATALOGUE, catalogueEntry } from "../src/plugins/catalogue";
import * as gmail from "../src/plugins/gmail-rest";
import * as business from "../src/plugins/google-business-rest";
import * as calendar from "../src/plugins/google-calendar-rest";
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
      expect(transportFor(entry)).toBeDefined();
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
    const raw = (asked[0]?.body as { raw: string }).raw;
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
    expect(result.text).toContain("Nothing was found");
  });

  test("a refusal is a refusal, and it names the status", async () => {
    reply = refuses(429, "User-rate limit exceeded.");

    const result = await gmail.callTool(connection, "search_messages", {
      query: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("429");
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
});
