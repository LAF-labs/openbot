/**
 * 오늘's pure parts: the person's day, the chat label, and a browsing turn folded into one row.
 *
 * The reads against real tables are `agents-day.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { foldTurns, zonedDayOf } from "../src/agents/day";
import {
  CHAT_LABEL_LENGTH,
  chatLabelOf,
  headOf,
} from "../src/runner/run-ledger";

describe("the person's day", () => {
  test("23:59 and 00:01 in Seoul are two days, on a VM that keeps UTC", () => {
    const before = zonedDayOf(new Date("2026-09-24T14:59:00Z"), "Asia/Seoul");
    const after = zonedDayOf(new Date("2026-09-24T15:01:00Z"), "Asia/Seoul");
    expect(before.day).toBe("2026-09-24");
    expect(after.day).toBe("2026-09-25");
    expect(after.start.toISOString()).toBe("2026-09-24T15:00:00.000Z");
    expect(after.end.toISOString()).toBe("2026-09-25T15:00:00.000Z");
    expect(before.end.getTime()).toBe(after.start.getTime());
  });

  test("a day the clocks change on is as long as the wall clock says", () => {
    // New York springs forward on 2026-03-08: that day is 23 hours.
    const spring = zonedDayOf(
      new Date("2026-03-08T18:00:00Z"),
      "America/New_York",
    );
    expect(spring.day).toBe("2026-03-08");
    expect(spring.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(spring.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  test("UTC is its own day", () => {
    const day = zonedDayOf(new Date("2026-09-25T00:00:00Z"), "UTC");
    expect(day.day).toBe("2026-09-25");
    expect(day.start.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });
});

describe("a chat run's label", () => {
  test("the person's words, cut at forty code points", () => {
    const long = "가".repeat(60);
    const label = chatLabelOf([{ role: "user", content: long }]);
    expect(label).toBe("가".repeat(CHAT_LABEL_LENGTH));
  });

  test("never splits an emoji, even one made of several code points", () => {
    // Four code points joined into one family, then a flag of two: the cut must not land inside.
    const family = "👨‍👩‍👧"; // 5 code points
    const words = `${"a".repeat(37)}${family}`;
    const cut = headOf(words, 40);
    expect(cut).toBe("a".repeat(37));
    expect([...(headOf(`${"a".repeat(35)}${family}`, 40) ?? "")].length).toBe(
      40,
    );
    const flags = headOf(`${"b".repeat(39)}🇰🇷`, 40);
    expect(flags).toBe("b".repeat(39));
  });

  test("one line, from text parts too", () => {
    expect(
      chatLabelOf([
        {
          role: "user",
          content: [
            { type: "text", text: "오늘 주문\n\n  확인해 줘" },
            { type: "binary", data: "…" },
          ],
        },
      ]),
    ).toBe("오늘 주문 확인해 줘");
  });

  test("a browser step coming back has no words of its own", () => {
    expect(
      chatLabelOf([
        { role: "user", content: "찾아 줘" },
        { role: "assistant", content: "" },
        { role: "tool", content: "{}" },
      ]),
    ).toBeNull();
    expect(chatLabelOf([{ role: "user", content: "   " }])).toBeNull();
    expect(chatLabelOf([])).toBeNull();
  });
});

describe("a browsing turn is one row", () => {
  const run = (
    runId: string,
    label: string | null,
    minute: number,
    threadId = "t1",
  ) => ({
    runId,
    threadId,
    origin: "chat",
    label,
    status: "done" as const,
    startedAt: new Date(Date.UTC(2026, 8, 25, 1, minute)),
  });

  test("steps fold into the turn the person started, per thread", () => {
    const turns = foldTurns([
      run("a", "예스24에서 찾아 줘", 0),
      run("a2", null, 1),
      run("a3", null, 2),
      run("b", "고마워", 3),
      run("b2", null, 4),
    ]);
    expect(turns.map((turn) => turn.head.runId)).toEqual(["a", "b"]);
    expect(turns[0]?.runs.map((one) => one.runId)).toEqual(["a", "a2", "a3"]);
    expect(turns[1]?.runs.map((one) => one.runId)).toEqual(["b", "b2"]);
  });

  test("a step carried over midnight stands on its own rather than vanishing", () => {
    const turns = foldTurns([run("x", null, 0), run("y", "안녕", 1)]);
    expect(turns.map((turn) => turn.head.runId)).toEqual(["x", "y"]);
    expect(turns[0]?.head.label).toBeNull();
  });
});
