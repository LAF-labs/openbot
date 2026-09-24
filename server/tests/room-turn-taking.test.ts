import { describe, expect, test } from "bun:test";
import {
  CALLS_PER_PAIR,
  mentionsIn,
  speakersForRound,
  type TurnLine,
  whyNobodyIsNext,
} from "../src/rooms/turn-taking";

/**
 * Who speaks in a room, pinned rule by rule.
 *
 * Every Bot used to answer every round. The rule that replaced it decides from the roster and the
 * log alone — no model picks the next speaker — and the whole point of a deterministic rule is
 * that it can be written down here and argued with. Korean names first, because that is who this
 * is for: a person types `@민수님`, a Bot writes "민수님, …", and both have to mean 민수.
 */

const members = [
  { id: "minsu", name: "민수" },
  { id: "minsu2", name: "민수2" },
  { id: "risk", name: "리스크 분석가" },
  { id: "sales", name: "Sales" },
];

describe("reading who a message names", () => {
  test("an @ before a Korean name, with or without a particle glued on", () => {
    expect(mentionsIn("@민수 이거 확인해 줘", members)).toEqual(["minsu"]);
    expect(mentionsIn("@민수님, 이거 확인해 줘", members)).toEqual(["minsu"]);
    expect(mentionsIn("@민수야 봐 줘", members)).toEqual(["minsu"]);
    expect(mentionsIn("확인 부탁해요 @민수", members)).toEqual(["minsu"]);
  });

  test("a name with a space in it", () => {
    expect(mentionsIn("@리스크 분석가 규정 확인해 주세요", members)).toEqual([
      "risk",
    ]);
  });

  test("the longest name wins, so 민수2 is not 민수", () => {
    expect(mentionsIn("@민수2 부탁해", members)).toEqual(["minsu2"]);
    expect(mentionsIn("@민수 부탁해", members)).toEqual(["minsu"]);
  });

  test("Latin names compare without case", () => {
    expect(mentionsIn("@sales what were the Q3 numbers?", members)).toEqual([
      "sales",
    ]);
    expect(mentionsIn("@SALES?", members)).toEqual(["sales"]);
  });

  test("several names, each once, in the order they were first named", () => {
    expect(
      mentionsIn("@리스크 분석가 @민수 둘 다 봐 주세요 @민수", members),
    ).toEqual(["risk", "minsu"]);
  });

  test("an @ that names nobody in the room names nobody", () => {
    expect(mentionsIn("@사장님 확인 부탁드립니다", members)).toEqual([]);
    expect(mentionsIn("email me at a@b.com", members)).toEqual([]);
  });

  /*
   * THIS RUNS ON WHAT A PERSON TYPED, WHICH IS BOUNDED BY NOTHING (`rooms/service.ts`). The scan
   * walks every character, and a version of it that sliced the rest of the string at each one was
   * quadratic: a pasted spreadsheet would have held the room's turn for as long as it took to walk
   * that paste several million times over. Two hundred thousand characters, measured at ~50ms.
   */
  test("a name at the end of a very long paste is still read, and reading it stays cheap", () => {
    const pasted = `${"가나다라 마바사아 ".repeat(24_000)}민수님 확인 부탁해요.`;
    expect(pasted.length).toBeGreaterThan(200_000);
    const started = performance.now();
    expect(mentionsIn(pasted, members)).toEqual(["minsu"]);
    // Generous by two orders of magnitude against the measurement: this is here to catch the
    // quadratic shape coming back, not to hold a millisecond count on somebody's laptop.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("a bare name that opens the message is addressing that colleague", () => {
    expect(mentionsIn("민수님, 이거 봐 줘", members)).toEqual(["minsu"]);
    expect(mentionsIn("민수야 이거 봐", members)).toEqual(["minsu"]);
    expect(mentionsIn("  리스크 분석가: 규정은요?", members)).toEqual(["risk"]);
    expect(mentionsIn("민수", members)).toEqual(["minsu"]);
    expect(mentionsIn("민수에게 묻겠습니다", members)).toEqual(["minsu"]);
  });

  /*
   * WHERE THE CONVERSATION USED TO DIE. A bare name counted only at the START of a message, and
   * polite Korean puts the report first and the question second — so the sentence a member
   * actually writes to bring a colleague in named nobody, and the round after it ended
   * `nobody-named`. Measured before this on nine sentences of the kind these prompts produce:
   * four named nobody, every one of them a direct question to a colleague.
   */
  test("an honorific makes a name an address wherever it sits in the sentence", () => {
    expect(
      mentionsIn("매출은 12% 올랐어요. 민수님은 어떻게 보세요?", members),
    ).toEqual(["minsu"]);
    expect(mentionsIn("매출은 올랐고, 민수님 재고 좀 봐 주세요.", members)) //
      .toEqual(["minsu"]);
    expect(mentionsIn("이건 민수에게 물어봐야겠네요", members)).toEqual([
      "minsu",
    ]);
    expect(mentionsIn("그럼 리스크 분석가님께 넘기겠습니다", members)).toEqual([
      "risk",
    ]);
  });

  test("everybody in a list of names is being asked, not only the first", () => {
    expect(mentionsIn("민수, 리스크 분석가 둘 다 봐 주세요", members)).toEqual([
      "minsu",
      "risk",
    ]);
    expect(mentionsIn("확인은 민수님과 리스크 분석가님이 해 주세요", members)) //
      .toEqual(["minsu", "risk"]);
  });

  test("a bare name in the middle of a sentence is talking about, not to", () => {
    // Pulling a Bot in whenever it is mentioned is every-Bot-every-round by another route.
    expect(mentionsIn("아까 민수가 말한 대로 하죠", members)).toEqual([]);
    expect(mentionsIn("민수가 말한 대로 하죠", members)).toEqual([]);
    expect(mentionsIn("민수는 어떻게 생각해요?", members)).toEqual([]);
    expect(mentionsIn("리스크 분석가의 의견에 동의합니다", members)).toEqual(
      [],
    );
    // 와/과 joins two names being TALKED ABOUT; neither of them is addressed, so the list rule
    // above must not reach it — it only ever runs on from a name that already counted.
    expect(mentionsIn("민수와 리스크 분석가의 의견이 갈렸네요", members)) //
      .toEqual([]);
  });
});

