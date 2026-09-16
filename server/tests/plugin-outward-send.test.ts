import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import type { CallPreview, PendingApproval } from "../src/computer/approvals";
import { presentable } from "../src/computer/approvals";
import { relayApprovals, type RoomQuestion } from "../src/rooms/approval-relay";
import {
  type LoopAgent,
  outcomeOfError,
  runUnattended,
  type ToolOutcome,
} from "../src/runner/unattended";
import * as cafe24 from "../src/plugins/cafe24-rest";
import { CATALOGUE, catalogueEntry } from "../src/plugins/catalogue";
import * as gmail from "../src/plugins/gmail-rest";
import * as business from "../src/plugins/google-business-rest";
import * as calendar from "../src/plugins/google-calendar-rest";
import {
  PluginNeedsApprovalError,
  PluginRefusedError,
} from "../src/plugins/store";
import { transportFor } from "../src/plugins/transport";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import { stubFetch } from "./support/fetch";

/**
 * WHAT LEAVES THE BUSINESS, AND WHAT THE PERSON WHO LETS IT SEES FIRST.
 *
 * Two findings of the 2026-09-16 audit (R4-01, R4-02), both on the five tools the catalogue guards
 * as `external` — a mail, an invitation, a public review reply, an order status the buyer is told
 * about, an 알림톡:
 *
 * THE RECIPIENT WAS A HEADER THE MODEL WROTE. Gmail's `To:` line was `To: ${input.to}` and the only
 * thing between a model's argument and that line trimmed the ends, so
 * `friend@example.com\r\nBcc: attacker@evil.example` put a second header into the mail — measured,
 * against a stubbed Gmail, as a real `Bcc:`. An instruction planted in a mail the Bot had just read
 * is enough to write that value.
 *
 * THE QUESTION NAMED ONLY THE TOOL. The card said which tool on which service and nothing about the
 * call, so the "yes" that the fingerprint binds to one exact set of arguments was given without
 * seeing any of them. The call now carries a bounded preview of itself — facts, cut to size — and
 * this file holds each adapter to what its preview says.
 *
 * No vendor and no database here: the adapters are asked directly, with `fetch` stubbed, so "nothing
 * reached Gmail" is an empty list rather than a hope. What the store does with a refusal and a
 * preview is `plugin-call-preview.integration.test.ts`.
 */

type Sent = { url: URL; method: string; body: unknown };

let sent: Sent[] = [];
let realFetch: typeof fetch;

