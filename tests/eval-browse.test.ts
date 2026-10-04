import { describe, expect, test } from "bun:test";
import {
  echoedForm,
  echoedSends,
  type FiledMessage,
  INVITATION,
  judgeForm,
  roundStats,
  roundsOf,
  unaskedFields,
  withInvitation,
  wrongFields,
} from "../evals/browse-measure";
import { BASE_KO, systemPromptText } from "../shared/prompt";

/**
 * THE JUDGES OF `eval:browse`, JUDGED.
 *
 * The runs call a real model against a real site and never run in the gate. What decides whether a
 * sentence goes into every Bot's prompt is two readings of such a run — how the model asked for its
 * steps, and what the site says it received — and a reading that could not come out wrong would
 * call every arm a success. So is the prompt the second arm reads: measured anywhere but where the
 * sentence would ship, the arm is a measurement of something else. The threads and echoes below are
 * written by hand.
 */

describe("the prompt of the second arm", () => {
  test("is today's prompt with one paragraph more, inside the base and ahead of everything after it", () => {
    for (const mode of ["chat", "routine"] as const) {
      const today = systemPromptText(mode, "맥락: 호칭은 사장님이다.");
      const before = today.split("\n\n");
      const after = withInvitation(today).split("\n\n");
      const at = after.indexOf(INVITATION);
      // One paragraph of its own, once, and every other byte where it was.
      expect(after.filter((paragraph) => paragraph === INVITATION)).toEqual([
        INVITATION,
      ]);
      expect([...after.slice(0, at), ...after.slice(at + 1)]).toEqual(before);
      // In the static layer's base — not after the context, where it was first measured.
      expect(at).toBeLessThan(BASE_KO.split("\n\n").length);
      // In front of the base's two paragraphs about the computer, which still follow in order.
      expect(after[at + 1]).toStartWith(
        "사람이 컴퓨터를 잡고 있다는 결과가 오면",
      );
      expect(after[at + 2]).toStartWith("이 배포의 정책이 막은 행동도");
      expect(after.at(-1)).toBe("맥락: 호칭은 사장님이다.");
    }
  });

  test("has no place in a prompt that does not begin with the base, and says so", () => {
    expect(() => withInvitation("너는 다른 봇이다.")).toThrow(/BASE_KO/);
    expect(() => withInvitation(`머리말\n\n${BASE_KO}`)).toThrow(/BASE_KO/);
  });
});

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
    expect(stats.earlyPresses).toBe(0);
  });

  test("a press that went through with steps still written after it is an early press", () => {
    const sent = { ok: true, page: { url: "https://shop.example/sent" } };
    const rounds = roundsOf([
      // 검색 pressed first: the page moved, and the fields after it were never typed.
      reply(
        { id: "c1", name: "computer_click" },
        { id: "t1", name: "computer_type" },
        { id: "t2", name: "computer_type" },
        { id: "s1", name: "computer_snapshot" },
      ),
      answer("c1", sent),
      answer("t1", NOT_REACHED),
      answer("t2", NOT_REACHED),
      answer("s1", { ok: true, snapshotId: 4 }),
      // Enter between two fields — which a count of clicks could not see.
      reply(
        { id: "t3", name: "computer_type" },
        { id: "k1", name: "computer_key" },
        { id: "t4", name: "computer_type" },
      ),
      answer("t3", { ok: true, characters: 3 }),
      answer("k1", sent),
      answer("t4", NOT_REACHED),
      // A field typed with `submit`, and the button under it written anyway.
      reply(
        { id: "t5", name: "computer_type" },
        { id: "c2", name: "computer_click" },
      ),
      answer("t5", { ...sent, submitted: true }),
      answer("c2", NOT_REACHED),
    ]);
    const stats = roundStats(rounds);
    expect(stats.earlyPresses).toBe(3);
    expect(stats.notReached).toBe(4);
  });

  test("a correct batch is no early press, and neither is a round a refusal ended", () => {
    const stats = roundStats([
      // httpbin's own order: a radio and a checkbox sit between the e-mail and the note. The count
      // by position that this replaced scored this, the best a model can do, as two mistakes.
      [
        { name: "computer_type", ok: true },
        { name: "computer_type", ok: true },
        { name: "computer_type", ok: true },
        { name: "computer_click", ok: true },
        { name: "computer_click", ok: true },
        { name: "computer_type", ok: true },
      ],
      // The policy refused the press: nothing was sent, and the rule did its work.
      [
        { name: "computer_click", ok: false, code: "laf:policy_denied" },
        { name: "computer_key", ok: false, code: "laf:step_not_reached" },
      ],
      // Held for a person nobody was there to be: the same.
      [
        { name: "computer_type", ok: true },
        { name: "computer_click", ok: false, code: "laf:nobody_answered" },
        { name: "computer_type", ok: false, code: "laf:step_not_reached" },
      ],
      // A new address always ends its round, and is not a press.
      [
        { name: "computer_navigate", ok: true },
        { name: "computer_type", ok: false, code: "laf:step_not_reached" },
      ],
    ]);
    expect(stats.earlyPresses).toBe(0);
    expect(stats.batchedRounds).toBe(4);
    expect(stats.notReached).toBe(3);
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

  test("a send is a press the site answered with an echo: a second look at it is not one", () => {
    const echo = {
      url: "https://httpbin.org/post",
      title: "",
      text: ECHO_PAGE,
    };
    const halfFilled = ECHO_PAGE.replace('"medium"', '""');
    const sends = echoedSends([
      reply({ id: "c1", name: "computer_click" }),
      answer("c1", {
        ok: true,
        action: "click",
        page: { ...echo, text: halfFilled },
      }),
      // Reading the echo page again, and opening an address, send nothing.
      reply(
        { id: "r1", name: "computer_read" },
        { id: "n1", name: "computer_navigate" },
      ),
      answer("r1", { ok: true, ...echo, text: halfFilled }),
      answer("n1", { ok: true, ...echo }),
      // A radio ticked: a press, and no echo.
      reply({ id: "c2", name: "computer_click" }),
      answer("c2", {
        ok: true,
        action: "click",
        url: "https://httpbin.org/forms/post",
      }),
      // The last field typed with Enter sends the form a second time.
      reply({ id: "t1", name: "computer_type" }),
      answer("t1", { ok: true, action: "type", submitted: true, page: echo }),
    ]);
    expect(sends.map((form) => form.size)).toEqual(["", "medium"]);
  });

  test("a form passes when it was sent once, from a clean tab, exactly as asked — and by nothing less", () => {
    const right = echoedForm(ECHO_PAGE) ?? {};
    const run = {
      startedClean: true,
      sends: [right],
      page: right,
      asked: ASKED,
    };
    expect(judgeForm(run)).toEqual({
      passed: true,
      echoed: true,
      sends: 1,
      wrongFields: [],
      unaskedFields: [],
    });
    // The Bot went somewhere else after sending: its one send still stands.
    expect(judgeForm({ ...run, page: null }).passed).toBe(true);

    // Sent half filled, then sent again right. The last echo used to win.
    const twice = judgeForm({
      ...run,
      sends: [{ ...right, comments: "" }, right],
    });
    expect([twice.passed, twice.sends, twice.wrongFields]).toEqual([
      false,
      2,
      [],
    ]);
    // The ask said to leave the delivery time empty.
    const filled = { ...right, delivery: "12:30" };
    const invented = judgeForm({ ...run, sends: [filled], page: filled });
    expect([invented.passed, invented.unaskedFields]).toEqual([
      false,
      ["delivery"],
    ]);
    // The tab could not be put on the neutral page: the echo on it may be the run before's.
    expect(judgeForm({ ...run, startedClean: false }).passed).toBe(false);
    // An echo on the tab that no press of this run brought back is the run before's.
    const stale = judgeForm({ ...run, sends: [] });
    expect([stale.passed, stale.sends, stale.echoed]).toEqual([false, 0, true]);
    // One send, one field wrong.
    const wrong = { ...right, size: "large" };
    expect(
      judgeForm({ ...run, sends: [wrong], page: wrong }).wrongFields,
    ).toEqual(["size"]);
    // Never sent at all.
    expect(judgeForm({ ...run, sends: [], page: null })).toEqual({
      passed: false,
      echoed: false,
      sends: 0,
      wrongFields: Object.keys(ASKED),
      unaskedFields: [],
    });
  });
});
