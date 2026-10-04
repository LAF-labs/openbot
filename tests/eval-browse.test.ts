import { describe, expect, test } from "bun:test";
import {
  echoedForm,
  type FiledMessage,
  roundStats,
  roundsOf,
  unaskedFields,
  wrongFields,
} from "../evals/browse-measure";

/**
 * THE JUDGES OF `eval:browse`, JUDGED.
 *
 * The runs call a real model against a real site and never run in the gate. What decides whether a
 * sentence goes into every Bot's prompt is two readings of such a run — how the model asked for its
 * steps, and what the site says it received — and a reading that could not come out wrong would
 * call every arm a success. The threads and echoes below are written by hand.
 */

type Asked = { id: string; name: string };

const reply = (...calls: Asked[]): FiledMessage => ({
  role: "assistant",
  toolCalls: calls.map((call) => ({
    id: call.id,
    function: { name: call.name },
  })),
});
const answer = (toolCallId: string, content: unknown): FiledMessage => ({
  role: "tool",
  toolCallId,
  content: typeof content === "string" ? content : JSON.stringify(content),
});
const NOT_REACHED = { ok: false, code: "laf:step_not_reached", reason: "…" };

describe("the rounds of a run, read off its thread", () => {
  test("each reply that asked for tools is a round, its calls in the order written", () => {
    const rounds = roundsOf([
      { role: "system", content: "…" },
      { role: "user", content: "양식을 채워 줘" },
      reply({ id: "n1", name: "computer_navigate" }),
      answer("n1", { ok: true, url: "https://shop.example/form" }),
      // Prose between two rounds is a reply, and not a round: it asked for nothing.
      { role: "assistant", content: "양식을 볼게요." },
      reply(
        { id: "s1", name: "computer_snapshot" },
        { id: "t1", name: "computer_type" },
      ),
      answer("s1", { ok: true, snapshotId: 3 }),
      answer("t1", { ok: false, code: "laf:stale_refs", reason: "…" }),
      { role: "assistant", content: "끝났어요." },
    ]);
    expect(rounds).toEqual([
      [{ name: "computer_navigate", ok: true }],
      [
        { name: "computer_snapshot", ok: true },
        { name: "computer_type", ok: false, code: "laf:stale_refs" },
      ],
    ]);
  });

  test("a sentence for an answer went through, and a call nothing answered did not", () => {
    const rounds = roundsOf([
      reply({ id: "w1", name: "now" }, { id: "c1", name: "computer_click" }),
      // The clock answers in words, as a lookup does: not an envelope, and not a failure.
      answer("w1", "2026년 10월 5일 월요일 오후 3시"),
    ]);
    expect(rounds).toEqual([
      [
        { name: "now", ok: true },
        { name: "computer_click", ok: false },
      ],
    ]);
  });

  test("a round is batched at two acting steps: a look at the page is not one", () => {
    const stats = roundStats([
      // One step and a look: today's shape, a reply per field.
      [
        { name: "computer_snapshot", ok: true },
        { name: "computer_type", ok: true },
      ],
      [
        { name: "computer_type", ok: true },
        { name: "computer_type", ok: true },
        { name: "computer_click", ok: true },
        { name: "computer_read", ok: true },
      ],
      [{ name: "remember", ok: true }],
    ]);
    expect(stats.rounds).toBe(3);
    expect(stats.callsPerRound).toEqual([2, 4, 1]);
    expect(stats.actingPerRound).toEqual([1, 3, 0]);
    expect(stats.batchedRounds).toBe(1);
    expect(stats.notReached).toBe(0);
    expect(stats.clicksBeforeFields).toBe(0);
  });

  test("a press written before its fields is counted, and so is everything it left unreached", () => {
    const rounds = roundsOf([
      reply(
        { id: "c1", name: "computer_click" },
        { id: "t1", name: "computer_type" },
        { id: "t2", name: "computer_type" },
        { id: "s1", name: "computer_snapshot" },
      ),
      // The press sent the form: the page moved, and the fields after it were never typed.
      answer("c1", { ok: true, page: { url: "https://shop.example/sent" } }),
      answer("t1", NOT_REACHED),
      answer("t2", NOT_REACHED),
      answer("s1", { ok: true, snapshotId: 4 }),
    ]);
    const stats = roundStats(rounds);
    expect(stats.batchedRounds).toBe(1);
    expect(stats.clicksBeforeFields).toBe(1);
    expect(stats.notReached).toBe(2);
  });

  test("a press is before a field only inside one batched reply", () => {
    const stats = roundStats([
      // A radio ticked between two text fields counts by position, and leaves nothing unreached.
      [
        { name: "computer_type", ok: true },
        { name: "computer_click", ok: true },
        { name: "computer_type", ok: true },
        { name: "computer_click", ok: true },
      ],
      // A press alone in its reply, with the fields typed in the next one, is not a batch.
      [{ name: "computer_click", ok: true }],
      [{ name: "computer_type", ok: true }],
      // A refusal that is not the round-stop's is not counted as unreached.
      [
        { name: "computer_click", ok: false, code: "laf:policy_denied" },
        { name: "computer_key", ok: false, code: "laf:step_not_reached" },
      ],
    ]);
    expect(stats.clicksBeforeFields).toBe(1);
    expect(stats.batchedRounds).toBe(2);
    expect(stats.notReached).toBe(1);
  });
});

