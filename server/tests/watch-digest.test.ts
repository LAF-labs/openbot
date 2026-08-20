import { describe, expect, test } from "bun:test";
import { buildDigest, digestDue, lockScreenLine } from "../src/watch/digest";

const at = (iso: string) => new Date(iso);

describe("buildDigest", () => {
  test("a failing signal leads the card", () => {
    const digest = buildDigest({
      dateLabel: "8/21",
      sources: [
        {
          name: "kreview",
          signals: [
            { key: "batch.settlement", status: "fail", detail: "3시간 침묵" },
            { key: "db.reachable", status: "ok" },
          ],
          lastError: null,
        },
      ],
      events: [],
      runs: [],
    });
    expect(digest.quiet).toBe(false);
    expect(digest.body).toContain("지금 막혀 있는 것");
    expect(digest.body).toContain("batch.settlement — 3시간 침묵");
  });

  test("a flap collapses to one chained line, not two alarms", () => {
    const digest = buildDigest({
      dateLabel: "8/21",
      sources: [],
      events: [
        {
          sourceName: "kreview",
          key: "db.reachable",
          prevStatus: "ok",
          nextStatus: "fail",
          detail: null,
          observedAt: at("2026-08-20T02:14:00Z"),
        },
        {
          sourceName: "kreview",
          key: "db.reachable",
          prevStatus: "fail",
          nextStatus: "ok",
          detail: null,
          observedAt: at("2026-08-20T02:31:00Z"),
        },
      ],
      runs: [],
    });
    const lines = digest.body
      .split("\n")
      .filter((line) => line.includes("db.reachable"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ok > fail > ok");
    expect(lines[0]).toContain("전이 2회");
  });

  test("runs still marked running are named as crash suspects", () => {
    const digest = buildDigest({
      dateLabel: "8/21",
      sources: [],
      events: [],
      runs: [
        {
          status: "running",
          agentId: "risk-analyst",
          startedAt: at("2026-08-20T01:00:00Z"),
          error: null,
        },
      ],
    });
    expect(digest.body).toContain("결말 없는 런 1건");
    expect(digest.quiet).toBe(false);
  });

  test("a quiet day still produces a card that says so", () => {
    const digest = buildDigest({
      dateLabel: "8/21",
      sources: [
        {
          name: "kreview",
          signals: [{ key: "db.reachable", status: "ok" }],
          lastError: null,
        },
      ],
      events: [],
      runs: [],
    });
    expect(digest.quiet).toBe(true);
    expect(digest.headline).toContain("조용했습니다");
    expect(digest.body).toContain("조용했습니다");
  });
});

describe("digestDue", () => {
  // 00:30Z = 09:30 KST.
  const kst930 = new Date("2026-08-20T00:30:00Z");
  // 22:00Z the day before = 07:00 KST on the 20th.
  const kst700 = new Date("2026-08-19T22:00:00Z");

  test("due after the hour, for today's date in the timezone", () => {
    expect(digestDue(kst930, "Asia/Seoul", 8, null)).toBe("2026-08-20");
  });

  test("not due before the hour", () => {
    expect(digestDue(kst700, "Asia/Seoul", 8, null)).toBeNull();
  });

  test("never sends twice for the same date", () => {
    expect(digestDue(kst930, "Asia/Seoul", 8, "2026-08-20")).toBeNull();
  });

  test("a missed morning is caught up the same day, yesterday never", () => {
    const kst2330 = new Date("2026-08-20T14:30:00Z");
    expect(digestDue(kst2330, "Asia/Seoul", 8, "2026-08-19")).toBe(
      "2026-08-20",
    );
  });
});

describe("lockScreenLine", () => {
  test("flattens newlines and code fences", () => {
    expect(lockScreenLine("a\nb\n```\ncode\n```\nc")).toBe("a b c");
  });
});
