import { describe, expect, test } from "bun:test";
import { roomKo } from "../../shared/prompt/mode/room.ko";
import {
  ROOM_LINES,
  type RoomLine,
  roomTurnPrompt,
  rotate,
} from "../src/rooms/prompt";

const risk = {
  id: "risk-analyst",
  name: "리스크 분석가",
  description: "리스크·컴플라이언스",
};
const assistant = {
  id: "general-assistant",
  name: "일상 비서",
  description: "일상 업무",
};
const said = (
  agentId: string | null,
  name: string,
  text: string,
): RoomLine => ({
  agentId,
  name,
  text,
});

describe("what a Bot is shown of the room", () => {
  test("names the room, who else is in it, and whose turn it is", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk, assistant],
      lines: [said(null, "김기범", "다음 주 출시 괜찮을까요?")],
    });

    expect(
      prompt.startsWith('[방: "출시 준비" — 함께 있는 참가자: 일상 비서]'),
    ).toBe(true);
    expect(prompt).toContain("참가자: 일상 비서(일상 업무)");
    expect(prompt).toContain("지금까지 방에서 오간 말 (오래된 것부터):");
    expect(prompt).toContain("김기범(사람): 다음 주 출시 괜찮을까요?");
    expect(prompt).toContain("리스크 분석가, 네 차례다.");
  });

  /*
   * THE WHOLE BLOCK IS KOREAN, AND THAT IS THE POINT RATHER THAN A TIDY-UP.
   *
   * This was the last eight lines of every member's request, in English, in capitals, behind a
   * thousand characters of Korean — the base prompt, the room mode and the person's own words.
   * The last instruction is the strongest one a model reads, and it was in the wrong language.
   */
  test("nothing in the block is English", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk, assistant],
      lines: [said(null, "김기범", "다음 주 출시 괜찮을까요?")],
      reason: "everybody",
      answeringNow: 2,
      windingDown: true,
    });
    // `send_message` is a tool name, not prose: it is what the Bot must call, spelled as it is
    // registered. Everything else that is Latin letters would be English words.
    const latin = prompt.replace(/send_message|@이름/g, "").match(/[A-Za-z]+/g);
    expect(latin).toBeNull();
  });

  test("a Bot's own line is marked as its own, so it does not answer itself", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk, assistant],
      lines: [
        said("risk-analyst", "리스크 분석가", "확인 중입니다"),
        said("general-assistant", "일상 비서", "일정은 제가 볼게요"),
      ],
    });

    expect(prompt).toContain("리스크 분석가(나): 확인 중입니다");
    expect(prompt).toContain("일상 비서: 일정은 제가 볼게요");
  });

  test("a room where nothing new was said says so rather than showing an empty list", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk],
      lines: [],
    });
    expect(prompt).toContain("아직 방에서 오간 말이 없다.");
  });

  /*
   * WHY THIS MEMBER IS SPEAKING, WHICH USED TO REACH THE AUDIT ROW AND NOTHING ELSE.
   *
   * The three reasons are three different turns: a colleague's unanswered question, one of
   * several parallel answers to the person, or the person asking this Bot in particular. Handed
   * the same prompt for all three, a member pulled in by a colleague greeted, agreed and
   * summarised instead of answering what it was asked.
   */
  describe("why this member is speaking", () => {
    const base = {
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk, assistant],
      lines: [said(null, "김기범", "다음 주 출시 괜찮을까요?")],
    };

    test("a colleague called it in, and the colleague is named", () => {
      const prompt = roomTurnPrompt({
        ...base,
        reason: "named",
        namedBy: "일상 비서",
        answeringNow: 1,
      });
      expect(prompt).toContain("일상 비서가 너를 불렀다");
      expect(prompt).toContain("너에게 온 것에 먼저 답한다");
    });

    /* The particle is chosen, not guessed: "매출봇가 너를 불렀다" is the Bot's own first sentence. */
    test("the subject particle follows the colleague's name", () => {
      const withBatchim = roomTurnPrompt({
        ...base,
        reason: "named",
        namedBy: "재고봇",
        answeringNow: 1,
      });
      expect(withBatchim).toContain("재고봇이 너를 불렀다");
      const without = roomTurnPrompt({
        ...base,
        reason: "named",
        namedBy: "매출비서",
        answeringNow: 1,
      });
      expect(without).toContain("매출비서가 너를 불렀다");
    });

    test("one of several answering the same question is told how many", () => {
      const prompt = roomTurnPrompt({
        ...base,
        reason: "everybody",
        answeringNow: 4,
      });
      expect(prompt).toContain("4명이 같은 질문에 함께 답한다");
      expect(prompt).toContain("인사와 질문 되풀이는 빼고");
    });

    test("the person naming this Bot says so, and asks for nothing else", () => {
      const prompt = roomTurnPrompt({
        ...base,
        reason: "addressed",
        answeringNow: 1,
      });
      expect(prompt).toContain("사람이 너를 지목했다");
      expect(prompt).not.toContain("함께 답한다");
    });
  });

  test("only the last two dozen lines are shown", () => {
    const lines = Array.from({ length: ROOM_LINES + 10 }, (_, at) =>
      said(null, "김기범", `line ${at}`),
    );
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk],
      lines,
    });
    expect(prompt).not.toContain("line 0");
    expect(prompt).toContain(`line ${ROOM_LINES + 9}`);
  });

  /*
   * IT USED TO ASK FOR SILENCE — "reply only if it's essential, otherwise stay silent" — so the
   * last round of a room turn was usually empty and the conversation stopped mid-air rather than
   * ending. Asking to CLOSE is what makes a turn finish instead of run out.
   */
  test("winding down asks for a close, not for silence", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk],
      lines: [said(null, "김기범", "정리해주세요")],
      windingDown: true,
    });
    expect(prompt).toContain("마지막 바퀴다");
    expect(prompt).toContain("한 문장으로 맺는다");
    expect(prompt).toContain("새 주제나 새 질문을 열지 말고");
  });
});

