import { describe, expect, test } from "bun:test";
import { roomKo } from "../../shared/prompt/mode/room.ko";
import {
  addressedMembers,
  isSilence,
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

    expect(prompt.startsWith('[Room: "출시 준비" - with 일상 비서]')).toBe(
      true,
    );
    expect(prompt).toContain("Participants: 일상 비서 (일상 업무)");
    expect(prompt).toContain("The room so far (oldest first):");
    expect(prompt).toContain("김기범 (user): 다음 주 출시 괜찮을까요?");
    expect(prompt).toContain("It's your turn, 리스크 분석가.");
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

    expect(prompt).toContain("리스크 분석가 (you): 확인 중입니다");
    expect(prompt).toContain("일상 비서: 일정은 제가 볼게요");
  });

  test("a room where nothing new was said says so rather than showing an empty list", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk],
      lines: [],
    });
    expect(prompt).toContain("Nothing has been said in the room yet.");
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

  test("winding down asks for silence unless it matters", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: risk,
      peers: [risk],
      lines: [said(null, "김기범", "정리해주세요")],
      windingDown: true,
    });
    expect(prompt).toContain("The room is wrapping up this turn");
  });
});

describe("whose turn it is", () => {
  const members = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("naming nobody means everybody, not the Bot that sorts first", () => {
    expect(addressedMembers(members, []).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("naming somebody means only them", () => {
    expect(addressedMembers(members, ["b"]).map((m) => m.id)).toEqual(["b"]);
  });

  test("naming only strangers falls back to everybody rather than nobody", () => {
    expect(addressedMembers(members, ["zzz"]).map((m) => m.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

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
    expect(prompt).not.toContain("김기범 (user): 0가");
  });

  test("one line over budget is still shown, cut", () => {
    const prompt = roomTurnPrompt({
      room: { name: "출시 준비" },
      member: { id: "risk-analyst", name: "리스크 분석가" },
      peers: [],
      lines: [said(null, "김기범", "나".repeat(40_000))],
    });
    expect(prompt).toContain("김기범 (user): 나");
    expect(prompt.length).toBeLessThan(30_000);
  });
});

describe("a Bot that had nothing to add", () => {
  test("nothing, whitespace and (pass) are all silence", () => {
    expect(isSilence("")).toBe(true);
    expect(isSilence("   \n ")).toBe(true);
    expect(isSilence("(pass)")).toBe(true);
    expect(isSilence("pass")).toBe(true);
    expect(isSilence("PASS")).toBe(true);
  });

  test("anything a room would want to read is not", () => {
    expect(isSilence("동의합니다")).toBe(false);
    expect(isSilence("pass the report over")).toBe(false);
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