describe("who speaks in a round", () => {
  const roster = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const ids = (speakers: { member: { id: string } }[]) =>
    speakers.map((speaker) => speaker.member.id);
  const line = (agentId: string, text: string): TurnLine => ({
    agentId,
    text,
  });

  test("round 0 is the person's: whoever they named, or everybody", () => {
    const named = speakersForRound({
      members: roster,
      round: 0,
      addressedIds: ["c", "a"],
      said: [],
    });
    expect(ids(named)).toEqual(["a", "c"]);
    expect(named.every((speaker) => speaker.reason === "addressed")).toBe(true);

    const everybody = speakersForRound({
      members: roster,
      round: 0,
      addressedIds: [],
      said: [],
    });
    expect(ids(everybody)).toEqual(["a", "b", "c"]);
    expect(everybody.every((speaker) => speaker.reason === "everybody")).toBe(
      true,
    );
  });

  test("naming only strangers falls back to everybody rather than nobody", () => {
    expect(
      ids(
        speakersForRound({
          members: roster,
          round: 0,
          addressedIds: ["zzz"],
          said: [],
        }),
      ),
    ).toEqual(["a", "b", "c"]);
  });

  test("after round 0 only a Bot a colleague named speaks, and it says who", () => {
    const speakers = speakersForRound({
      members: roster,
      round: 1,
      addressedIds: [],
      said: [line("a", "@C 규정 확인해 줄래?"), line("b", "저는 괜찮습니다")],
    });
    expect(speakers).toEqual([
      { member: roster[2], reason: "named", namedBy: "a" },
    ]);
  });

  test("a round where nobody named anybody has no speakers", () => {
    expect(
      speakersForRound({
        members: roster,
        round: 1,
        addressedIds: ["a"],
        said: [line("a", "다 정리했습니다"), line("b", "네")],
      }),
    ).toEqual([]);
  });

  test("a Bot naming itself pulls nobody in", () => {
    expect(
      speakersForRound({
        members: roster,
        round: 1,
        addressedIds: [],
        said: [line("a", "@A 제가 하겠습니다")],
      }),
    ).toEqual([]);
  });

  test("a Bot that answered after being named is not asked again until it is named again", () => {
    const said = [
      line("a", "@B 확인해 줘"),
      line("b", "확인했습니다"),
      line("c", "저도 봤어요"),
    ];
    expect(
      speakersForRound({ members: roster, round: 1, addressedIds: [], said }),
    ).toEqual([]);

    // Named again, after it answered: asked again.
    expect(
      ids(
        speakersForRound({
          members: roster,
          round: 2,
          addressedIds: [],
          said: [...said, line("c", "@B 하나 더요")],
        }),
      ),
    ).toEqual(["b"]);
  });

  test("the person's chips do not carry past round 0", () => {
    // Being addressed by the person buys the first round only; after that a colleague has to ask.
    expect(
      speakersForRound({
        members: roster,
        round: 1,
        addressedIds: ["a", "b", "c"],
        said: [line("a", "네"), line("b", "네"), line("c", "네")],
      }),
    ).toEqual([]);
  });

  test("the order rotates by round, so the same Bot does not open every round", () => {
    const said = [line("a", "@B @C 둘 다 의견 주세요")];
    expect(
      ids(
        speakersForRound({ members: roster, round: 1, addressedIds: [], said }),
      ),
    ).toEqual(["c", "b"]);
    expect(
      ids(
        speakersForRound({ members: roster, round: 2, addressedIds: [], said }),
      ),
    ).toEqual(["b", "c"]);
  });

  test("an empty roster has no speakers in any round", () => {
    expect(
      speakersForRound({ members: [], round: 0, addressedIds: [], said: [] }),
    ).toEqual([]);
  });
});