/*
 * Who is addressed is `speakersForRound`'s question, and `room-turn-taking.test.ts` asks it.
 */
describe("whose turn it is", () => {
  const members = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("the order rotates, so the same Bot does not open every round", () => {
    expect(rotate(members, 0).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(rotate(members, 1).map((m) => m.id)).toEqual(["b", "c", "a"]);
    expect(rotate(members, 4).map((m) => m.id)).toEqual(["b", "c", "a"]);
    expect(rotate([], 3)).toEqual([]);
  });
});

describe("what a room turn may cost", () => {
  /*
   * The per-line cut is not a bound on the prompt. Twenty-four lines of eight thousand characters
   * is a hundred and ninety-two thousand — in Korean, roughly that many tokens — and a room where a
   * few people pasted a few long things would stop answering for everybody, all at once.
   */
  test("the whole room block is bounded, and it is the newest lines that survive", () => {
    const long = "가".repeat(8_000);
    const lines = Array.from({ length: 24 }, (_, at) =>
      said(null, "김기범", `${at}${long}`),
    );
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: { id: "risk-analyst", name: "리스크 분석가" },
      peers: [],
      lines,
    });
    expect(prompt.length).toBeLessThan(30_000);
    // The end of the conversation is what a room is understood from.
    expect(prompt).toContain("23");
    expect(prompt).not.toContain("김기범(사람): 0가");
  });

  test("one line over budget is still shown, cut", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: { id: "risk-analyst", name: "리스크 분석가" },
      peers: [],
      lines: [said(null, "김기범", "나".repeat(40_000))],
    });
    expect(prompt).toContain("김기범(사람): 나");
    expect(prompt.length).toBeLessThan(30_000);
  });
});

/*
 * The conduct moved to `shared/prompt/mode/room.ko.ts` and is now Korean, composed by the one
 * middleware every run path goes through. The PROTOCOL did not move: `send_message` is still the
 * only thing the room can see, and a turn without it is still silence. That is what these pin —
 * the room is the half of the product where the prompt IS the protocol, so a paraphrase that lost
 * a clause would be a room where Bots write into the void.
 */
describe("how a Bot is told to behave in a room", () => {
  test("says silence is a move and that only the tool reaches the room", () => {
    const conduct = roomKo(risk.name);
    expect(conduct).toContain("끝까지 리스크 분석가로 있는다");
    expect(conduct).toContain("send_message");
    expect(conduct).toContain("침묵은 제대로 된 선택이고");
  });

  /*
   * The one rule that keeps a room conversation alive — only a colleague somebody NAMED speaks
   * again — used to be stated in English, in `roomTurnPrompt`, and nowhere else. The Korean
   * conduct said "call their name if it helps", which is not a rule and does not mention `@`.
   * A model writing Korean follows what it was told in Korean.
   */
  test("says how to bring a colleague in, and what happens if nobody does", () => {
    const conduct = roomKo(risk.name);
    expect(conduct).toContain("`@이름`으로 부른다");
    expect(conduct).toContain("부르지 않으면 대화는 여기서 끝난다");
    expect(conduct).toContain("인사말·자기소개·동의만 하는 말은 하지 않는다");
  });

  /*
   * THE CONTRADICTION THIS ENDED.
   *
   * The base prompt used to say "say what you found in plain language" and this used to say plain
   * text is invisible — two files that had never read each other, arriving in one request. The
   * base says nothing about plain text now; the room owns it, and nothing else may claim it back.
   */
  test("the base prompt leaves plain text alone, and the room does not", async () => {
    const { BASE_KO } = await import("../../shared/prompt/base.ko");
    expect(BASE_KO).not.toContain("plain");
    expect(BASE_KO).not.toContain("그냥 쓴 글");
    expect(roomKo(risk.name)).toContain(
      "그냥 쓴 글이 아무에게도 보이지 않는다",
    );
  });
});
