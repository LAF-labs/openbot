import { describe, expect, test } from "bun:test";
import {
  heardFromList,
  heardOf,
  placeReceipts,
  receiptTurns,
  withoutReceiptTurns,
} from "../src/lib/channels/room-receipts";
import { standingFailures } from "../src/lib/channels/retry";

/**
 * WHERE A ROOM TURN'S RECEIPT GOES. Measured 2026-09-21: a Bot that chose not to speak looked as
 * if it were not in the room at all. The receipt is the room's answer — the quiet members' faces at
 * the end of the turn — and these pin where "the end of the turn" is.
 */

const ORDER = ["sales", "stock", "review"];

const user = (id: string) => ({ id, role: "user", content: "질문" });
const reply = (id: string, content = "답") => ({
  id,
  role: "assistant",
  content,
});

describe("where a turn's receipt goes", () => {
  test("under the last thing said in answer, before the person's next message", () => {
    const placed = placeReceipts(
      [user("q1"), reply("a1"), reply("a2"), user("q2"), reply("b1")],
      { q1: { sales: "spoke", stock: "passed", review: "spoke" } },
      null,
      ORDER,
    );
    expect(placed).toEqual({
      a2: [{ memberId: "stock", outcome: "passed", questionId: "q1" }],
    });
  });

  test("under the person's own message when nobody answered at all", () => {
    const placed = placeReceipts(
      [user("q1")],
      { q1: { review: "passed", sales: "passed" } },
      null,
      ORDER,
    );
    // In the room's own order, whatever order the stored object came back in.
    expect(placed.q1?.map((mark) => mark.memberId)).toEqual([
      "sales",
      "review",
    ]);
  });

  test("a member whose words are in the room, or that a stop cut off, draws nothing", () => {
    const placed = placeReceipts(
      [user("q1"), reply("a1")],
      { q1: { sales: "spoke", stock: "stopped" } },
      null,
      ORDER,
    );
    expect(placed).toEqual({});
  });

  test("failures and timeouts are drawn beside the quiet ones, as themselves", () => {
    const placed = placeReceipts(
      [user("q1"), reply("a1")],
      { q1: { sales: "failed", stock: "passed", review: "timed_out" } },
      null,
      ORDER,
    );
    expect(placed.a1?.map((mark) => [mark.memberId, mark.outcome])).toEqual([
      ["sales", "failed"],
      ["stock", "passed"],
      ["review", "timed_out"],
    ]);
  });

  test("a reply that has not said anything yet does not take the receipt from the one above it", () => {
    const placed = placeReceipts(
      [user("q1"), reply("a1"), reply("typing", "")],
      { q1: { stock: "passed" } },
      null,
      ORDER,
    );
    expect(Object.keys(placed)).toEqual(["a1"]);
  });
});

describe("the turn still running", () => {
  test("grows as members settle, and a member being asked again is not what the record said", () => {
    const placed = placeReceipts(
      [user("q1"), reply("a1")],
      { q1: { stock: "passed", review: "failed" } },
      // 다시 묻기 on 리뷰봇: it is working now, not failed; 매출봇 has just read it and passed.
      { asked: ["review", "sales"], settled: { sales: "passed" } },
      ORDER,
    );
    expect(placed.a1?.map((mark) => [mark.memberId, mark.outcome])).toEqual([
      ["sales", "passed"],
      ["stock", "passed"],
    ]);
  });

  test("only the last question is live; older receipts are the record", () => {
    const placed = placeReceipts(
      [user("q1"), reply("a1"), user("q2")],
      { q1: { stock: "passed" } },
      { asked: ["stock"], settled: {} },
      ORDER,
    );
    expect(placed).toEqual({
      a1: [{ memberId: "stock", outcome: "passed", questionId: "q1" }],
    });
  });
});

describe("which turns the receipt speaks for", () => {
  test("the question and every reply under it, for turns that left one — and nothing older", () => {
    const covered = receiptTurns(
      [
        user("q0"),
        reply("z1"),
        user("q1"),
        reply("a1"),
        reply("a2"),
        user("q2"),
      ],
      { q1: { stock: "timed_out" } },
    );
    // A reply the timeout harvest kept is whole; a red "took too long" under it would say otherwise.
    expect([...covered]).toEqual(["q1", "a1", "a2"]);
  });
});

describe("a reply the timeout harvest kept", () => {
  /*
   * Measured 2026-09-24: 리뷰봇's run hit its deadline with a finished message, which was delivered
   * (`member-turn.ts`). Its run ended in error with that reply as its last message, so the failures
   * read keyed "the model took too long" to the reply — drawn in red under an answer that arrived.
   */
  const messages = [user("q1"), reply("late", "늦었지만 제 답은 이거예요.")];
  const stored = [
    {
      messageId: "late",
      code: "laf:turn_timed_out",
      at: "2026-09-24T00:07:20.000Z",
    },
  ];
  const times = {
    q1: "2026-09-24T00:02:19.000Z",
    late: "2026-09-24T00:07:19.000Z",
  };

  test("is an answer, not a failure, once the turn's receipt says so", () => {
    const standing = standingFailures(stored, messages, times);
    // The transcript's own rule alone keeps the line: a failure under a reply always stands.
    expect(Object.keys(standing)).toEqual(["late"]);
    expect(
      withoutReceiptTurns(standing, messages, { q1: { review: "spoke" } }),
    ).toEqual({});
  });

  test("a turn from before receipts keeps its line", () => {
    const standing = standingFailures(stored, messages, times);
    expect(Object.keys(withoutReceiptTurns(standing, messages, {}))).toEqual([
      "late",
    ]);
  });
});

describe("reading what arrives", () => {
  test("a stored receipt keeps only kinds this surface has words for", () => {
    expect(heardOf({ a: "passed", b: "nonsense", c: 3 })).toEqual({
      a: "passed",
    });
    expect(heardOf(null)).toEqual({});
    expect(heardOf(["passed"])).toEqual({});
  });

  test("a frame's list keeps only well-formed entries", () => {
    expect(
      heardFromList([
        { id: "a", outcome: "timed_out" },
        { id: 7, outcome: "passed" },
        { id: "b" },
        null,
      ]),
    ).toEqual({ a: "timed_out" });
    expect(heardFromList(undefined)).toEqual({});
  });
});
