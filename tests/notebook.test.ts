import { describe, expect, test } from "bun:test";
import {
  carriedLines,
  carryOrder,
  drawnLine,
  MEMORY_CHARACTER_CAP,
  type NotebookLine,
} from "../shared/notebook";

const line = (
  id: string,
  content: string,
  extra: Partial<NotebookLine> = {},
): NotebookLine => ({
  id,
  content,
  slot: null,
  source: "bot",
  confirmed: false,
  createdAt: new Date(`2026-09-2${id.length % 9}T00:00:00Z`),
  ...extra,
});

describe("which lines reach the prompt", () => {
  test("the shop's lines, then the owner's, then the Bot's — each oldest first", () => {
    const at = (day: number) => new Date(`2026-09-${10 + day}T00:00:00Z`);
    const ordered = carryOrder([
      line("b1", "택배는 우체국을 쓴다.", { createdAt: at(1) }),
      line("o1", "단골은 김 사장님이다.", {
        source: "owner",
        confirmed: true,
        createdAt: at(2),
      }),
      line("s1", "평일 10시~21시", {
        source: "owner",
        confirmed: true,
        slot: "hours",
        createdAt: at(3),
      }),
      line("b0", "월요일은 쉰다.", { createdAt: at(0) }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["s1", "o1", "b0", "b1"]);
    expect(drawnLine(ordered[0] as NotebookLine)).toBe(
      "영업시간: 평일 10시~21시",
    );
  });

  test("bounded by characters, not by a count; past the cap nothing after is carried", () => {
    const many = Array.from({ length: 200 }, (_, at) =>
      line(`m${String(at).padStart(3, "0")}`, `손님 ${at}`),
    );
    expect(carriedLines(many).carried).toHaveLength(200);

    const over = [
      line("a", "가".repeat(MEMORY_CHARACTER_CAP - 10)),
      line("b", "나".repeat(20)),
      line("c", "다"),
    ];
    const { carried, used, cap } = carriedLines(over);
    expect(carried.map((entry) => entry.id)).toEqual(["a"]);
    expect(used).toBe(MEMORY_CHARACTER_CAP + 11);
    expect(cap).toBe(MEMORY_CHARACTER_CAP);
  });
});