/*
 * TWO BOTS WITHOUT THE DATA HANDED IT TO EACH OTHER UNTIL THE ROUND CAP. Measured 2026-09-21 and
 * 2026-09-23 against the deployment's model, three runs out of three: asked why sales fell with no
 * figures in the room, 재고봇 and 매출봇 named each other every round — each "do you have it?"
 * was a naming, and a naming is what continues the room. A call and a call back are a
 * conversation; the second call back is the same missing thing going round again.
 */
describe("calling each other back", () => {
  const roster = [
    { id: "sales", name: "매출봇" },
    { id: "stock", name: "재고봇" },
    { id: "review", name: "리뷰봇" },
  ];
  const line = (agentId: string, text: string): TurnLine => ({
    agentId,
    text,
  });
  const next = (said: TurnLine[]) =>
    speakersForRound({ members: roster, round: 1, addressedIds: [], said });

  test("a call and one call back are a conversation: A→B→A is answered", () => {
    const said = [
      line("stock", "@매출봇 상품별 매출 알려 주실 수 있나요?"),
      line("sales", "@재고봇 아직 못 뽑았어요. 재고 쪽은 어때요?"),
    ];
    expect(next(said)).toEqual([
      { member: roster[1], reason: "named", namedBy: "sales" },
    ]);
  });

  test("the second call back between the same two pulls nobody in, and says why", () => {
    // The measured run, up to where it starts to repeat.
    const said = [
      line("stock", "@매출봇 상품별로 내려 주실 수 있나요?"),
      line("sales", "@재고봇 아직 메뉴별 수치는 못 뽑았어요."),
      line(
        "stock",
        "@매출봇 자료가 다들 없는 상태라 지금은 맞춰 볼 수가 없네요.",
      ),
    ];
    expect(CALLS_PER_PAIR).toBe(2);
    expect(next(said)).toEqual([]);
    expect(whyNobodyIsNext({ members: roster, said })).toBe("back-and-forth");
  });

  test("a turn where nobody named anybody still ends as nobody-named", () => {
    const said = [
      line("stock", "재고 자료가 없어요. 재고 현황 주시면 볼게요."),
      line("sales", "매출 자료도 없어요. 주시면 정리할게요."),
    ];
    expect(next(said)).toEqual([]);
    expect(whyNobodyIsNext({ members: roster, said })).toBe("nobody-named");
  });

  test("a call answered in full is not a call left hanging", () => {
    // A→B→A, and A answered without calling again: settled, not stopped.
    const said = [
      line("stock", "@매출봇 상품별 매출 알려 주실 수 있나요?"),
      line("sales", "@재고봇 라떼가 제일 많이 빠졌어요. 우유 재고는요?"),
      line("stock", "우유는 이틀 치 남았어요."),
    ];
    expect(next(said)).toEqual([]);
    expect(whyNobodyIsNext({ members: roster, said })).toBe("nobody-named");
  });

  test("a call to a third member still continues the room, past a pair that is spent", () => {
    const said = [
      line("stock", "@매출봇 상품별 매출 있어요?"),
      line("sales", "@재고봇 없어요. 재고는요?"),
      line("stock", "@매출봇 저도 없어요. 리뷰봇님은 최근 불만 본 거 있어요?"),
    ];
    // 매출봇 is not pulled back in; 리뷰봇, asked for the first time, is.
    expect(next(said)).toEqual([
      { member: roster[2], reason: "named", namedBy: "stock" },
    ]);
  });

  test("a spent pair does not stop a third member bringing either of them back", () => {
    const said = [
      line("stock", "@매출봇 상품별 매출 있어요?"),
      line("sales", "@재고봇 없어요. 재고는요?"),
      line("stock", "@매출봇 저도 없어요."),
      line("review", "@매출봇 배달 매출만 따로 볼 수 있어요?"),
    ];
    expect(next(said)).toEqual([
      { member: roster[0], reason: "named", namedBy: "review" },
    ]);
  });

  test("naming the same colleague twice before it answers is one call, not a call back", () => {
    // Two messages in a row from 재고봇, both to 매출봇: 매출봇 has not called back yet.
    const said = [
      line("stock", "@매출봇 상품별 매출 있어요?"),
      line("stock", "매출봇님, 특히 라떼 쪽이요."),
      line("sales", "@재고봇 라떼 310잔이에요. 우유는 넉넉해요?"),
    ];
    expect(next(said)).toEqual([
      { member: roster[1], reason: "named", namedBy: "sales" },
    ]);
  });

  test("a follow-up the same way after an answer is still the one call", () => {
    // 재고봇 asks, 매출봇 answers without calling back, 재고봇 asks more: nothing has reversed.
    const said = [
      line("stock", "@매출봇 상품별 매출 있어요?"),
      line("sales", "라떼 310잔, 아메리카노 420잔이에요."),
      line("stock", "@매출봇 바닐라라떼는요?"),
    ];
    expect(next(said)).toEqual([
      { member: roster[0], reason: "named", namedBy: "stock" },
    ]);
  });
});
