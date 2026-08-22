import { describe, expect, test } from "bun:test";
import {
  addressedMembers,
  isSilence,
  linesSince,
  ROOM_LINES,
  type RoomLine,
  roomConduct,
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
    expect(prompt).toContain("New messages in the room (oldest first):");
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
    expect(prompt).toContain(
      "No new messages in the room since your last turn.",
    );
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

describe("which lines a Bot has not seen", () => {
  test("everything said after its own last line", () => {
    const lines = [
      said(null, "김기범", "하나"),
      said("risk-analyst", "리스크 분석가", "둘"),
      said("general-assistant", "일상 비서", "셋"),
      said(null, "김기범", "넷"),
    ];
    expect(linesSince(lines, "risk-analyst").map((line) => line.text)).toEqual([
      "셋",
      "넷",
    ]);
  });

  test("everything, for a Bot that has not spoken here yet", () => {
    const lines = [
      said(null, "김기범", "하나"),
      said("knowledge", "지식", "둘"),
    ];
    expect(linesSince(lines, "risk-analyst")).toHaveLength(2);
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

describe("how a Bot is told to behave in a room", () => {
  test("says silence is a move and that only the tool reaches the room", () => {
    const conduct = roomConduct(risk);
    expect(conduct).toContain("Stay fully in character as 리스크 분석가");
    expect(conduct).toContain("send_message");
    expect(conduct).toContain("Staying silent is a first-class move");
  });
});