beforeEach(() => {
  sent = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(async (url, init) => {
    sent.push({
      url: new URL(String(url)),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ id: "msg-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  // A leaked global would silently answer every later file in the run.
  globalThis.fetch = realFetch;
});

const GMAIL = { url: "https://gmail.googleapis.com/gmail/v1/users/me" };
const connection = { ...GMAIL, token: "at" };

const MAIL = {
  to: "friend@example.com",
  subject: "9월 정산 안내",
  body: "안녕하세요.\n9월 정산서를 보내 드립니다.",
};

const INJECTED = "friend@example.com\r\nBcc: attacker@evil.example";

/** The header block of the one mail that went out, as Gmail would have read it. */
function headersSent(): string[] {
  // A send posts `{ raw }`, a draft `{ message: { raw } }`.
  const body = sent[0]?.body as
    | { raw?: string; message?: { raw?: string } }
    | undefined;
  const raw = body?.raw ?? body?.message?.raw ?? "";
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  return (mime.split("\r\n\r\n")[0] ?? "").split("\r\n");
}

/** Whatever a call threw or returned, so a refusal and a send can be told apart in one line. */
async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

const refusalCode = (value: unknown) =>
  value instanceof PluginRefusedError ? value.code : `not refused: ${value}`;

/* ── the recipient ───────────────────────────────────────────────────────────────────────────── */

describe("a Gmail recipient", () => {
  test("carrying a header of its own is refused, and nothing reaches Gmail", async () => {
    for (const tool of ["send_message", "create_draft"]) {
      const outcome = await outcomeOf(
        gmail.callTool(connection, tool, { ...MAIL, to: INJECTED }),
      );
      expect({ tool, code: refusalCode(outcome) }).toEqual({
        tool,
        code: "laf:mail_recipient_invalid",
      });
    }
    // Not a mail with the header stripped, not a draft: nothing at all.
    expect(sent).toEqual([]);
  });

  test("is refused by the check the call path runs before anybody is asked", async () => {
    // The store asks the transport it resolves for this entry, so the check has to be on THAT
    // object — an adapter export the registry never exposed would be a check nothing runs.
    const registered = transportFor(catalogueEntry("gmail"));
    expect(registered.validateArgs).toBeDefined();

    const outcome = await outcomeOf(
      Promise.resolve(
        registered.validateArgs?.(GMAIL, "send_message", {
          ...MAIL,
          to: INJECTED,
        }),
      ),
    );
    expect(refusalCode(outcome)).toBe("laf:mail_recipient_invalid");
    // A good mail passes the same check untouched.
    expect(
      await registered.validateArgs?.(GMAIL, "send_message", MAIL),
    ).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("that is not a comma-separated list of addresses is refused the same way", async () => {
    const refused: unknown[] = [
      "friend@example.com\nBcc: attacker@evil.example",
      "friend@example.com\rBcc: attacker@evil.example",
      // A line separator a lenient client might still break on.
      "friend@example.com\u2028Bcc: attacker@evil.example",
      "김민수 <kim@shop.kr>",
      "kim@shop.kr; lee@shop.kr",
      "kim@shop.kr,",
      "kim@shop.kr,,lee@shop.kr",
      "kim at shop.kr",
      "kim@@shop.kr",
      ".kim@shop.kr",
      "kim@shop",
      "kim@-shop.kr",
      "   ",
      "",
      ["kim@shop.kr"],
      42,
      undefined,
    ];
    for (const to of refused) {
      const checked = await outcomeOf(
        Promise.resolve(
          gmail.validateArgs(GMAIL, "send_message", { ...MAIL, to }),
        ),
      );
      const called = await outcomeOf(
        gmail.callTool(connection, "send_message", { ...MAIL, to }),
      );
      expect({
        to,
        checked: refusalCode(checked),
        called: refusalCode(called),
      }).toEqual({
        to,
        checked: "laf:mail_recipient_invalid",
        called: "laf:mail_recipient_invalid",
      });
    }
    expect(sent).toEqual([]);
  });

  test("several addresses go out as one To line, and no other header appears", async () => {
    const result = await gmail.callTool(connection, "send_message", {
      ...MAIL,
      subject: "Order 42",
      to: " kim@shop.kr ,lee.min-su+order@mail.shop.co.kr",
    });

    expect(result.isError).toBe(false);
    expect(headersSent()).toEqual([
      "To: kim@shop.kr, lee.min-su+order@mail.shop.co.kr",
      "Subject: Order 42",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ]);
  });

  test("a subject is one line, whatever language it is in", async () => {
    for (const subject of ["hi\r\nBcc: attacker@evil.example", "주문\n확인"]) {
      const checked = await outcomeOf(
        Promise.resolve(
          gmail.validateArgs(GMAIL, "send_message", { ...MAIL, subject }),
        ),
      );
      const called = await outcomeOf(
        gmail.callTool(connection, "send_message", { ...MAIL, subject }),
      );
      expect({ subject, checked: refusalCode(checked) }).toEqual({
        subject,
        checked: "laf:mail_subject_invalid",
      });
      expect({ subject, called: refusalCode(called) }).toEqual({
        subject,
        called: "laf:mail_subject_invalid",
      });
    }
    expect(sent).toEqual([]);
  });

  test("the builder itself will not write a line break into a header, whoever calls it", () => {
    // The last line of defence and the only place a header is spelled: a caller that skipped every
    // check above still cannot get a second header out of it.
    expect(() =>
      gmail.mimeMessage({ to: INJECTED, subject: "hi", body: "hello" }),
    ).toThrow(PluginRefusedError);
    expect(() =>
      gmail.mimeMessage({
        to: "friend@example.com",
        subject: "hi\r\nBcc: attacker@evil.example",
        body: "hello",
      }),
    ).toThrow(PluginRefusedError);
  });

  test("both refusals have Korean beside them, so a Bot never reads a bare code", () => {
    for (const code of [
      "laf:mail_recipient_invalid",
      "laf:mail_subject_invalid",
    ]) {
      expect(toolResultText(code)).not.toBe(code);
    }
    // It tells the model what a valid value looks like, and not to invent one.
    expect(toolResultText("laf:mail_recipient_invalid")).toContain("쉼표");
    expect(toolResultText("laf:mail_recipient_invalid")).toContain("지어내지");
  });
});

/* ── what the question shows ─────────────────────────────────────────────────────────────────── */

describe("the preview an outward call carries", () => {
  test("a mail names who it goes to, the subject and the text", () => {
    expect(gmail.previewCall("send_message", MAIL)).toEqual([
      { field: "recipients", values: ["friend@example.com"] },
      { field: "subject", values: ["9월 정산 안내"] },
      { field: "text", values: ["안녕하세요.\n9월 정산서를 보내 드립니다."] },
    ]);
    // A draft stays in the person's own mailbox and a read sends nothing: no preview to show.
    expect(gmail.previewCall("create_draft", MAIL)).toBeNull();
    expect(gmail.previewCall("search_messages", { query: "x" })).toBeNull();
  });

  test("what the card shows is what goes out", async () => {
    const args = { ...MAIL, to: "kim@shop.kr,  lee@shop.kr" };
    const preview = gmail.previewCall("send_message", args);
    await gmail.callTool(connection, "send_message", args);

    const recipients = preview?.find((entry) => entry.field === "recipients");
    expect(recipients?.values).toEqual(["kim@shop.kr", "lee@shop.kr"]);
    expect(headersSent()[0]).toBe(`To: ${recipients?.values.join(", ")}`);
  });

  test("an invitation names its time, its guests and its place", () => {
    expect(
      calendar.previewCall("create_event", {
        summary: "상견례",
        start: "2026-09-20T12:00:00+09:00",
        end: "2026-09-20T14:00:00+09:00",
        attendees: ["kim@shop.kr", 7, "lee@shop.kr"],
        location: "본점 2층",
        description: "코스 요리 예약",
      }),
    ).toEqual([
      { field: "title", values: ["상견례"] },
      { field: "starts", values: ["2026-09-20T12:00:00+09:00"] },
      { field: "ends", values: ["2026-09-20T14:00:00+09:00"] },
      // Exactly the addresses the adapter would invite: the non-string is dropped there too.
      { field: "attendees", values: ["kim@shop.kr", "lee@shop.kr"] },
      { field: "location", values: ["본점 2층"] },
      { field: "text", values: ["코스 요리 예약"] },
    ]);
    expect(calendar.previewCall("list_events", {})).toBeNull();
  });

  test("a review reply names the review and the words that will be published", () => {
    expect(
      business.previewCall("reply_to_review", {
        review: "accounts/1/locations/2/reviews/abc",
        comment: "방문해 주셔서 감사합니다!",
      }),
    ).toEqual([
      { field: "review", values: ["accounts/1/locations/2/reviews/abc"] },
      { field: "text", values: ["방문해 주셔서 감사합니다!"] },
    ]);
    expect(business.previewCall("list_reviews", {})).toBeNull();
  });

  test("an order status change names the order and the status", () => {
    expect(
      cafe24.previewCall("update_order_status", {
        orderId: "20260916-0000012",
        status: "N30",
      }),
    ).toEqual([
      { field: "order", values: ["20260916-0000012"] },
      { field: "status", values: ["N30"] },
    ]);
    expect(cafe24.previewCall("list_orders", {})).toBeNull();
  });

  test("a long message is cut, counted the way a person counts, and says so", () => {
    // 1,500 characters, each a two-unit emoji: a cut by UTF-16 units would split one in half.
    const long = "🙂".repeat(1_500);
    const [, , text] = gmail.previewCall("send_message", {
      ...MAIL,
      body: long,
    }) as CallPreview;
    expect(text?.cut).toBe(true);
    expect([...(text?.values[0] ?? "")]).toHaveLength(1_000);
    expect(text?.values[0]).toBe("🙂".repeat(1_000));
  });

  test("a long recipient list shows ten and says how many there are", () => {
    const everybody = Array.from(
      { length: 12 },
      (_, index) => `guest${index}@shop.kr`,
    );
    const [recipients] = gmail.previewCall("send_message", {
      ...MAIL,
      to: everybody.join(","),
    }) as CallPreview;
    expect(recipients?.values).toEqual(everybody.slice(0, 10));
    expect(recipients?.total).toBe(12);
  });

  test("every tool the catalogue guards as external has a preview, and nothing else does", () => {
    // One valid call per guarded tool. A tool added to `guardedTools` without a preview fails here,
    // which is the point: a card for it would be a question about arguments nobody is shown.
    const CALLS: Record<string, Record<string, unknown>> = {
      "gmail/send_message": MAIL,
      "google-calendar/create_event": {
        summary: "a",
        start: "2026-09-20T12:00:00+09:00",
        end: "2026-09-20T13:00:00+09:00",
      },
      "google-business-profile/reply_to_review": {
        review: "accounts/1/locations/2/reviews/3",
        comment: "thanks",
      },
      "cafe24/update_order_status": { orderId: "1", status: "N10" },
    };
    const external: string[] = [];
    for (const entry of CATALOGUE) {
      // A partner's transport is assembled by the process, not held by the static registry; its
      // preview is asked for through the store in the integration file.
      if (entry.partner) continue;
      for (const [name, guard] of Object.entries(entry.guardedTools ?? {})) {
        const ref = `${entry.key}/${name}`;
        const preview = transportFor(entry).previewCall?.(
          name,
          CALLS[ref] ?? {},
        );
        if (guard === "external") {
          external.push(ref);
          expect({ ref, previewed: (preview?.length ?? 0) > 0 }).toEqual({
            ref,
            previewed: true,
          });
        } else {
          expect({ ref, preview: preview ?? null }).toEqual({
            ref,
            preview: null,
          });
        }
      }
    }
    expect(external.sort()).toEqual(Object.keys(CALLS).sort());
  });
});

/* ── the preview's way out of the call path ──────────────────────────────────────────────────── */

const PREVIEWED: PendingApproval = {
  id: "ap_preview",
  botId: "bot_preview",
  actor: "user_preview",
  rule: "laf:external",
  subject: {
    kind: "tool",
    intent: "call_tool",
    tool: { server: "gmail", name: "send_message", guard: "external" },
    reason: "guard_floor",
  },
  preview: [
    { field: "recipients", values: ["friend@example.com"] },
    { field: "text", values: ["hello"] },
  ],
  target: { type: "mcp_tool", id: "gmail/send_message" },
  fingerprint: "f".repeat(64),
  scope: { kind: "tool", value: "gmail/send_message" },
  requestedAt: "2026-09-16T00:00:00.000Z",
  expiresAt: "2026-09-16T00:10:00.000Z",
};

describe("the preview on its way to a person", () => {
  test("travels with the question to the surfaces that draw it", () => {
    expect(presentable(PREVIEWED).preview).toEqual(PREVIEWED.preview);
    const paused = new PluginNeedsApprovalError(PREVIEWED);
    expect(paused.preview).toEqual(PREVIEWED.preview);
    // A room's member runs unattended: the same facts reach its card.
    expect(outcomeOfError(paused).preview).toEqual(PREVIEWED.preview);
  });

  test("stays out of what the model reads back in an unattended run", async () => {
    // The preview is the call's own arguments, cut for a person. Echoed into the tool result it
    // would be up to a thousand characters of the model's own words on every later turn.
    const turns: Message[] = [
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "mcp__gmail__send_message",
              arguments: JSON.stringify(MAIL),
            },
          },
        ],
      },
      { id: "a2", role: "assistant", content: "승인을 기다립니다." },
    ];
    let runs = 0;
    const agent = {
      messages: [] as Message[],
      setMessages(messages: Message[]) {
        agent.messages = [...messages];
      },
      addMessage(message: Message) {
        agent.messages.push(message);
      },
      async runAgent(
        _parameters?: unknown,
        subscriber?: { onRunFinishedEvent?: () => unknown },
      ) {
        const turn = turns[runs];
        runs += 1;
        if (turn) agent.messages.push(turn);
        subscriber?.onRunFinishedEvent?.();
        return { result: undefined, newMessages: turn ? [turn] : [] };
      },
    };

    await runUnattended(agent as unknown as LoopAgent, "메일 보내 줘", {
      toolkit: {
        tools: [],
        // Said outright rather than left to `outcomeOfError`, so this holds the loop to its own
        // rule whatever an executor hands it.
        execute: async () => ({
          ...outcomeOfError(new PluginNeedsApprovalError(PREVIEWED)),
          preview: PREVIEWED.preview,
        }),
      },
      timeoutMs: 5_000,
      mode: "routine",
    });

    const answer = agent.messages.find((message) => message.role === "tool");
    const read = JSON.parse(String(answer?.content)) as Record<string, unknown>;
    // Still told it is waiting, with the facts it had before…
    expect(read.awaitingApproval).toBe(true);
    expect(read.subject).toEqual(PREVIEWED.subject);
    // …and not handed the card's copy of its own mail.
    expect("preview" in read).toBe(false);
    expect(String(answer?.content)).not.toContain("friend@example.com");
  });

  test("reaches the room's card, and a shape the relay cannot vouch for does not", async () => {
    const announced: RoomQuestion[] = [];
    const asked = (preview: unknown): ToolOutcome => ({
      ...outcomeOfError(new PluginNeedsApprovalError(PREVIEWED)),
      preview,
    });
    for (const preview of [
      PREVIEWED.preview,
      "friend@example.com",
      [{ field: "recipients", values: "friend@example.com" }],
    ]) {
      const relayed = relayApprovals(
        { tools: [], execute: async () => asked(preview) },
        {
          memberId: "bot_preview",
          announce: (question) => {
            announced.push(question);
          },
        },
      );
      await relayed.execute("mcp__gmail__send_message", MAIL, { id: "c1" });
    }
    expect(announced.map((question) => question.preview)).toEqual([
      PREVIEWED.preview,
      undefined,
      undefined,
    ]);
  });
});