/** httpbin's answer to a form it was sent, as the page prints it: escapes and all. */
const ECHO_PAGE = JSON.stringify(
  {
    args: {},
    data: "",
    files: {},
    form: {
      comments: "문 앞에 놓아 주세요",
      custemail: "gildong@example.com",
      custname: "홍길동",
      custtel: "010-0000-0000",
      delivery: "",
      size: "medium",
      topping: "mushroom",
    },
    headers: { Host: "httpbin.org" },
    json: null,
    url: "https://httpbin.org/post",
  },
  null,
  2,
).replace(/[\u0080-￿]/g, (ch) => {
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
});

const ASKED = {
  custname: "홍길동",
  custtel: "010-0000-0000",
  custemail: "gildong@example.com",
  size: "medium",
  topping: "mushroom",
  comments: "문 앞에 놓아 주세요",
};

describe("a form judged by what the site says it received", () => {
  test("the echo is found in the page, in an outcome holding it, and in the outcome as filed", () => {
    expect(ECHO_PAGE).toContain("\\ud64d");
    const read = { ok: true, url: "https://httpbin.org/post", text: ECHO_PAGE };
    const pressed = {
      ok: true,
      action: "click",
      page: { url: "https://httpbin.org/post", title: "", text: ECHO_PAGE },
    };
    for (const source of [
      ECHO_PAGE,
      `httpbin.org/post\n${ECHO_PAGE}\n`,
      read,
      pressed,
      JSON.stringify(pressed),
    ]) {
      expect(wrongFields(echoedForm(source), ASKED)).toEqual([]);
      expect(echoedForm(source)?.custname).toBe("홍길동");
    }
  });

  test("a page that is not an echo is no echo, and then every asked field is wrong", () => {
    for (const source of [
      "Customer name: Telephone: E-mail address: Submit order",
      { ok: true, text: "Example Domain", url: "https://example.com/" },
      { ok: false, code: "laf:page_timeout" },
      '{ "form": { "custname": "홍길',
      null,
    ]) {
      expect(echoedForm(source)).toBeNull();
    }
    expect(wrongFields(null, ASKED)).toEqual(Object.keys(ASKED));
  });

  test("a field is wrong when the site got something else, nothing, or it in another field", () => {
    const form = (changed: Record<string, unknown>) => ({
      ...(echoedForm(ECHO_PAGE) ?? {}),
      ...changed,
    });
    expect(wrongFields(form({ size: "large" }), ASKED)).toEqual(["size"]);
    // Sent before the last field was typed: the site has an empty string for it.
    expect(wrongFields(form({ comments: "" }), ASKED)).toEqual(["comments"]);
    // A radio nobody ticked is not in the form at all.
    const { size: _unticked, ...unticked } = form({});
    expect(wrongFields(unticked, ASKED)).toEqual(["size"]);
    // The telephone typed into the name's box and the name into the telephone's: two fields.
    expect(
      wrongFields(
        form({ custname: ASKED.custtel, custtel: ASKED.custname }),
        ASKED,
      ),
    ).toEqual(["custname", "custtel"]);
    // One box ticked may come back as a list of one; a second box beside it is not what was asked.
    expect(wrongFields(form({ topping: ["mushroom"] }), ASKED)).toEqual([]);
    expect(
      wrongFields(form({ topping: ["bacon", "mushroom"] }), ASKED),
    ).toEqual(["topping"]);
  });

  test("a field nobody asked for, filled, is named apart from the wrong ones", () => {
    const form = { ...(echoedForm(ECHO_PAGE) ?? {}), delivery: "12:30" };
    expect(wrongFields(form, ASKED)).toEqual([]);
    expect(unaskedFields(form, ASKED)).toEqual(["delivery"]);
    // Left empty as asked, it is in the echo as an empty string and is nobody's invention.
    expect(unaskedFields(echoedForm(ECHO_PAGE), ASKED)).toEqual([]);
    expect(unaskedFields(null, ASKED)).toEqual([]);
  });
});
