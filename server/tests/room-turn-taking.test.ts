import { describe, expect, test } from "bun:test";
import {
  mentionsIn,
  speakersForRound,
  type TurnLine,
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

  test("a bare name that opens the message is addressing that colleague", () => {
    expect(mentionsIn("민수님, 이거 봐 줘", members)).toEqual(["minsu"]);
    expect(mentionsIn("민수야 이거 봐", members)).toEqual(["minsu"]);
    expect(mentionsIn("  리스크 분석가: 규정은요?", members)).toEqual(["risk"]);
    expect(mentionsIn("민수", members)).toEqual(["minsu"]);
    expect(mentionsIn("민수에게 묻겠습니다", members)).toEqual(["minsu"]);
  });

  test("a bare name in the middle of a sentence is talking about, not to", () => {
    // Pulling a Bot in whenever it is mentioned is every-Bot-every-round by another route.
    expect(mentionsIn("아까 민수가 말한 대로 하죠", members)).toEqual([]);
    expect(mentionsIn("민수가 말한 대로 하죠", members)).toEqual([]);
    expect(mentionsIn("민수는 어떻게 생각해요?", members)).toEqual([]);
    expect(mentionsIn("리스크 분석가의 의견에 동의합니다", members)).toEqual(
      [],
    );
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
