import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type AskSubject,
  describeSubject,
  pauseFrom,
} from "../src/lib/approvals";
import {
  type CallPreview,
  callPreviewOf,
  previewLines,
} from "../src/lib/call-preview";
import { applyRoomFrame, EMPTY_ROOM } from "../src/lib/channels/room-events";
import { ko } from "../src/lib/i18n-ko";
import { serviceLabel, toolLabel } from "../src/lib/plugins/tool-labels";

/**
 * THE CARD SHOWS THE SEND IT IS ASKING ABOUT, IN KOREAN.
 *
 * Measured 2026-09-16 (audit R4-01): an 알림톡, a mail, an invitation, a review reply and an order
 * status change each stopped on a card reading "{server}의 ‘{tool}’ 도구를 쓰려 합니다." — no number,
 * no address, no text — and "kakao-alimtalk의 ‘alimtalk_send’ 도구" at that (R4-14). The server now
 * sends a bounded preview of the call beside the question, as facts; this surface owns the words.
 *
 * The facts are read defensively (they arrive over HTTP and over a socket), every label is a
 * literal `t()` so `i18n-coverage.test.ts` and `owner-vocabulary.test.ts` both see it, and the last
 * block renders the two cards in Korean, in a process of their own, and reads back what a person
 * would see.
 */

const MAIL: CallPreview = [
  { field: "recipients", values: ["friend@example.com"] },
  { field: "subject", values: ["9월 정산 안내"] },
  { field: "text", values: ["안녕하세요."] },
];

const SENDING_MAIL: AskSubject = {
  kind: "tool",
  intent: "call_tool",
  tool: { server: "gmail", name: "send_message", guard: "external" },
  reason: "guard_floor",
};

describe("reading a preview off the wire", () => {
  test("a pause reply carries it to the card", () => {
    expect(
      pauseFrom({
        awaitingApproval: true,
        approvalId: "a-1",
        subject: SENDING_MAIL,
        rule: "laf:external",
        preview: MAIL,
        expiresAt: "2026-09-16T00:10:00.000Z",
      })?.preview,
    ).toEqual(MAIL);
  });

  test("a reply with none leaves the card as it was", () => {
    const pause = pauseFrom({
      awaitingApproval: true,
      approvalId: "a-1",
      subject: SENDING_MAIL,
      rule: "laf:external",
    });
    expect(pause).not.toBeNull();
    expect(pause && "preview" in pause).toBe(false);
  });

  test("keeps what it can vouch for and drops the rest", () => {
    expect(
      callPreviewOf([
        { field: "recipients", values: ["a@shop.kr", 7, "b@shop.kr"] },
        // Not a field this surface has a word for: a value with no label is not drawn.
        { field: "password", values: ["hunter2"] },
        { field: "subject", values: "not a list" },
        { field: "text", values: [] },
        null,
        "text",
        { field: "text", values: ["hello"], cut: true, total: "many" },
        { field: "attendees", values: ["c@shop.kr"], total: 3 },
      ]),
    ).toEqual([
      { field: "recipients", values: ["a@shop.kr", "b@shop.kr"] },
      { field: "text", values: ["hello"], cut: true },
      { field: "attendees", values: ["c@shop.kr"], total: 3 },
    ]);
    expect(callPreviewOf(undefined)).toBeUndefined();
    expect(callPreviewOf("friend@example.com")).toBeUndefined();
    expect(callPreviewOf([])).toBeUndefined();
    expect(callPreviewOf([{ field: "nope", values: ["x"] }])).toBeUndefined();
  });

  test("a room frame carries it, checked the same way", () => {
    const frame = {
      kind: "room.approval" as const,
      channelId: "ch-1",
      turnId: "t-1",
      epoch: 1,
      memberId: "bot-1",
      memberName: "초롱",
      approvalId: "ap-1",
      subject: SENDING_MAIL,
      rule: "laf:external",
      expiresAt: "",
    };
    const drawn = applyRoomFrame(
      EMPTY_ROOM,
      { ...frame, preview: MAIL },
      "ch-1",
    );
    expect(drawn.approvals[0]?.preview).toEqual(MAIL);

    const unreadable = applyRoomFrame(
      EMPTY_ROOM,
      { ...frame, preview: "friend@example.com" },
      "ch-1",
    );
    expect(unreadable.approvals[0]?.preview).toBeUndefined();
  });
});

describe("what the card says about a preview", () => {
  test("every field has a label, and every label has Korean", () => {
    const every: CallPreview = [
      { field: "recipients", values: ["x"] },
      { field: "attendees", values: ["x"] },
      { field: "subject", values: ["x"] },
      { field: "title", values: ["x"] },
      { field: "starts", values: ["x"] },
      { field: "ends", values: ["x"] },
      { field: "location", values: ["x"] },
      { field: "template", values: ["x"] },
      { field: "text", values: ["x"] },
      { field: "review", values: ["x"] },
      { field: "order", values: ["x"] },
      { field: "status", values: ["x"] },
    ];
    const lines = previewLines(every);
    expect(lines).toHaveLength(every.length);
    // Rendered in English here, so each label IS its dictionary key.
    const missing = lines
      .map((line) => line.label)
      .filter((label) => !ko[label]);
    expect(missing).toEqual([]);
  });

  test("every field the server can send is one this surface draws", async () => {
    // The two lists are declared apart, like the room frame kinds; this is the drift check. A field
    // the server adds and this file does not know would be dropped from the card without a sound.
    const source = await Bun.file(
      new URL("../../server/src/computer/approvals.ts", import.meta.url),
    ).text();
    const union =
      /export type CallPreviewField =([\s\S]*?);/.exec(source)?.[1] ?? "";
    const serverFields = [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map(
      (match) => match[1] as string,
    );
    expect(serverFields.length).toBeGreaterThan(10);
    const undrawn = serverFields.filter(
      (field) => callPreviewOf([{ field, values: ["x"] }]) === undefined,
    );
    expect(undrawn).toEqual([]);
  });

  test("the recipients come first and the text last, whatever order the facts arrived in", () => {
    const lines = previewLines([
      { field: "text", values: ["hello"] },
      { field: "subject", values: ["hi"] },
      { field: "recipients", values: ["a@shop.kr"] },
    ]);
    expect(lines.map((line) => line.field)).toEqual([
      "recipients",
      "subject",
      "text",
    ]);
  });

  test("a list that was cut says how many more, and a cut text says it was cut", () => {
    const [recipients, text] = previewLines([
      { field: "recipients", values: ["a@shop.kr", "b@shop.kr"], total: 5 },
      { field: "text", values: ["hello"], cut: true },
    ]);
    expect(recipients?.value).toBe("a@shop.kr, b@shop.kr");
    expect(recipients?.note).toBe("and 3 more");
    expect(ko["and {count} more"]).toBeTruthy();
    expect(text?.value).toBe("hello…");
    expect(text?.note).toBe("(the rest is not shown)");
    expect(ko["(the rest is not shown)"]).toBeTruthy();
  });

  test("a time is shown as a date and a clock, its offset kept and never converted", () => {
    const [starts, odd] = previewLines([
      { field: "starts", values: ["2026-09-20T12:00:00+09:00"] },
      { field: "ends", values: ["tomorrow at noon"] },
    ]);
    expect(starts?.value).toBe("2026-09-20 12:00 (+09:00)");
    // Anything that is not that shape is shown as it came, rather than guessed at.
    expect(odd?.value).toBe("tomorrow at noon");
  });

  test("an order status and an 알림톡 template are named where this surface knows them", () => {
    const [status] = previewLines(
      [{ field: "status", values: ["N30"] }],
      "cafe24/update_order_status",
    );
    expect(status?.value).toBe("N30 (Shipping)");
    const [unknown] = previewLines(
      [{ field: "status", values: ["N22"] }],
      "cafe24/update_order_status",
    );
    expect(unknown?.value).toBe("N22");

    const [template] = previewLines(
      [{ field: "template", values: ["laf_reservation"] }],
      "kakao-alimtalk/alimtalk_send",
    );
    expect(template?.value).toBe("Booking confirmation");
    for (const key of [
      "Shipping",
      "Booking confirmation",
      "Review request",
      "Awaiting payment",
      "Preparing the item",
      "Delivered",
    ]) {
      expect({ key, korean: Boolean(ko[key]) }).toEqual({ key, korean: true });
    }
  });
});

describe("naming the tool", () => {
  test("a tool with a label is named by it, and so is its service", () => {
    const said = describeSubject(SENDING_MAIL);
    expect(said).toContain("Send an email");
    expect(said).toContain("Gmail");
    expect(said).not.toContain("send_message");
  });

  test("a tool without one keeps its own name", () => {
    const said = describeSubject({
      kind: "tool",
      intent: "call_tool",
      tool: { server: "custom-crm", name: "create_ticket" },
      reason: "policy_ask",
    });
    expect(said).toContain("create_ticket");
    expect(said).toContain("custom-crm");
  });

  test("every tool the server's catalogue guards has a label, and every service a name", async () => {
    // The catalogue is the server's; imported rather than copied, so a guarded tool added there
    // fails here until somebody decides what a shop owner calls it.
    const { CATALOGUE } = await import("../../server/src/plugins/catalogue");
    const missing: string[] = [];
    for (const entry of CATALOGUE) {
      const guarded = Object.keys(entry.guardedTools ?? {});
      if (guarded.length === 0) continue;
      const service = serviceLabel(entry.key);
      if (!service || !ko[service]) missing.push(entry.key);
      for (const name of guarded) {
        const label = toolLabel(`${entry.key}/${name}`);
        if (!label || !ko[label]) missing.push(`${entry.key}/${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

/* ── rendered, in Korean ─────────────────────────────────────────────────────────────────────── */

type Card = { question: string; lines: [string, string][] };
type Rendered = { page: Card[]; room: Card[] };

let rendering: Promise<Rendered> | undefined;

/** One Korean process for the whole block: it mounts the route tree. */
function renderedInKorean(): Promise<Rendered> {
  rendering ??= (async () => {
    const script = join(import.meta.dir, "support/preview-render.tsx");
    const child = Bun.spawn(["bun", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const line = stdout
      .split("\n")
      .find((candidate) => candidate.startsWith("PREVIEW_RENDER "));
    if (status !== 0 || !line) {
      throw new Error(
        `the Korean render did not finish (exit ${status}):\n${stderr.slice(-2000)}`,
      );
    }
    return JSON.parse(line.slice("PREVIEW_RENDER ".length)) as Rendered;
  })();
  return rendering;
}

describe("the cards, as a Korean reader sees them", () => {
  test("the page a notice opens shows who the mail goes to, the subject and the text", async () => {
    const { page } = await renderedInKorean();
    expect(page).toHaveLength(1);
    const [card] = page;
    expect(card?.question).toContain(
      "지메일의 ‘메일 보내기’ 도구를 쓰려 합니다.",
    );
    expect(card?.lines).toEqual([
      [
        "받는 사람",
        `${Array.from({ length: 10 }, (_, at) => `guest${at}@shop.kr`).join(", ")} 외 2명`,
      ],
      ["제목", "9월 정산 안내"],
      ["내용", "안녕하세요.\n9월 정산서를 보내 드립니다.… (이하 생략)"],
    ]);
  }, 60_000);

  test("a room's cards show the 알림톡, the invitation, the order and the reply", async () => {
    const { room } = await renderedInKorean();
    expect(room.map((card) => card.question)).toEqual([
      expect.stringContaining(
        "카카오 알림톡의 ‘알림톡 보내기’ 도구를 쓰려 합니다.",
      ),
      expect.stringContaining(
        "구글 캘린더의 ‘일정 만들기’ 도구를 쓰려 합니다.",
      ),
      expect.stringContaining(
        "카페24의 ‘주문 상태 바꾸기’ 도구를 쓰려 합니다.",
      ),
      expect.stringContaining(
        "구글 비즈니스 프로필의 ‘리뷰에 답글 달기’ 도구를 쓰려 합니다.",
      ),
    ]);
    expect(room.map((card) => card.lines)).toEqual([
      [
        ["받는 사람", "01011112222"],
        ["서식", "예약 확정 안내"],
        ["내용", "[미소상회]\n예약이 확정되었습니다."],
      ],
      [
        ["초대 메일 받는 사람", "stranger@evil.example"],
        ["일정", "상견례"],
        ["시작", "2026-09-20 12:00 (+09:00)"],
      ],
      [
        ["주문번호", "20260916-0000012"],
        ["바꿀 상태", "N30 (배송 중)"],
      ],
      [
        ["리뷰", "accounts/1/locations/2/reviews/abc"],
        ["내용", "방문해 주셔서 감사합니다!"],
      ],
    ]);
  }, 60_000);
});
